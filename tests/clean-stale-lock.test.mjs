// 回归测试：clean-stale-lock.mjs —— 清理 OpenClaw 残留的 gateway 死锁。
//
// 背景：CLAUDE.md 记录的故障 —— U 盘拔出 / 进程崩溃后，os.tmpdir()/openclaw*/gateway.*.lock
// 残留，OpenClaw 下次启动报 "gateway already running (pid XXXX)" 拒绝启动，过去需要手动 rm。
// 本脚本在启动前自动清理，但**保守性是死线**：误删一个还活着的锁，会导致两个 gateway
// 同时跑，比原 bug 更严重。因此测试的核心不是"能不能删"，而是"绝不该删的场景真的没删"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanStaleLocks } from '../portable/lib/clean-stale-lock.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-clean-lock-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('pid 已死的锁必须被删除', () => {
  withTempDir((dir) => {
    const lock = join(dir, 'gateway.abcd1234.lock');
    writeFileSync(lock, JSON.stringify({ pid: 99999, createdAt: Date.now(), configPath: '/some/openclaw.json' }));

    const result = cleanStaleLocks(dir, { isPidAlive: () => false });

    assert.equal(result.removed, 1);
    assert.equal(existsSync(lock), false);
  });
});

test('pid 还活着的锁绝不能被删除（误删 = 两个 gateway 同时跑，比原 bug 更严重）', () => {
  withTempDir((dir) => {
    const lock = join(dir, 'gateway.live1234.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), configPath: '/some/openclaw.json' }));

    const result = cleanStaleLocks(dir, { isPidAlive: () => true });

    assert.equal(result.removed, 0);
    assert.equal(existsSync(lock), true, '活锁必须原样保留');
  });
});

test('锁文件内容损坏（非 JSON）时视为死锁，予以清理', () => {
  withTempDir((dir) => {
    const lock = join(dir, 'gateway.corrupt1.lock');
    writeFileSync(lock, '{ this is not valid json');

    const result = cleanStaleLocks(dir, { isPidAlive: () => true }); // 就算 isPidAlive 恒真也不该被当活锁保护，因为内容根本解不出 pid

    assert.equal(result.removed, 1);
    assert.equal(existsSync(lock), false);
  });
});

test('锁文件是合法 JSON 但缺 pid 字段时也视为损坏，予以清理', () => {
  withTempDir((dir) => {
    const lock = join(dir, 'gateway.nopid123.lock');
    writeFileSync(lock, JSON.stringify({ createdAt: Date.now() }));

    const result = cleanStaleLocks(dir, { isPidAlive: () => true });

    assert.equal(result.removed, 1);
  });
});

test('EPERM（无权限探测，进程可能仍活着）时保守不删', () => {
  withTempDir((dir) => {
    const lock = join(dir, 'gateway.eperm1234.lock');
    writeFileSync(lock, JSON.stringify({ pid: 1, createdAt: Date.now(), configPath: '/some/openclaw.json' }));

    // 模拟真实 pidAlive() 对 EPERM 的处理：EPERM 视为"进程还在，只是没权限探测" → 保守判活。
    const isPidAlive = (pid) => {
      const err = new Error('no perm');
      err.code = 'EPERM';
      // 真实实现里 EPERM 走 catch 分支返回 true；这里直接模拟其外部可观察结果。
      return true;
    };

    const result = cleanStaleLocks(dir, { isPidAlive });

    assert.equal(result.removed, 0);
    assert.equal(existsSync(lock), true, 'EPERM 下必须保守，不能删——删错了比原 bug 更严重');
  });
});

test('锁目录本身不存在时不报错，静默返回零结果', () => {
  withTempDir((dir) => {
    const missing = join(dir, 'does-not-exist-dir');
    const result = cleanStaleLocks(missing, { isPidAlive: () => false });

    assert.deepEqual(result, { removed: 0, aliveSameConfig: 0 });
  });
});

test('目录里没有任何 gateway.*.lock 文件时不报错，返回零结果', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'unrelated.txt'), 'hello');
    const result = cleanStaleLocks(dir, { isPidAlive: () => false });

    assert.deepEqual(result, { removed: 0, aliveSameConfig: 0 });
  });
});

test('活锁属于本盘自己的配置时，aliveSameConfig 计数用于友好提示', () => {
  withTempDir((dir) => {
    const cfgPath = join(dir, 'openclaw.json');
    const lock = join(dir, 'gateway.same1234.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), configPath: cfgPath }));

    const result = cleanStaleLocks(dir, { isPidAlive: () => true, ourConfig: cfgPath });

    assert.equal(result.removed, 0);
    assert.equal(result.aliveSameConfig, 1);
  });
});

test('真实 pidAlive()：一个必然不存在的 pid 判定为死', async () => {
  const { pidAlive } = await import('../portable/lib/clean-stale-lock.mjs');
  // PID 999999999 在绝大多数系统上都不可能存在
  assert.equal(pidAlive(999999999), false);
});

test('真实 pidAlive()：当前进程自身的 pid 判定为活', async () => {
  const { pidAlive } = await import('../portable/lib/clean-stale-lock.mjs');
  assert.equal(pidAlive(process.pid), true);
});
