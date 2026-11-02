// 回归测试：U-Claw 更新通道（stable / extended-stable）
//
// 背景（要回归的坑）：
//   1. Upstream 是**日期式版本号**（2026.10.9 vs 2026.9.36）。字符串比较会得到
//      '2026.10.9' < '2026.9.36'，保守通道会误报"已是最新"，客户机永远收不到更新。
//   2. 客户机要"保守通道"：extended-stable 线的版本可能**低于**本机已装版本
//      （例如本机 2026.10.9，LTS 线 2026.9.36），此时不能提示"有新版本"、更不能降级。
//   3. 检查更新必须静默失败：网络坏 / registry 挂 / OSS 挂 / JSON 坏，都不能抛异常，
//      CLI 也必须退出 0（否则启动脚本容易把它误判成故障）。
//   4. update-available.json 是对外契约：保留旧字段（available/checkedAt/localVersion/
//      remoteVersion/releaseDate/downloadUrl/releasePageUrl/notes），只新增 channel。
//
// 这里全部用注入 fetchImpl / 临时目录，不联网（唯一的 CLI 子进程测试打 127.0.0.1:1，立即拒绝）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CHANNEL_DIST_TAGS,
  CHANNEL_EXTENDED_STABLE,
  CHANNEL_BETA,
  CHANNEL_STABLE,
  CHANNELS,
  DEFAULT_CHANNEL,
  DEFAULT_REGISTRY_URL,
  UPDATE_CHANNEL_ENV,
  UPDATE_CHANNEL_STATE_FILE,
  channelToDistTag,
  compareVersions,
  getChannelVersion,
  normalizeChannel,
  resolveChannel,
} from '../portable/lib/update-channel.mjs';
import { checkUpdate } from '../portable/lib/check-update.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ── 测试辅助 ──────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-update-channel-test-'));
  try {
    return await fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function writeVersionFile(dir, version) {
  const file = join(dir, 'OPENCLAW_VERSION');
  writeFileSync(file, `${version}\n`, 'utf8');
  return file;
}

function writeChannelFile(stateDir, content) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, UPDATE_CHANNEL_STATE_FILE), content, 'utf8');
}

function stateDirOf(dir) {
  const stateDir = join(dir, 'state');
  return stateDir;
}

const REGISTRY_TAGS = { latest: '2026.10.9', 'extended-stable': '2026.9.36', beta: '2026.10.10-beta.5' };
const MANIFEST = {
  version: '2026.10.9',
  releaseDate: '2026-10-30',
  downloadUrl: 'https://u-claw-oss.example/u-claw-portable-windows-v2.3.9.zip',
  releasePageUrl: 'https://github.com/dongsheng123132/u-claw/releases/tag/v2.3.9',
  notes: '修复若干问题',
};

/**
 * 按 URL 路由的假 fetch：
 *   - .../latest.json         → manifest
 *   - 其它（registry）        → { 'dist-tags': registry }
 * 可模拟 registry/manifest 抛错、registry 挂起不返回（测超时）。
 */
