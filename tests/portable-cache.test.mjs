import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePortableCache } from '../portable/lib/portable-cache.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const portableCacheJs = join(repoRoot, 'portable', 'lib', 'portable-cache.mjs');

// 契约（本批新语义，不再是"首选失败就回落 U 盘"）：
//   1) 候选链回退：LOCALAPPDATA 类首选不可写 → 试 HOME 缓存 → 试系统 temp；
//   2) 候选（含全部子目录）realpath 不得在 usbRoot/stateDir 子树内，写探测必须通过；
//   3) 全部候选失败 → localCacheAvailable:false、路径全空、不建任何目录、不写 UUID、不写 U 盘；
//   4) UUID 只在本机可用后首次写入；换盘符复用；损坏的旧文件不覆盖。
// 测试一律注入 candidates，绝不回退到开发机的真实系统缓存。
function makeFixture(config = { gateway: { mode: 'local' }, agents: { list: [{ id: 'a' }] } }) {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-portable-cache-'));
  const usbRoot = join(root, 'usb');
  const stateDir = join(usbRoot, 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(stateDir, 'openclaw.json');
  const configBytes = `${JSON.stringify(config)}\n`;
  writeFileSync(configPath, configBytes);
  return { root, usbRoot, stateDir, configPath, configBytes, config };
}

function makeWritableBase(root, name) {
  const base = join(root, name);
  mkdirSync(base, { recursive: true });
  return base;
}

test('全部目录落在注入的本机候选下；config/session/wallet 字节不变；U 盘不出现缓存目录', () => {
  const { root, usbRoot, stateDir, configPath, configBytes, config } = makeFixture();
  try {
    const local = makeWritableBase(root, 'LocalAppData');
    const result = resolvePortableCache({ stateDir, usbRoot, platform: 'win32', env: {}, candidates: [local] });

    assert.equal(result.localCacheAvailable, true);
    for (const p of [result.root, result.compileCacheDir, result.npmCacheDir, result.tempDir, result.logDir,
      result.managedBrowserDir, result.browserUserDataDir]) {
      assert.ok(p && p.startsWith(local), `${p} 应在本机候选 ${local} 下`);
    }
    assert.equal(readFileSync(configPath, 'utf8'), configBytes, 'config 必须逐字节不变');
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), config);

    const usbEntries = readdirSync(usbRoot);
    assert.deepEqual(usbEntries, ['data'], 'U 盘上不得出现缓存目录');
    const stateEntries = readdirSync(stateDir).filter((n) => n !== 'portable-cache-id');
    assert.deepEqual(stateEntries, ['openclaw.json'], 'stateDir 只新增 UUID 文件');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('首选候选在 usbRoot/stateDir 子树内时被跳过，落到下一个可写候选', () => {
  const { root, usbRoot, stateDir } = makeFixture();
  try {
    const inUsb = join(usbRoot, 'local-cache');
    const inState = join(stateDir, 'sub-cache');
    mkdirSync(inUsb, { recursive: true });
    mkdirSync(inState, { recursive: true });
    const local = makeWritableBase(root, 'LocalAppData');

    const result = resolvePortableCache({
      stateDir, usbRoot, platform: 'win32', env: {}, candidates: [inUsb, inState, local],
    });

    assert.equal(result.localCacheAvailable, true);
    assert.ok(result.root.startsWith(local), `实际 root=${result.root}`);
    assert.ok(!existsSync(join(inUsb, 'U-Claw')), 'usbRoot 内的候选不得建目录');
    assert.ok(!existsSync(join(inState, 'U-Claw')), 'stateDir 内的候选不得建目录');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('首选候选不可写（路径是文件）时自动试下一个本机候选', () => {
  const { root, usbRoot, stateDir } = makeFixture();
  try {
    const blocked = join(root, 'blocked-is-a-file');
    writeFileSync(blocked, 'blocked');
    const local = makeWritableBase(root, 'LocalAppData');

    const result = resolvePortableCache({
      stateDir, usbRoot, platform: 'win32', env: {}, candidates: [blocked, local],
    });

    assert.equal(result.localCacheAvailable, true);
    assert.ok(result.root.startsWith(local), `实际 root=${result.root}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('全部候选不可用：路径全空、不写 UUID、不建任何目录、不写 U 盘', () => {
  const { root, usbRoot, stateDir } = makeFixture();
  try {
    const blocked = join(root, 'blocked-is-a-file');
    writeFileSync(blocked, 'blocked');
    const inUsb = join(usbRoot, 'local-cache');
    mkdirSync(inUsb, { recursive: true });
    const beforeUsb = readdirSync(usbRoot).sort();
    const beforeState = readdirSync(stateDir).sort();

    const result = resolvePortableCache({
      stateDir, usbRoot, platform: 'win32', env: {}, candidates: [blocked, inUsb, join(stateDir, 'sub')],
    });

    assert.equal(result.localCacheAvailable, false);
    for (const key of ['root', 'compileCacheDir', 'npmCacheDir', 'tempDir', 'logDir', 'managedBrowserDir', 'browserUserDataDir']) {
      assert.equal(result[key], '', `${key} 必须为空`);
    }
    assert.equal(existsSync(join(stateDir, 'portable-cache-id')), false, '无本机缓存时不得写 UUID');
    assert.deepEqual(readdirSync(usbRoot).sort(), beforeUsb, 'U 盘目录内容不变');
    assert.deepEqual(readdirSync(stateDir).sort(), beforeState, 'stateDir 内容不变');
    assert.ok(!existsSync(join(inUsb, 'U-Claw')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('UUID 换盘符复用：同一 stateDir、不同 usbRoot 指向同一份本机缓存；仅首次写入', () => {
  const { root, usbRoot, stateDir } = makeFixture();
  try {
    const local = makeWritableBase(root, 'LocalAppData');
    const first = resolvePortableCache({ stateDir, usbRoot, platform: 'win32', env: {}, candidates: [local] });
    const uuid1 = readFileSync(join(stateDir, 'portable-cache-id'), 'utf8').trim();
    const second = resolvePortableCache({
      stateDir, usbRoot: join(root, 'other-usb-letter', 'U-Claw'), platform: 'win32', env: {}, candidates: [local],
    });
    const uuid2 = readFileSync(join(stateDir, 'portable-cache-id'), 'utf8').trim();

    assert.equal(first.localCacheAvailable, true);
    assert.equal(second.localCacheAvailable, true);
    assert.equal(first.root, second.root, '换盘符必须命中同一 slot');
    assert.equal(uuid1, uuid2);
    assert.match(uuid1, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('损坏的 portable-cache-id 不被覆盖，退回路径身份仍可用本机缓存', () => {
  const { root, usbRoot, stateDir } = makeFixture();
  try {
    const local = makeWritableBase(root, 'LocalAppData');
    const idPath = join(stateDir, 'portable-cache-id');
    writeFileSync(idPath, 'not-a-uuid\n');

    const result = resolvePortableCache({ stateDir, usbRoot, platform: 'win32', env: {}, candidates: [local] });

    assert.equal(result.localCacheAvailable, true);
    assert.equal(readFileSync(idPath, 'utf8'), 'not-a-uuid\n', '损坏的 UUID 文件必须原样保留');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function runCli(stateDir, usbRoot, candidateBases) {
  return spawnSync(process.execPath, [portableCacheJs, stateDir, usbRoot], {
    encoding: 'utf8',
    env: {
      ...process.env,
      UCLAW_CACHE_CANDIDATES: candidateBases.join(process.platform === 'win32' ? ';' : ':'),
    },
  });
}

test('CLI：成功输出全部 KEY=VALUE 与 AVAILABLE=1；失败只输出 AVAILABLE=0 且 stderr 可见', () => {
  const { root, usbRoot, stateDir } = makeFixture();
  try {
    const local = makeWritableBase(root, 'LocalAppData');
    const ok = runCli(stateDir, usbRoot, [local]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /UCLAW_LOCAL_CACHE_AVAILABLE=1/);
    for (const key of ['UCLAW_CACHE_ROOT', 'UCLAW_COMPILE_CACHE_DIR', 'UCLAW_NPM_CACHE_DIR',
      'UCLAW_TEMP_DIR', 'UCLAW_LOG_DIR', 'UCLAW_MANAGED_BROWSER_DIR', 'UCLAW_BROWSER_USER_DATA_DIR']) {
      assert.ok(ok.stdout.includes(key + '='), `缺少 ${key}`);
    }

    const bad = runCli(stateDir, usbRoot, [join(usbRoot, 'only-usb-candidate')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /UCLAW_LOCAL_CACHE_AVAILABLE=0/);
    assert.match(bad.stderr, /refusing to fall back to the portable drive/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
