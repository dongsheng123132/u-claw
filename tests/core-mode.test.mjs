// 守卫测试：core-mode（Lite/Full 内核选择状态）读写 + HTTP 切换接口。
//
// 锁三件事：
//   1. core-mode.mjs 读损坏/未知/缺失一律回退默认 lite 且不抛；写只收两枚举值，原子 tmp+rename。
//   2. 内容绝不被拼进路径/命令/env（这里通过"读出来的值只作为字符串返回、不出现在任何拼接语句"间接锁）。
//   3. POST /api/core-mode 真实服务只收两值，写完返回 restartRequired:true，非法值不改坏文件。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCoreMode, writeCoreMode, isValidCoreMode, CORE_MODE_LITE, CORE_MODE_OPENCLAW } from '../portable/lib/core-mode.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// ── 纯单元：core-mode.mjs ──────────────────────────────────────────────────────
test('readCoreMode 缺省文件回退 lite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-mode-default-'));
  try {
    assert.equal(readCoreMode(dir), CORE_MODE_LITE, '无文件应回退默认 lite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCoreMode 读有效值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-mode-read-'));
  try {
    writeFileSync(join(dir, 'core-mode'), 'openclaw', 'utf8');
    assert.equal(readCoreMode(dir), CORE_MODE_OPENCLAW);
    writeFileSync(join(dir, 'core-mode'), 'lite', 'utf8');
    assert.equal(readCoreMode(dir), CORE_MODE_LITE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCoreMode 损坏/未知内容回退 lite 且不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-mode-corrupt-'));
  try {
    const warns = [];
    writeFileSync(join(dir, 'core-mode'), 'full\n', 'utf8'); // 非法枚举
    assert.equal(readCoreMode(dir, { warn: (m) => warns.push(m) }), CORE_MODE_LITE);
    assert.ok(warns.length > 0, '未知值应产生可见警告');

    writeFileSync(join(dir, 'core-mode'), '  ', 'utf8'); // 空白
    assert.equal(readCoreMode(dir), CORE_MODE_LITE, '空白内容回退 lite');

    writeFileSync(join(dir, 'core-mode'), 'LITE', 'utf8'); // 大小写不识别
    assert.equal(readCoreMode(dir), CORE_MODE_LITE, '大小写敏感，LITE 非法');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCoreMode 只接受两枚举值，原子写后可回读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-mode-write-'));
  try {
    assert.throws(() => writeCoreMode(dir, 'full'), /lite|openclaw/, '非法值必须抛');
    assert.throws(() => writeCoreMode(dir, 'OPENCLAW'), /lite|openclaw/, '大小写也拒');
    assert.equal(isValidCoreMode('lite'), true);
    assert.equal(isValidCoreMode('openclaw'), true);
    assert.equal(isValidCoreMode('full'), false);

    writeCoreMode(dir, 'openclaw');
    assert.equal(readCoreMode(dir), CORE_MODE_OPENCLAW, '写后应回读一致');
    // 原子写不留 .tmp 残留
    const leftover = readdirSync(dir).filter((f) => f.startsWith('.core-mode.tmp'));
    assert.equal(leftover.length, 0, '原子写不应留临时文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 真实服务：POST /api/core-mode ──────────────────────────────────────────────
const serverJs = join(repoRoot, 'portable', 'config-server', 'server.js');
let nextTestPort = 18950;

async function withServer(stateDir, fn) {
  const TEST_PORT = nextTestPort++;
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: stateDir, UCLAW_CONFIG_PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      if (stdout.includes(`http://127.0.0.1:${TEST_PORT}`)) ready = true;
      else await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, `config-server did not report port ${TEST_PORT}`);
    await fn(TEST_PORT);
  } finally {
    child.kill();
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
  }
}

function fixtureStateDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateDir = join(root, 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

test('GET /api/core-mode 缺省返回 lite', async () => {
  const stateDir = fixtureStateDir('core-mode-get-');
  try {
    await withServer(stateDir, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/core-mode`);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.mode, CORE_MODE_LITE, '缺省应为 lite');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('POST /api/core-mode 写 openclaw 返回 restartRequired，且文件落地', async () => {
  const stateDir = fixtureStateDir('core-mode-post-');
  try {
    await withServer(stateDir, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/core-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'openclaw' }),
      });
      const body = await res.json();
      assert.equal(body.ok, true, '应成功');
      assert.equal(body.mode, CORE_MODE_OPENCLAW);
      assert.equal(body.restartRequired, true, '应提示重启生效');
      assert.equal(readFileSync(join(stateDir, 'core-mode'), 'utf8').trim(), 'openclaw', '文件应落地');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('POST /api/core-mode 拒收非法值且不改坏已有文件', async () => {
  const stateDir = fixtureStateDir('core-mode-reject-');
  try {
    writeFileSync(join(stateDir, 'core-mode'), 'lite', 'utf8');
    await withServer(stateDir, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/core-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      });
      const body = await res.json();
      assert.equal(body.ok, false, '非法值应被拒');
      assert.equal(readFileSync(join(stateDir, 'core-mode'), 'utf8').trim(), 'lite', '文件不应被改成非法值');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