function makeFetch({ registry = REGISTRY_TAGS, manifest = MANIFEST, registryError = null, manifestError = null, hangRegistry = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.includes('latest.json')) {
      if (manifestError) throw new Error(manifestError);
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (registryError) throw new Error(registryError);
    if (hangRegistry) {
      // 模拟"服务端不响应"：只有 AbortController 的信号能让它 reject
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) return; // 没有 signal 就永远挂住，测试会超时暴露问题
        if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return { ok: true, status: 200, json: async () => ({ 'dist-tags': registry }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ── resolveChannel：优先级 + 回落 ─────────────────────────────────────────────

test('resolveChannel: 什么都没配 → 默认 stable（保守通道不改变老客户机行为）', () => {
  assert.equal(DEFAULT_CHANNEL, CHANNEL_STABLE);
  assert.equal(resolveChannel({ env: {} }), CHANNEL_STABLE);
  assert.equal(resolveChannel({ env: {}, stateDir: join(tmpdir(), 'definitely-missing-uclaw-state') }), CHANNEL_STABLE);
});

test('resolveChannel: 环境变量 UCLAW_UPDATE_CHANNEL 优先', () => {
  assert.equal(UPDATE_CHANNEL_ENV, 'UCLAW_UPDATE_CHANNEL');
  assert.equal(resolveChannel({ env: { UCLAW_UPDATE_CHANNEL: 'extended-stable' } }), CHANNEL_EXTENDED_STABLE);
  assert.equal(resolveChannel({ env: { UCLAW_UPDATE_CHANNEL: 'stable' } }), CHANNEL_STABLE);
});

test('resolveChannel: env 优先于 stateDir/update-channel.json', async () => {
  await withTempDir(async (dir) => {
    writeChannelFile(dir, JSON.stringify({ channel: 'extended-stable' }));
    assert.equal(resolveChannel({ env: { UCLAW_UPDATE_CHANNEL: 'stable' }, stateDir: dir }), CHANNEL_STABLE);
    // env 空白等同于未设置 → 读到文件
    assert.equal(resolveChannel({ env: { UCLAW_UPDATE_CHANNEL: '   ' }, stateDir: dir }), CHANNEL_EXTENDED_STABLE);
  });
});

test('resolveChannel: env 值非法 → 回落 stable（不猜别名、不抛）', async () => {
  await withTempDir(async (dir) => {
    writeChannelFile(dir, JSON.stringify({ channel: 'extended-stable' }));
    for (const bad of ['nonsense', 'extended', 'conservative', '0']) {
      assert.equal(resolveChannel({ env: { UCLAW_UPDATE_CHANNEL: bad }, stateDir: dir }), CHANNEL_STABLE, `bad env=${JSON.stringify(bad)}`);
    }
    // 带空白是合法值（trim 后归一），按显式意图生效
    assert.equal(resolveChannel({ env: { UCLAW_UPDATE_CHANNEL: ' stable ' }, stateDir: dir }), CHANNEL_STABLE);
  });
});

test('resolveChannel: 允许大小写/空白，只认正式通道名（stable / extended-stable / beta）', () => {
  assert.equal(normalizeChannel(' Extended-Stable '), CHANNEL_EXTENDED_STABLE);
  assert.equal(normalizeChannel('STABLE'), CHANNEL_STABLE);
  assert.equal(normalizeChannel('Beta'), CHANNEL_BETA);
  assert.equal(normalizeChannel(''), null);
  assert.equal(normalizeChannel(null), null);
  assert.equal(normalizeChannel(42), null);
});

test('resolveChannel: 读 stateDir/update-channel.json 的 { channel }', async () => {
  await withTempDir(async (dir) => {
    writeChannelFile(dir, JSON.stringify({ channel: 'extended-stable' }));
    assert.equal(resolveChannel({ env: {}, stateDir: dir }), CHANNEL_EXTENDED_STABLE);
    assert.equal(resolveChannel({ env: {}, stateDir: dir }), CHANNEL_EXTENDED_STABLE);
  });
});

test('resolveChannel: 坏 JSON / 缺 channel / 非法 channel / stateDir 不存在 都静默回落 stable', async () => {
  await withTempDir(async (dir) => {
    const cases = [
      '{not json',
      JSON.stringify({}),
      JSON.stringify({ channel: '' }),
      JSON.stringify({ channel: 'nightly' }),
      JSON.stringify({ channel: 7 }),
      JSON.stringify(null),
    ];
    for (const content of cases) {
      writeChannelFile(dir, content);
      assert.equal(resolveChannel({ env: {}, stateDir: dir }), CHANNEL_STABLE, `content=${content}`);
    }
    // stateDir 是个文件（ENOTDIR）也不能抛
    const notADir = join(dir, 'plain-file');
    writeFileSync(notADir, 'x');
    assert.equal(resolveChannel({ env: {}, stateDir: notADir }), CHANNEL_STABLE);
    assert.equal(resolveChannel({ env: {}, stateDir: null }), CHANNEL_STABLE);
  });
});

test('channelToDistTag: stable→latest，extended-stable→extended-stable，beta→beta（非法值按 stable）', () => {
  assert.deepEqual({ ...CHANNEL_DIST_TAGS }, { stable: 'latest', 'extended-stable': 'extended-stable', beta: 'beta' });
  assert.equal(channelToDistTag('stable'), 'latest');
  assert.equal(channelToDistTag('extended-stable'), 'extended-stable');
  assert.equal(channelToDistTag('beta'), 'beta');
  assert.equal(channelToDistTag('bogus'), 'latest');
  assert.deepEqual([...CHANNELS], ['stable', 'extended-stable', 'beta']);
});

// ── compareVersions：日期式版本按数字段比 ────────────────────────────────────

test('compareVersions: 日期式版本按数字段比——2026.10.9 > 2026.9.36（字符串比较会翻车）', () => {
  assert.equal(compareVersions('2026.9.36', '2026.10.9'), -1);
  assert.equal(compareVersions('2026.10.9', '2026.9.36'), 1);
  assert.equal(compareVersions('2026.10.9', '2026.10.9'), 0);
  assert.equal(compareVersions('2026.9.99', '2026.10.0'), -1);
  assert.equal(compareVersions('2026.10.9', '2026.9.99'), 1, '9 > 10 是字符串比较的结论，数字段比较不认');
});

test('compareVersions: 容忍 v 前缀（v2026.10.9）', () => {
  assert.equal(compareVersions('v2026.10.9', '2026.10.9'), 0);
  assert.equal(compareVersions('V2026.9.36', '2026.10.9'), -1);
  assert.equal(compareVersions('2026.9.36', 'v2026.10.9'), -1);
});

test('compareVersions: 段数不同按 0 补齐', () => {
  assert.equal(compareVersions('2026.10', '2026.10.0'), 0);
  assert.equal(compareVersions('2026.10.1', '2026.10'), 1);
  assert.equal(compareVersions('2026', '2026.0.1'), -1);
  assert.equal(compareVersions('2026.10.9', '2026.10.9.0'), 0);
});

test('compareVersions: 预发布后缀按 semver 语义（同版本号时带后缀的更小）', () => {
  assert.equal(compareVersions('2026.10.10-beta.5', '2026.10.10'), -1);
  assert.equal(compareVersions('2026.10.10', '2026.10.10-beta.5'), 1);
  assert.equal(compareVersions('2026.10.10-beta.5', '2026.10.9'), 1, '版本号大就是大，预发布后缀不影响主版本比较');
  assert.equal(compareVersions('2026.10.10-beta.5', '2026.10.10-beta.10'), -1, 'beta.10 > beta.5（数字段）');
});

test('compareVersions: 无法解析的入参返回 0（不抛，宁可不报更新也不误报）', () => {
  for (const [a, b] of [[null, '2026.10.9'], ['2026.10.9', null], ['abc', '2026.1.1'], ['', ''], [undefined, 'v1']]) {
    assert.equal(compareVersions(a, b), 0, `${a} vs ${b}`);
  }
});

// ── getChannelVersion：注入 fetch 的成功/超时/异常 ───────────────────────────

test('getChannelVersion: stable 取 dist-tags.latest，带超时信号和小体积 Accept 头', async () => {
  const fetchImpl = makeFetch();
  const res = await getChannelVersion('stable', { fetchImpl, timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.version, '2026.10.9');
  assert.equal(res.channel, 'stable');
  assert.equal(res.error, undefined);
  assert.match(res.checkedAt, ISO_RE);

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, DEFAULT_REGISTRY_URL);
  assert.equal(DEFAULT_REGISTRY_URL, 'https://registry.npmmirror.com/openclaw');
  // 完整 packument ~21MB；这个头把响应缩到 ~1MB，删了客户机每次检查要烧 21MB
  assert.match(String(fetchImpl.calls[0].init.headers.accept), /application\/vnd\.npm\.install-v1\+json/);
  assert.ok(fetchImpl.calls[0].init.signal, '必须传 AbortSignal 才能硬超时');
});

test('getChannelVersion: extended-stable 取 dist-tags["extended-stable"]', async () => {
  const fetchImpl = makeFetch();
  const res = await getChannelVersion('extended-stable', { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.version, '2026.9.36');
  assert.equal(res.channel, 'extended-stable');
});

test('getChannelVersion: 非法通道按 stable 处理（与 resolveChannel 的回落一致）', async () => {
  const fetchImpl = makeFetch();
  const res = await getChannelVersion('nonsense', { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'stable');
  assert.equal(res.version, '2026.10.9');
});

test('getChannelVersion: HTTP / 异常 / 坏 JSON / 缺 dist-tag 都返回 ok:false，不抛', async () => {
  const http500 = await getChannelVersion('stable', {
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(http500.ok, false);
  assert.equal(http500.version, null);
  assert.match(String(http500.error), /HTTP 500/);
  assert.match(http500.checkedAt, ISO_RE);

  const thrown = await getChannelVersion('stable', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(thrown.ok, false);
  assert.match(String(thrown.error), /ECONNREFUSED/);

  const badJson = await getChannelVersion('stable', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } }),
  });
  assert.equal(badJson.ok, false);
  assert.match(String(badJson.error), /invalid JSON/);

  const noTag = await getChannelVersion('extended-stable', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '2026.10.9' } }) }),
  });
  assert.equal(noTag.ok, false);
  assert.equal(noTag.channel, 'extended-stable');
  assert.match(String(noTag.error), /dist-tag/);

  const noTags = await getChannelVersion('stable', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  assert.equal(noTags.ok, false);
  assert.match(String(noTags.error), /dist-tags/);
});

