import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// 真实子进程验证两个调用层（.sh / .bat）：成功时导出全部变量到调用进程，
// 失败时清掉旧缓存变量 + NODE_DISABLE_COMPILE_CACHE=1 + 错误可见（不 2>nul 吞掉）。
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const helperBat = join(repoRoot, 'portable', 'lib', 'portable-cache-env.bat');
const helperSh = join(repoRoot, 'portable', 'lib', 'portable-cache-env.sh');
const helperNode = process.execPath;

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-cache-env-'));
  const usbRoot = join(root, 'usb');
  const stateDir = join(usbRoot, 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  const local = join(root, 'LocalAppData');
  mkdirSync(local, { recursive: true });
  return { root, usbRoot, stateDir, local };
}

test('portable-cache-env.sh：子进程 source 后成功导出全部缓存/临时/日志变量', () => {
  const { root, usbRoot, stateDir, local } = makeFixture();
  try {
    const script = `
. "$1" "$2" "$3" "$4"
rc=$?
echo "RC=$rc"
echo "DISABLE=\${NODE_DISABLE_COMPILE_CACHE-unset}"
echo "COMPILE=\${NODE_COMPILE_CACHE-unset}"
echo "NPM=\${npm_config_cache-unset}"
echo "TEMP=\${TEMP-unset}"
echo "TMP=\${TMP-unset}"
echo "TMPDIR=\${TMPDIR-unset}"
echo "SQLITE=\${SQLITE_TMPDIR-unset}"
echo "BROWSER=\${OPENCLAW_MANAGED_BROWSER_DIR-unset}"
echo "ROOT=\${UCLAW_CACHE_ROOT-unset}"
echo "LOG=\${UCLAW_LOG_DIR-unset}"
`;
    const res = spawnSync('bash', ['-c', script, 'helper-env-test', helperSh, stateDir, usbRoot, helperNode], {
      encoding: 'utf8',
      env: { ...process.env, UCLAW_CACHE_CANDIDATES: local },
    });
    if (res.error && res.error.code === 'ENOENT') {
      test.skip('bash not available on this host');
      return;
    }
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /RC=0/);
    assert.match(res.stdout, /DISABLE=unset/);
    assert.match(res.stdout, new RegExp(`COMPILE=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`NPM=${escape(local)}`));
    for (const key of ['TEMP', 'TMP', 'TMPDIR', 'SQLITE']) {
      assert.match(res.stdout, new RegExp(`^${key}=${escape(local)}`, 'm'), `${key} 应指向本机 tmp`);
    }
    assert.match(res.stdout, new RegExp(`BROWSER=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`ROOT=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`LOG=${escape(local)}`));
    assert.equal(existsSync(join(stateDir, 'portable-cache-id')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable-cache-env.sh：候选全不可用时返回 1、清变量、禁编译缓存，错误不吞', () => {
  const { root, usbRoot, stateDir } = makeFixture();
  try {
    const inUsb = join(usbRoot, 'only-candidate');
    mkdirSync(inUsb, { recursive: true });
    const script = `
export NODE_COMPILE_CACHE=/stale/comile
export npm_config_cache=/stale/npm
export OPENCLAW_MANAGED_BROWSER_DIR=/stale/browser
export UCLAW_CACHE_ROOT=/stale/root
. "$1" "$2" "$3" "$4"
rc=$?
echo "RC=$rc"
echo "DISABLE=\${NODE_DISABLE_COMPILE_CACHE-unset}"
echo "COMPILE=\${NODE_COMPILE_CACHE-empty}"
echo "NPM=\${npm_config_cache-empty}"
echo "BROWSER=\${OPENCLAW_MANAGED_BROWSER_DIR-empty}"
echo "ROOT=\${UCLAW_CACHE_ROOT-empty}"
`;
    const res = spawnSync('bash', ['-c', script, 'helper-env-test', helperSh, stateDir, usbRoot, helperNode], {
      encoding: 'utf8',
      env: { ...process.env, UCLAW_CACHE_CANDIDATES: inUsb },
    });
    if (res.error && res.error.code === 'ENOENT') {
      test.skip('bash not available on this host');
      return;
    }
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /RC=1/);
    assert.match(res.stdout, /DISABLE=1/);
    assert.match(res.stdout, /COMPILE=empty/);
    assert.match(res.stdout, /NPM=empty/);
    assert.match(res.stdout, /BROWSER=empty/);
    assert.match(res.stdout, /ROOT=empty/);
    assert.match(res.stderr, /no writable local cache directory/i);
    assert.equal(existsSync(join(stateDir, 'portable-cache-id')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function escape(p) {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runBatHelper(fixture, { useLocal }) {
  const { root, stateDir, usbRoot, local } = fixture;
  // 复制 helper 与 portable-cache.mjs 到 ASCII 路径再调用：helper 用 %~dp0 找同目录模块，
  // 且 cmd.exe 默认按 GBK 读 .bat，仓库路径含中文会走形。
  const helperCopy = join(root, 'portable-cache-env.bat');
  copyFileSync(helperBat, helperCopy);
  copyFileSync(join(repoRoot, 'portable', 'lib', 'portable-cache.mjs'), join(root, 'portable-cache.mjs'));
  const runner = join(root, 'runner.bat');
  const candidates = useLocal ? local : join(usbRoot, 'only-candidate');
  if (!useLocal) mkdirSync(candidates, { recursive: true });
  writeFileSync(runner, [
    '@echo off',
    'set "NODE_COMPILE_CACHE=/stale/compile"',
    'set "npm_config_cache=/stale/npm"',
    'set "OPENCLAW_MANAGED_BROWSER_DIR=/stale/browser"',
    `call "${helperCopy}" "${stateDir}" "${usbRoot}" "${helperNode}"`,
    'echo RC=%errorlevel%',
    'echo DISABLE=%NODE_DISABLE_COMPILE_CACHE%',
    'echo COMPILE=%NODE_COMPILE_CACHE%',
    'echo NPM=%npm_config_cache%',
    'echo TEMP=%TEMP%',
    'echo BROWSER=%OPENCLAW_MANAGED_BROWSER_DIR%',
    'echo ROOT=%UCLAW_CACHE_ROOT%',
    'echo LOG=%UCLAW_LOG_DIR%',
    '',
  ].join('\r\n'));
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', runner], {
    encoding: 'utf8',
    env: { ...process.env, UCLAW_CACHE_CANDIDATES: candidates },
  });
}

test('portable-cache-env.bat：子进程 call 后成功导出变量到调用进程', () => {
  const { root, usbRoot, stateDir, local } = makeFixture();
  try {
    const res = runBatHelper({ root, usbRoot, stateDir, local }, { useLocal: true });
    if (res.error && res.error.code === 'ENOENT') {
      test.skip('cmd.exe not available on this host');
      return;
    }
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /RC=0/);
    assert.match(res.stdout, /DISABLE=/); // success clears it (empty)
    assert.ok(!/^DISABLE=1$/m.test(res.stdout), '成功后不得保留 NODE_DISABLE_COMPILE_CACHE=1');
    assert.match(res.stdout, new RegExp(`COMPILE=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`NPM=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`TEMP=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`BROWSER=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`ROOT=${escape(local)}`));
    assert.match(res.stdout, new RegExp(`LOG=${escape(local)}`));
    assert.equal(existsSync(join(stateDir, 'portable-cache-id')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable-cache-env.bat：候选全不可用时 RC=1、清变量、禁编译缓存，stderr 可见', () => {
  const { root, usbRoot, stateDir, local } = makeFixture();
  try {
    const res = runBatHelper({ root, usbRoot, stateDir, local }, { useLocal: false });
    if (res.error && res.error.code === 'ENOENT') {
      test.skip('cmd.exe not available on this host');
      return;
    }
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /RC=1/);
    assert.match(res.stdout, /DISABLE=1/);
    assert.match(res.stdout, /^COMPILE=$/m); // stale value must be cleared
    assert.match(res.stdout, /^NPM=$/m);
    assert.match(res.stdout, /^BROWSER=$/m);
    assert.match(res.stdout, /^ROOT=$/m);
    assert.match(res.stderr, /No writable local cache directory/i);
    assert.equal(existsSync(join(stateDir, 'portable-cache-id')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
