// 自动更新检查（通道版）
//
// 流程：
//   1. 读取 OPENCLAW_VERSION 文件得到当前版本号
//   2. 解析更新通道：UCLAW_UPDATE_CHANNEL > <stateDir>/update-channel.json > 默认 stable
//   3. 拉通道最新版：npm dist-tags（stable→latest / extended-stable→extended-stable，走 npmmirror）
//   4. 与本地 OPENCLAW_VERSION 做数字段比较，有新版才写 update-available.json 到 STATE_DIR
//   5. 尽量再拉一次 OSS latest.json，只是为了把下载链接/更新说明补进 payload
//      （拿不到不影响结论：新版判定以"通道最新版"为准）
//   6. Welcome.html / Config.html（经 config-server /api/update-status）启动时读这个文件，有就显示提示条
//
// 设计原则：
//   - 静默失败：网络坏、registry/OSS 挂、json 格式错、本地版本号缺失，都不能影响 OpenClaw 启动
//   - 无网络也算"检查完成"：CLI 退出码 0（旧版网络失败退 1，启动脚本虽忽略退出码，但这属于误报故障）
//   - 只读不下载：检查到新版只写 update-available.json，下载交给用户点链接到浏览器去做
//   - 异步：调用方应该 detach 跑（Windows-Start.bat 用 start /B），不阻塞主流程
//
// update-available.json 契约（有新版时）：
// {
//   "available": true,
//   "checkedAt": "<ISO 时间>",
//   "channel": "stable" | "extended-stable",   // 新增字段
//   "localVersion": "2026.10.9",               // 本机已装（旧字段名，保持不变）
//   "remoteVersion": "2026.10.10",             // 目标通道最新（旧字段名，保持不变）
//   "releaseDate": "2026-11-01" | null,
//   "downloadUrl": "https://..." | null,
//   "releasePageUrl": "https://..." | null,
//   "notes": "..." | null
// }
// 无新版时若文件已存在会被改写成：
// { "available": false, "checkedAt": "<ISO>", "channel": "...", "localVersion": "..." }
//
// OSS latest.json 格式（你在 OSS 上手动维护或用 publish-latest.mjs 生成）：
// {
//   "version": "2026.4.30",
//   "releaseDate": "2026-05-03",
//   "downloadUrl": "https://u-claw-oss.56chat.cn/u-claw-open/u-claw-portable-v2026.4.30.zip",
//   "releasePageUrl": "https://github.com/dongsheng123132/u-claw/releases/tag/v2026.4.30",
//   "notes": "修复 xxx，新增 yyy"
// }
//
// 注意：只有当 latest.json 的 version == 通道最新版时，下载链接/说明才会被采用；
// 否则留 null——避免"提示有新版本，但点下载拿到的是别的版本"这种误导。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compareVersions,
  DEFAULT_CHANNEL,
  DEFAULT_TIMEOUT_MS,
  getChannelVersion,
  normalizeChannel,
  resolveChannel,
} from './update-channel.mjs';

const DEFAULT_MANIFEST_URL = process.env.UCLAW_UPDATE_MANIFEST_URL
  || 'https://u-claw-oss.56chat.cn/u-claw-open/latest.json';

function log(level, msg) {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`[check-update] ${msg}\n`);
}

function readVersionFile(versionFilePath) {
  try {
    if (!existsSync(versionFilePath)) return null;
    const raw = readFileSync(versionFilePath, 'utf8').trim();
    return raw || null;
  } catch (err) {
    log('error', `cannot read ${versionFilePath}: ${err.message}`);
    return null;
  }
}