test('getChannelVersion: 服务端不响应时 AbortController 超时兜底（默认 5000ms，可注入更短）', async () => {
  const fetchImpl = makeFetch({ hangRegistry: true });
  const started = Date.now();
  const res = await getChannelVersion('stable', { fetchImpl, timeoutMs: 30 });
  const elapsed = Date.now() - started;
  assert.equal(res.ok, false);
  assert.equal(res.version, null);
  assert.equal(res.error, 'timeout');
  assert.ok(elapsed < 2000, `超时应该很快返回，实际 ${elapsed}ms`);
});

test('getChannelVersion: registryUrl 可覆盖（换源/内网镜像）', async () => {
  const fetchImpl = makeFetch();
  const res = await getChannelVersion('stable', { fetchImpl, registryUrl: 'https://mirror.example/openclaw' });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls[0].url, 'https://mirror.example/openclaw');
});

// ── update-available.json 契约 ───────────────────────────────────────────────

test('checkUpdate: stable 通道有新版本 → JSON 保留旧字段 + 新增 channel', async () => {
  await withTempDir(async (dir) => {
    const versionFile = writeVersionFile(dir, '2026.9.36');
    const stateDir = stateDirOf(dir);
    const fetchImpl = makeFetch();

    const res = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      manifestUrl: 'https://u-claw-oss.example/latest.json',
      channel: 'stable',
      env: {},
      fetchImpl,
    });

    assert.equal(res.ok, true);
    assert.equal(res.available, true);
    assert.equal(res.channel, 'stable');
    assert.equal(res.versionSource, 'channel');
    assert.equal(res.localVersion, '2026.9.36');
    assert.equal(res.remoteVersion, '2026.10.9');

    const file = join(stateDir, 'update-available.json');
    assert.ok(existsSync(file), '有新版必须写 update-available.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));

    // 字段契约：旧字段一个不少（config-server / 页面可能读），只新增 channel
    assert.deepEqual(Object.keys(saved).sort(), [
      'available',
      'channel',
      'checkedAt',
      'downloadUrl',
      'localVersion',
      'notes',
      'releaseDate',
      'releasePageUrl',
      'remoteVersion',
    ]);
    assert.equal(saved.available, true);
    assert.equal(saved.channel, 'stable');
    assert.equal(saved.localVersion, '2026.9.36');
    assert.equal(saved.remoteVersion, '2026.10.9');
    assert.equal(saved.releaseDate, MANIFEST.releaseDate);
    assert.equal(saved.downloadUrl, MANIFEST.downloadUrl);
    assert.equal(saved.releasePageUrl, MANIFEST.releasePageUrl);
    assert.equal(saved.notes, MANIFEST.notes);
    assert.match(saved.checkedAt, ISO_RE);
  });
});

