import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { startBoot, mark, readLastBoot, formatReport } from '../portable/lib/boot-timing.mjs';

function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-boot-timing-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('boot-timing: start 写入一行并返回 boot id', () => {
  withStateDir((dir) => {
    const boot = startBoot(dir, { now: 1000 });
    assert.ok(boot, 'startBoot 应返回 boot id');
    const entries = readLastBoot(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].phase, 'start');
    assert.equal(entries[0].at, 1000);
    assert.equal(entries[0].durationMs, 0);
    assert.equal(entries[0].sinceStartMs, 0);
  });
});

test('boot-timing: mark 记录相对上一阶段与相对启动的耗时', () => {
  withStateDir((dir) => {
    startBoot(dir, { now: 1000 });
    const first = mark(dir, 'node-validated', { now: 1500 });
    assert.equal(first.ok, true);
    assert.equal(first.durationMs, 500);
    assert.equal(first.sinceStartMs, 500);
    const second = mark(dir, 'config-center', { now: 3000 });
    assert.equal(second.durationMs, 1500);
    assert.equal(second.sinceStartMs, 2000);
    const phases = readLastBoot(dir).map((e) => e.phase);
    assert.deepEqual(phases, ['start', 'node-validated', 'config-center']);
  });
});

test('boot-timing: 未 start 时 mark 静默失败且不抛', () => {
  withStateDir((dir) => {
    const result = mark(dir, 'orphan', { now: 5 });
    assert.equal(result.ok, false);
    assert.equal(readLastBoot(dir).length, 0);
    assert.equal(existsSync(join(dir, 'boot-timing.jsonl')), false, '未 start 不应创建文件');
  });
});

test('boot-timing: start 会重置上一次启动的记录', () => {
  withStateDir((dir) => {
    startBoot(dir, { now: 1000 });
    mark(dir, 'a', { now: 1100 });
    const boot2 = startBoot(dir, { now: 9000 });
    mark(dir, 'b', { now: 9300 });
    const entries = readLastBoot(dir);
    assert.equal(entries.length, 2, '只保留最近一次启动的阶段');
    assert.equal(entries[0].boot, boot2);
    assert.deepEqual(entries.map((e) => e.phase), ['start', 'b']);
  });
});

test('boot-timing: 坏行被跳过，报告仍可用', () => {
  withStateDir((dir) => {
    startBoot(dir, { now: 1000 });
    mark(dir, 'x', { now: 1200 });
    const file = join(dir, 'boot-timing.jsonl');
    const content = readFileSync(file, 'utf8');
    writeFileSync(file, content + 'not json at all\n{"phase": 123}\n');
    const report = formatReport(dir);
    assert.match(report, /last boot:/);
    assert.match(report, /x/);
  });
});

test('boot-timing: 超过体积上限时自动截断而不是无限增长', () => {
  withStateDir((dir) => {
    startBoot(dir, { now: 1000 });
    const file = join(dir, 'boot-timing.jsonl');
    // 塞 80KB 垃圾，下一次 mark 应清空重写（保持文件有界）
    writeFileSync(file, 'x'.repeat(80 * 1024));
    const result = mark(dir, 'after-trim', { now: 2000 });
    assert.equal(result.ok, false, '垃圾内容里没有 boot 记录，mark 应静默失败');
  });
});

test('boot-timing: 状态目录不可写时静默失败', () => {
  const badDir = join(tmpdir(), 'uclaw-boot-timing-unwritable-file');
  writeFileSync(badDir, 'not a directory');
  try {
    const boot = startBoot(badDir, { now: 1 });
    assert.equal(boot, null);
    const result = mark(badDir, 'x', { now: 2 });
    assert.equal(result.ok, false);
  } finally {
    rmSync(badDir, { force: true });
  }
});
