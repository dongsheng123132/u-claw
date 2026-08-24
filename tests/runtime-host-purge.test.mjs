// runtime-host-purge.test.mjs — 一键清空本机残留（影核动作 runtime.host.purge）
//
// 发版硬约束：「留东西」可以接受，「留了还删不掉」不可以。客户借的电脑、
// 公司管控机、网吧，都得能一键还干净 —— 没有清理入口就不许发版。
//
// 但 purge 是全仓库唯一一个 rm -rf 整棵树的动作，所以这个文件的重点**不是**
// 证明它能删，而是证明它**拒绝删不该删的**。下面拒绝类用例排在功能用例前面，
// 顺序是故意的：路径算错时宁可报错不干活，也绝不能把客户的盘删了（宪法 #6、#10）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { assertSafePurgeTarget, createKernelManager } from '../portable/lib/kernel-manager.mjs';
import { resolveRuntimePaths } from '../portable/lib/runtime-paths.mjs';
import { ACTIONS_BY_ID } from '../portable/lib/core/index.mjs';

const NODE_VERSION = '22.23.2';   // 跟 runtime-channel.json 的 node.version 对齐
const PINNED = '2026.7.1-2';     // = OPENCLAW_VERSION,唯一真相源

function scratch() {
  return mkdtempSync(join(tmpdir(), 'uclaw-purge-'));
}

/** 造一套指向临时目录的真实路径表。 */
function pathsIn(base, { strict = false } = {}) {
  const usbRoot = join(base, 'usb');
  return resolveRuntimePaths({
    usbRoot,
    nodeVersion: NODE_VERSION,
    platform: 'win32',
    arch: 'x64',
    env: { LOCALAPPDATA: join(base, 'appdata') },
    ...(strict ? { hostRoot: join(usbRoot, 'host') } : {}),
  });
}

// ── 安全边界：先证明它拒绝 ──────────────────────────────────────────────────

test('拒绝清理文件系统根', () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    assert.throws(() => assertSafePurgeTarget('C:\\', paths), /文件系统根/);
    assert.throws(() => assertSafePurgeTarget('/', paths), /文件系统根/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('拒绝清理不像 U-Claw 本机目录的路径', () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    // 这条挡的是 hostRoot 被配错成 %LOCALAPPDATA% 本身 ——
    // 那一删，客户整个 AppData\Local 就没了。
    assert.throws(() => assertSafePurgeTarget(join(base, 'appdata'), paths), /不像 U-Claw/);
    assert.throws(() => assertSafePurgeTarget(join(base, 'Documents'), paths), /不像 U-Claw/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('清理范围一旦会连带删除用户数据就拒绝执行', () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    // 伪造一个「hostRoot 被算成了 U 盘根」的灾难场景：目录名恰好叫 U-Claw，
    // 前两道闸都放行，只有这道能拦住 —— 钱包和会话删了没法重建。
    const disaster = join(base, 'U-Claw');
    const evil = { ...paths, dataDir: join(disaster, 'data') };
    assert.throws(() => assertSafePurgeTarget(disaster, evil), /连带删除用户数据/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('portable-strict 下 hostRoot 在 U 盘上，仍可清理且不碰 data/', () => {
  const base = scratch();
  try {
    const paths = pathsIn(base, { strict: true });
    // <usb>/host 和 <usb>/data 是兄弟，删前者不该被后者拦住。
    assert.doesNotThrow(() => assertSafePurgeTarget(paths.hostRoot, paths));
    assert.ok(paths.hostRoot.endsWith('host'));
    assert.ok(!paths.dataDir.startsWith(paths.hostRoot));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 功能：确认边界成立之后，才谈它删得对不对 ────────────────────────────────

function managerIn(paths) {
  return createKernelManager({
    paths,
    channel: { node: { version: NODE_VERSION, target: { nodeRelativePath: 'node.exe', npmCliRelativePath: 'npm-cli.js' } }, kernel: { version: PINNED } },
    platform: 'win32',
  });
}

/** 铺出一套「装过东西」的本机目录 + U 盘用户数据。 */
function seedDirs(paths) {
  for (const dir of [paths.runtimeDir, paths.kernelsDir, paths.npmCacheDir, paths.browserDir, paths.logsDir, paths.stateDir, paths.uclawStateDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(paths.runtimeDir, 'node.exe'), 'x'.repeat(1024));
  writeFileSync(join(paths.browserDir, 'profile'), 'y'.repeat(512));
  writeFileSync(paths.configFile, '{"gateway":{}}');
  writeFileSync(paths.walletFile, '{"balance":42}');
}

test('scope=all 清空整个本机目录，U 盘上的配置和钱包一律不动', async () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    seedDirs(paths);

    const result = await managerIn(paths).hostPurge({ scope: 'all' });

    assert.equal(result.existed, true);
    assert.ok(result.freedBytes >= 1536, `应报出释放的字节数，实得 ${result.freedBytes}`);
    assert.ok(!existsSync(paths.hostRoot), '本机目录应已整个消失');

    // 最重要的一条：用户数据必须还在。
    assert.ok(existsSync(paths.configFile), 'openclaw.json 不许被删');
    assert.ok(existsSync(paths.walletFile), '钱包不许被删——删了客户的钱就没了');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('scope=slot 只清当前 U 盘的槽位，共享的 Node 和内核留着', async () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    seedDirs(paths);

    const result = await managerIn(paths).hostPurge({ scope: 'slot' });

    assert.equal(result.scope, 'slot');
    assert.ok(!existsSync(paths.slotDir), '槽位目录应已删除');
    // 同一台机可能还插着别的 U 盘，共享层删了会连累它们。
    assert.ok(existsSync(paths.runtimeDir), '共享的 Node 应保留');
    assert.ok(existsSync(paths.kernelsDir), '共享的内核应保留');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--dry-run 只报不删', async () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    seedDirs(paths);

    const result = await managerIn(paths).hostPurge({ dryRun: true });

    assert.equal(result.dryRun, true);
    assert.ok(result.freedBytes > 0, 'dry-run 也要算出会释放多少，否则用户无从判断');
    assert.ok(existsSync(paths.hostRoot), 'dry-run 绝不能真删');
    assert.ok(existsSync(join(paths.runtimeDir, 'node.exe')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('本机本来就没东西时是幂等的成功，不是错误', async () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    const result = await managerIn(paths).hostPurge({});
    assert.equal(result.existed, false);
    assert.equal(result.freedBytes, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('未知 scope 直接报错，不猜用户想干什么', async () => {
  const base = scratch();
  try {
    const paths = pathsIn(base);
    await assert.rejects(() => managerIn(paths).hostPurge({ scope: 'everything' }), /未知的清理范围/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 动作契约 ────────────────────────────────────────────────────────────────

test('runtime.host.purge 已注册，且确认策略是 always', () => {
  const action = ACTIONS_BY_ID.get('runtime.host.purge');
  assert.ok(action, '动作必须注册进 core/index.mjs，否则 CLI 和 GUI 都看不到它');
  assert.equal(action.effects.class, 'destructive');
  assert.equal(action.effects.reversible, false);
  // 和 runtime.gc 的关键差别：gc 只删没人指向的旧内核，边界由动作自己守死，
  // 可以 conditional；purge 删的是整棵树含正在用的那一版，必须每次都问人。
  assert.equal(action.effects.confirmation, 'always', 'purge 不可逆，确认策略必须是 always');
  assert.equal(action.execution.idempotent, true);
});