test('checkUpdate: extended-stable 通道低于本机版本 → 不提示更新、不降级（保守通道核心语义）', async () => {
  await withTempDir(async (dir) => {
    const stateDir = stateDirOf(dir);
    writeChannelFile(stateDir, JSON.stringify({ channel: 'extended-stable' }));
    const versionFile = writeVersionFile(dir, '2026.10.9');
    // 先放一份"有更新"的旧文件，检查后应被改写成 available:false
    writeFileSync(join(stateDir, 'update-available.json'), JSON.stringify({ available: true, localVersion: '2026.9.0' }));

    const res = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      manifestUrl: 'https://u-claw-oss.example/latest.json',
      env: {},
      fetchImpl: makeFetch(),
    });

    assert.equal(res.ok, true);
    assert.equal(res.available, false, 'LTS 线版本比本机低时绝不能报"有新版本"');
    assert.equal(res.channel, 'extended-stable');
    assert.equal(res.remoteVersion, '2026.9.36');

    const saved = JSON.parse(readFileSync(join(stateDir, 'update-available.json'), 'utf8'));
    assert.equal(saved.available, false);
    assert.equal(saved.channel, 'extended-stable');
    assert.equal(saved.localVersion, '2026.10.9');
    assert.match(saved.checkedAt, ISO_RE);
  });
});

