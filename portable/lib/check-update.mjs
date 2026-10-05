// 自动更新检查（轻量版）
//
// 流程：
//   1. 读取 OPENCLAW_VERSION 文件得到当前版本号
//   2. 5s timeout 拉 OSS 上的 latest.json
//   3. 比对版本号，有新版就写 update-available.json 到 STATE_DIR
//   4. config-server 的 GET /api/update-status 读这个文件并原样返回（桌面壳据此显示提示）
//
// 设计原则：
//   - 静默失败：网络坏、OSS 挂、json 格式错、本地版本号缺失，都不能影响 OpenClaw 启动
//   - 只读不下载：检查到新版只写 update-available.json，下载交给用户点链接到浏览器去做
//   - 异步：调用方应该 detach 跑（Windows-Start.bat 用 start /B），不阻塞主流程
//
// latest.json 格式（你在 OSS 上手动维护或用 publish-latest.mjs 生成）：
// {
//   "version": "2026.4.30",
//   "releaseDate": "2026-05-03",
//   "downloadUrl": "https://u-claw-oss.56chat.cn/u-claw-open/u-claw-portable-v2026.4.30.zip",
//   "releasePageUrl": "https://github.com/dongsheng123132/u-claw/releases/tag/v2026.4.30",
//   "notes": "修复 xxx，新增 yyy"
// }

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_MANIFEST_URL = process.env.UCLAW_UPDATE_MANIFEST_URL
  || 'https://u-claw-oss.56chat.cn/u-claw-open/latest.json';

const DEFAULT_TIMEOUT_MS = 5000;

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

// 简单语义比较：把 "2026.4.30" 拆成 [2026, 4, 30] 后逐位比
// 不是 semver 但够用。返回 -1/0/1（remote 相对 local）
function compareVersions(local, remote) {
  if (!local || !remote) return 0;
  const a = String(local).split('.').map((s) => parseInt(s, 10) || 0);
  const b = String(remote).split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    if (bi > ai) return 1;
    if (bi < ai) return -1;
  }
  return 0;
}

async function fetchLatest(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // 加随机参数避开 OSS / CDN 缓存
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function writeUpdateInfo(stateDir, payload) {
  const filePath = resolve(stateDir, 'update-available.json');
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return filePath;
  } catch (err) {
    log('error', `cannot write update-available.json: ${err.message}`);
    return null;
  }
}

function clearUpdateInfo(stateDir) {
  const filePath = resolve(stateDir, 'update-available.json');
  try {
    if (existsSync(filePath)) {
      writeFileSync(filePath, JSON.stringify({ available: false, checkedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    }
  } catch {
    // 静默
  }
}

export async function checkUpdate({
  versionFilePath,
  stateDir,
  manifestUrl = DEFAULT_MANIFEST_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!versionFilePath || !stateDir) {
    return { ok: false, reason: 'missing-paths' };
  }

  const localVersion = readVersionFile(versionFilePath);
  if (!localVersion) {
    log('error', 'local OPENCLAW_VERSION not found, skip');
    return { ok: false, reason: 'no-local-version' };
  }

  let remote;
  try {
    remote = await fetchLatest(manifestUrl, timeoutMs);
  } catch (err) {
    // 静默失败 — 网络坏不能影响用户用 U-Claw
    log('error', `fetch ${manifestUrl} failed: ${err.message}`);
    return { ok: false, reason: 'fetch-failed', error: err.message };
  }

  if (!remote || typeof remote !== 'object' || !remote.version) {
    log('error', 'remote manifest invalid (missing version)');
    return { ok: false, reason: 'invalid-manifest' };
  }

  const cmp = compareVersions(localVersion, remote.version);
  if (cmp <= 0) {
    // 已是最新或更新（开发版可能比线上还新）
    clearUpdateInfo(stateDir);
    log('info', `up to date (local=${localVersion}, remote=${remote.version})`);
    return { ok: true, available: false, localVersion, remoteVersion: remote.version };
  }

  // 有新版
  const payload = {
    available: true,
    checkedAt: new Date().toISOString(),
    localVersion,
    remoteVersion: remote.version,
    releaseDate: remote.releaseDate || null,
    downloadUrl: remote.downloadUrl || null,
    releasePageUrl: remote.releasePageUrl || null,
    notes: remote.notes || null,
  };
  const filePath = writeUpdateInfo(stateDir, payload);
  log('info', `new version available: ${remote.version} (local=${localVersion})`);
  return { ok: true, available: true, ...payload, filePath };
}

// CLI:
//   node check-update.mjs <version-file> <state-dir> [manifest-url]
//   env UCLAW_VERSION_FILE / UCLAW_STATE_DIR / UCLAW_UPDATE_MANIFEST_URL
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
      // 退出码：0=正常（无论是否有新版），1=失败但已记录
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`check-update fatal: ${err.message}\n`);
      process.exit(1);
    });
}