async function fetchManifest(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      // 加随机参数避开 OSS / CDN 缓存
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res || typeof res !== 'object') throw new Error('empty response');
    if (res.ok === false) throw new Error(`HTTP ${res.status || 'error'}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉 OSS manifest 作"下载链接来源"。失败只记日志，不改变新版判定。
 * @returns {Promise<{ manifest: object|null, version: string|null, error: string|null }>}
 */
async function fetchManifestSafe(manifestUrl, timeoutMs, fetchImpl) {
  try {
    const manifest = await fetchManifest(manifestUrl, timeoutMs, fetchImpl);
    if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string' || !manifest.version.trim()) {
      log('error', 'remote manifest invalid (missing version)');
      return { manifest: null, version: null, error: 'invalid-manifest' };
    }
    return { manifest, version: manifest.version.trim(), error: null };
  } catch (err) {
    // 静默失败 — 网络坏不能影响用户用 U-Claw
    log('error', `fetch ${manifestUrl} failed: ${err.message}`);
    return { manifest: null, version: null, error: err.message };
  }
}

function updateInfoPath(stateDir) {
  return resolve(stateDir, 'update-available.json');
}

function writeUpdateInfo(stateDir, payload) {
  const filePath = updateInfoPath(stateDir);
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return filePath;
  } catch (err) {
    log('error', `cannot write update-available.json: ${err.message}`);
    return null;
  }
}

function clearUpdateInfo(stateDir, { channel, localVersion } = {}) {
  const filePath = updateInfoPath(stateDir);
  try {
    // 只覆盖已存在的文件：没检查到新版时不制造无意义的文件，保持旧行为。
    if (existsSync(filePath)) {
      const payload = {
        available: false,
        checkedAt: new Date().toISOString(),
        channel: channel || DEFAULT_CHANNEL,
        localVersion: localVersion || null,
      };
      writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    }
  } catch {
    // 静默
  }
}

/**
 * 检查更新（静默失败，绝不 throw——除调用方传错路径参数外都返回结果对象）。
 *
 * @param {object} [options]
 * @param {string} options.versionFilePath 本地 OPENCLAW_VERSION 路径
 * @param {string} options.stateDir        <portable>/data/.openclaw
 * @param {string} [options.manifestUrl]   OSS latest.json
 * @param {number} [options.timeoutMs]     单次网络请求超时（默认 5000）
 * @param {string} [options.channel]       显式指定通道（优先于 env/stateDir 文件；非法值忽略）
 * @param {Record<string, string>} [options.env] 注入环境变量（默认 process.env，测试用）
 * @param {Function} [options.fetchImpl]   注入 fetch（默认全局 fetch，测试用）
 */
export async function checkUpdate({
  versionFilePath,
  stateDir,
  manifestUrl = DEFAULT_MANIFEST_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  channel,
  env = process.env,
  fetchImpl,
} = {}) {
  const explicitChannel = normalizeChannel(channel);
  const resolvedChannel = explicitChannel || resolveChannel({ env, stateDir });

  if (!versionFilePath || !stateDir) {
    return { ok: false, reason: 'missing-paths', channel: resolvedChannel };
  }

  const localVersion = readVersionFile(versionFilePath);
  if (!localVersion) {
    log('error', 'local OPENCLAW_VERSION not found, skip');
    return { ok: false, reason: 'no-local-version', channel: resolvedChannel };
  }

  // 两个来源并行：registry（判定通道最新版） + OSS manifest（只取下载链接）
  const [channelResult, manifestResult] = await Promise.all([
    getChannelVersion(resolvedChannel, { fetchImpl, timeoutMs }),
    fetchManifestSafe(manifestUrl, timeoutMs, fetchImpl),
  ]);

  // 新版判定以"通道最新版"为准；registry 不可达时退回旧的 manifest 版本，保持旧行为可用
  let remoteVersion = null;
  let versionSource = null;
  if (channelResult.ok && channelResult.version) {
    remoteVersion = channelResult.version;
    versionSource = 'channel';
  } else if (manifestResult.version) {
    remoteVersion = manifestResult.version;
    versionSource = 'manifest';
  }

  if (!remoteVersion) {
    const error = [channelResult.error, manifestResult.error].filter(Boolean).join('; ') || 'no remote version';
    log('error', `no remote version available: ${error}`);
    return { ok: false, reason: 'no-remote-version', channel: resolvedChannel, error };
  }

  log('info', `channel=${resolvedChannel} remote=${remoteVersion} (source=${versionSource}) local=${localVersion}`);

  // compareVersions(a, b)：a<b → -1（本地旧，有更新）、相等 0、a>b → 1（本地更新/通道更旧）
  const cmp = compareVersions(localVersion, remoteVersion);
  if (cmp >= 0) {
    // 已是最新或更新（开发版可能比线上还新；conservative 通道也可能比本地旧）
    clearUpdateInfo(stateDir, { channel: resolvedChannel, localVersion });
    log('info', `up to date (local=${localVersion}, remote=${remoteVersion})`);
    return {
      ok: true,
      available: false,
      channel: resolvedChannel,
      localVersion,
      remoteVersion,
      versionSource,
    };
  }

  // 有新版。下载链接只认"与通道最新版同一版本"的 OSS manifest，避免链接指向别的版本。
  const manifest = manifestResult.manifest;
  const manifestMatches = !!manifest && manifest.version === remoteVersion;
  const payload = {
    available: true,
    checkedAt: new Date().toISOString(),
    channel: resolvedChannel,
    localVersion,
    remoteVersion,
    releaseDate: manifestMatches ? (manifest.releaseDate || null) : null,
    downloadUrl: manifestMatches ? (manifest.downloadUrl || null) : null,
    releasePageUrl: manifestMatches ? (manifest.releasePageUrl || null) : null,
    notes: manifestMatches ? (manifest.notes || null) : null,
  };
  const filePath = writeUpdateInfo(stateDir, payload);
  log('info', `new version available: ${remoteVersion} (channel=${resolvedChannel}, local=${localVersion})`);
  return { ok: true, ...payload, versionSource, filePath };
}

// CLI:
//   node check-update.mjs <version-file> <state-dir> [manifest-url]
//   env UCLAW_VERSION_FILE / UCLAW_STATE_DIR / UCLAW_UPDATE_MANIFEST_URL / UCLAW_UPDATE_CHANNEL
//   （UCLAW_UPDATE_CHANNEL=stable|extended-stable，也可以用 <state-dir>/update-channel.json 的 {channel}）
import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const versionFilePath = process.argv[2] || process.env.UCLAW_VERSION_FILE;
  const stateDir = process.argv[3] || process.env.UCLAW_STATE_DIR;
  const manifestUrl = process.argv[4] || process.env.UCLAW_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL;

  if (!versionFilePath || !stateDir) {
    process.stderr.write('Usage: node check-update.mjs <version-file> <state-dir> [manifest-url]\n');
    process.exit(2);
  }

  checkUpdate({ versionFilePath, stateDir, manifestUrl })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      // 退出码：0=检查已完成（无论是否有新版、也无论网络是否可用——静默失败）；
      //         2=用法错误（上面已处理）；1=进程自身异常（理论上不该发生）。
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`check-update fatal: ${err.message}\n`);
      process.exit(1);
    });
}