test('checkUpdate: 通道从 stateDir/update-channel.json 解析，env 覆盖文件', async () => {
  await withTempDir(async (dir) => {
    const versionFile = writeVersionFile(dir, '2026.9.36');
    const stateDir = stateDirOf(dir);
    writeChannelFile(stateDirOf(dir), JSON.stringify({ channel: 'extended-stable' }));

    const fromFile = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      env: {},
      fetchImpl: makeFetch(),
    });
    assert.equal(fromFile.channel, 'extended-stable');

    const fromEnv = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      env: { UCLAW_UPDATE_CHANNEL: 'stable' },
      fetchImpl: makeFetch(),
    });
    assert.equal(fromEnv.channel, 'stable');
  });
});

test('checkUpdate: registry 不可达但 OSS manifest 可用 → 退回旧行为（仍能发现新版）', async () => {
  await withTempDir(async (dir) => {
    const versionFile = writeVersionFile(dir, '2026.9.36');
    const stateDir = stateDirOf(dir);
    const res = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      env: {},
      fetchImpl: makeFetch({ registryError: 'registry offline' }),
    });

    assert.equal(res.ok, true);
    assert.equal(res.available, true);
    assert.equal(res.versionSource, 'manifest');
    assert.equal(res.remoteVersion, '2026.10.9');
    assert.equal(res.downloadUrl, MANIFEST.downloadUrl, 'manifest 版本与 remote 一致时链接可用');
  });
});

test('checkUpdate: registry 与 OSS 全挂 → ok:false 静默失败，不抛、不写新文件', async () => {
  await withTempDir(async (dir) => {
    const versionFile = writeVersionFile(dir, '2026.9.36');
    const stateDir = stateDirOf(dir);
    const res = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      env: {},
      fetchImpl: makeFetch({ registryError: 'offline', manifestError: 'offline' }),
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-remote-version');
    assert.equal(res.channel, 'stable');
    assert.match(String(res.error), /offline/);
    assert.equal(existsSync(join(stateDir, 'update-available.json')), false, '没结论就别写文件');
  });
});

test('checkUpdate: 本地版本缺失 → ok:false（不联网、不写文件、不抛）', async () => {
  await withTempDir(async (dir) => {
    const res = await checkUpdate({
      versionFilePath: join(dir, 'no-such-version-file'),
      stateDir: join(dir, 'state'),
      env: {},
      fetchImpl: async () => { throw new Error('should not be called'); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-local-version');
  });
});

test('checkUpdate: 通道最新版与 OSS manifest 版本不一致时，下载链接留 null（不给错版本链接）', async () => {
  await withTempDir(async (dir) => {
    const versionFile = writeVersionFile(dir, '2026.9.36');
    const stateDir = stateDirOf(dir);
    const res = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      env: {},
      // registry 已经到 2026.10.10（比 OSS 发布的 2026.10.9 新）
      fetchImpl: makeFetch({
        registry: { latest: '2026.10.10', 'extended-stable': '2026.9.36' },
        manifest: MANIFEST,
      }),
    });

    assert.equal(res.ok, true);
    assert.equal(res.available, true);
    assert.equal(res.remoteVersion, '2026.10.10');
    const saved = JSON.parse(readFileSync(join(stateDir, 'update-available.json'), 'utf8'));
    assert.equal(saved.downloadUrl, null);
    assert.equal(saved.releasePageUrl, null);
    assert.equal(saved.releaseDate, null);
    assert.equal(saved.notes, null);
  });
});

test('checkUpdate: 路径参数缺失 → ok:false，不抛', async () => {
  const res = await checkUpdate({});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-paths');
  assert.equal(res.channel, DEFAULT_CHANNEL);
});

test('checkUpdate: 显式 channel 参数优先，非法值忽略后按 env/文件/默认解析', async () => {
  await withTempDir(async (dir) => {
    const versionFile = writeVersionFile(dir, '2026.9.36');
    const stateDir = stateDirOf(dir);

    const explicit = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      channel: 'extended-stable',
      env: { UCLAW_UPDATE_CHANNEL: 'stable' },
      fetchImpl: makeFetch(),
    });
    assert.equal(explicit.channel, 'extended-stable');

    const invalid = await checkUpdate({
      versionFilePath: versionFile,
      stateDir,
      channel: 'nonsense',
      env: { UCLAW_UPDATE_CHANNEL: 'extended-stable' },
      fetchImpl: makeFetch(),
    });
    assert.equal(invalid.channel, 'extended-stable');
  });
});

// ── CLI：无网络也必须退出 0 ─────────────────────────────────────────────────

test('check-update CLI: 完全无网络时退出码 0（静默失败不阻塞启动）', async () => {
  await withTempDir(async (dir) => {
    const versionFile = writeVersionFile(dir, '2026.9.36');
    const stateDir = stateDirOf(dir);
    const { stdout } = await execFileAsync(process.execPath, [
      join(REPO, 'portable', 'lib', 'check-update.mjs'),
      versionFile,
      stateDir,
      // 端口 1 上没有 HTTP 服务 → 立即 ECONNREFUSED，不依赖外网
      'http://127.0.0.1:1/latest.json',
    ], {
      env: {
        ...process.env,
        UCLAW_UPDATE_REGISTRY_URL: 'http://127.0.0.1:1/openclaw',
        UCLAW_UPDATE_CHANNEL: 'extended-stable',
      },
      timeout: 20000,
    });

    const res = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(res.ok, false);
    assert.equal(res.channel, 'extended-stable');
    assert.equal(existsSync(join(stateDir, 'update-available.json')), false);
  });
});
