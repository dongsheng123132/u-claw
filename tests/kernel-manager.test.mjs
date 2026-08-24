// kernel-manager.test.mjs — 内核安装器：离线 seed、原子落地、激活与回退、gc
//
// 最要紧的一条是「断网也能装起来」：fetchImpl 直接抛异常，安装仍须成功。
// 那是 release note 里"解压即用、零网络依赖"这句承诺的可执行版本 ——
// 1543 次下载是冲这句来的，测试就得能证伪它。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createKernelManager, tarBinary } from '../portable/lib/kernel-manager.mjs';
import { resolveRuntimePaths } from '../portable/lib/runtime-paths.mjs';

const PINNED = '2026.7.1-2';
const NODE_VERSION = '22.23.2';

const NO_NETWORK = () => {
  throw new Error('测试禁止联网：这条路径必须能在断网时跑通');
};

function makeChannel(overrides = {}) {
  return {
    node: {
      version: NODE_VERSION,
      minimumVersion: '22.14.0',
      mirrors: ['https://example.invalid/node'],
      target: {
        archive: `node-v${NODE_VERSION}-win-x64.zip`,
        sha256: '0'.repeat(64),
        nodeRelativePath: 'node.exe',
        npmCliRelativePath: 'node_modules/npm/bin/npm-cli.js',
      },
    },
    kernel: {
      package: 'openclaw',
      version: PINNED,
      registry: 'https://registry.invalid/',
      installRegistries: ['https://registry.invalid/'],
    },
    reuse: { allowSystemNode: false, allowForeignKernel: false },
    ...overrides,
  };
}

// 造一棵最小但结构真实的内核树：node_modules/openclaw/{package.json,openclaw.mjs}
function writeKernelTree(root, version) {
  const packageRoot = join(root, 'node_modules', 'openclaw');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'openclaw',
    version,
    bin: { openclaw: 'openclaw.mjs' },
    engines: { node: '>=22.14.0' },
  }));
  writeFileSync(join(packageRoot, 'openclaw.mjs'), '#!/usr/bin/env node\n');
  return packageRoot;
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'uclaw-kernel-'));
  const usbRoot = join(base, 'usb');
  mkdirSync(join(usbRoot, 'vendor'), { recursive: true });
  const paths = resolveRuntimePaths({
    usbRoot,
    platform: 'win32',
    arch: 'x64',
    nodeVersion: NODE_VERSION,
    env: { LOCALAPPDATA: join(base, 'host') },
  });
  mkdirSync(paths.kernelsDir, { recursive: true });
  mkdirSync(paths.runtimeDir, { recursive: true });
  return { base, usbRoot, paths, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// 用真 tar 打一个 seed 包 —— 假的 runner 证明不了压缩包真能解开。
// 走和生产代码同一个 tarBinary()：Windows 上 PATH 里的 GNU tar 会把 C:\ 当远程主机。
function packSeed(vendorDir, version, target, treeDir) {
  const archive = join(vendorDir, `openclaw-${version}-${target}.tar.gz`);
  execFileSync(tarBinary(), ['-czf', archive, '-C', treeDir, '.'], { windowsHide: true });
  return archive;
}

// ── 离线 seed ───────────────────────────────────────────────────────────────

test('断网也能从 U 盘 seed 装起内核 —— "零网络依赖"的可执行版本', async () => {
  const { paths, usbRoot, cleanup } = setup();
  try {
    const staging = join(paths.hostRoot, 'seed-src');
    writeKernelTree(staging, PINNED);
    packSeed(join(usbRoot, 'vendor'), PINNED, 'win-x64', staging);

    const manager = createKernelManager({
      paths, channel: makeChannel(), fetchImpl: NO_NETWORK, platform: process.platform,
    });

    const phases = [];
    const result = await manager.installKernel(PINNED, (event) => phases.push(event.phase));

    assert.equal(result.source, 'usb-seed');
    assert.equal(result.version, PINNED);
    assert.ok(existsSync(result.entry), '内核 CLI 入口必须真的存在');
    assert.ok(phases.includes('seeding-kernel'));

    const manifest = JSON.parse(await readFile(join(result.packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.version, PINNED);
  } finally {
    cleanup();
  }
});

test('seed 装完，内核落在本机而不是 U 盘上', async () => {
  const { paths, usbRoot, cleanup } = setup();
  try {
    const staging = join(paths.hostRoot, 'seed-src');
    writeKernelTree(staging, PINNED);
    packSeed(join(usbRoot, 'vendor'), PINNED, 'win-x64', staging);

    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    const result = await manager.installKernel(PINNED);

    assert.ok(result.root.startsWith(paths.hostRoot), '内核必须装在本机');
    assert.ok(!result.root.startsWith(usbRoot), '内核绝不许落回 U 盘 —— 那是 v2 的病根');
  } finally {
    cleanup();
  }
});

test('二次安装直接复用，不再解压', async () => {
  const { paths, usbRoot, cleanup } = setup();
  try {
    const staging = join(paths.hostRoot, 'seed-src');
    writeKernelTree(staging, PINNED);
    packSeed(join(usbRoot, 'vendor'), PINNED, 'win-x64', staging);

    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await manager.installKernel(PINNED);

    const phases = [];
    const second = await manager.installKernel(PINNED, (event) => phases.push(event.phase));
    assert.equal(second.source, 'managed-shared');
    assert.equal(second.reused, true);
    assert.deepEqual(phases, [], '命中缓存就不该再有任何解压/下载动作');
  } finally {
    cleanup();
  }
});

test('seed 里的版本对不上就拒绝安装，不静默用错版本', async () => {
  const { paths, usbRoot, cleanup } = setup();
  try {
    const staging = join(paths.hostRoot, 'seed-src');
    writeKernelTree(staging, '2026.1.1');            // 树里是别的版本
    packSeed(join(usbRoot, 'vendor'), PINNED, 'win-x64', staging);  // 但文件名写着锁定版

    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await assert.rejects(
      () => manager.installKernel(PINNED),
      /内核身份校验失败/,
    );
    assert.equal(existsSync(join(paths.kernelsDir, PINNED)), false, '校验失败不许留下半截内核');
  } finally {
    cleanup();
  }
});

test('装坏的内核目录不算已安装，也不会被 listInstalled 报出来', async () => {
  const { paths, cleanup } = setup();
  try {
    // 只有目录没有内容 —— 模拟解压到一半断电
    mkdirSync(join(paths.kernelsDir, PINNED, 'node_modules'), { recursive: true });
    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    assert.deepEqual(await manager.listInstalled(), []);
    await assert.rejects(() => manager.resolveKernel(PINNED));
  } finally {
    cleanup();
  }
});

// ── 激活与回退 ──────────────────────────────────────────────────────────────

test('切激活指针前先验证目标可用', async () => {
  const { paths, cleanup } = setup();
  try {
    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await assert.rejects(() => manager.activate(PINNED), /ENOENT|校验失败|入口/);
    assert.equal(await manager.activeVersion(), null, '验证没过就不许写激活指针');
  } finally {
    cleanup();
  }
});

test('新内核起不来能回退到上一版，且不需要重装', async () => {
  const { paths, cleanup } = setup();
  try {
    const older = '2026.6.34';
    writeKernelTree(join(paths.kernelsDir, older), older);
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);

    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await manager.activate(older);
    const upgraded = await manager.activate(PINNED);
    assert.equal(upgraded.previous, older);

    const rolled = await manager.rollback();
    assert.equal(rolled.version, older);
    assert.equal(await manager.activeVersion(), older);
    // 旧版本还在盘上，回退是改一个指针，不是重装
    assert.ok(existsSync(join(paths.kernelsDir, older, 'node_modules', 'openclaw')));
  } finally {
    cleanup();
  }
});

test('没有上一版时回退要明确报错，不许猜一个版本切过去', async () => {
  const { paths, cleanup } = setup();
  try {
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);
    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await manager.activate(PINNED);
    await assert.rejects(() => manager.rollback(), /没有可回退的上一版/);
  } finally {
    cleanup();
  }
});

// ── 空间治理 ────────────────────────────────────────────────────────────────

test('gc 保留 当前/上一版/锁定版，清掉其余', async () => {
  const { paths, cleanup } = setup();
  try {
    const versions = ['2026.5.7', '2026.6.34', PINNED];
    for (const version of versions) writeKernelTree(join(paths.kernelsDir, version), version);

    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await manager.activate('2026.6.34');
    await manager.activate(PINNED);          // previous = 2026.6.34

    const preview = await manager.gc({ dryRun: true });
    assert.deepEqual(preview.removed.map((entry) => entry.version), ['2026.5.7']);
    assert.ok(existsSync(join(paths.kernelsDir, '2026.5.7')), 'dryRun 不许真删');

    const done = await manager.gc();
    assert.deepEqual(done.removed.map((entry) => entry.version), ['2026.5.7']);
    assert.equal(existsSync(join(paths.kernelsDir, '2026.5.7')), false);
    assert.ok(existsSync(join(paths.kernelsDir, '2026.6.34')), '上一版要留着，回退还指望它');
    assert.ok(existsSync(join(paths.kernelsDir, PINNED)));
    assert.ok(done.removed[0].bytes > 0, '要报出清掉多少空间，否则客户不知道值不值');
  } finally {
    cleanup();
  }
});

test('gc 顺手清掉中断留下的 .install-* 暂存目录', async () => {
  const { paths, cleanup } = setup();
  try {
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);
    mkdirSync(join(paths.kernelsDir, '.install-2026.7.1-2-999-123'), { recursive: true });

    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await manager.activate(PINNED);
    await manager.gc();
    assert.equal(existsSync(join(paths.kernelsDir, '.install-2026.7.1-2-999-123')), false);
  } finally {
    cleanup();
  }
});

// ── 边界 ────────────────────────────────────────────────────────────────────

test('版本号形状不对直接拒绝，不去拼路径', async () => {
  const { paths, cleanup } = setup();
  try {
    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    for (const bad of ['../../etc', 'latest', '', '2026']) {
      await assert.rejects(() => manager.installKernel(bad), /内核版本无效/);
    }
  } finally {
    cleanup();
  }
});

test('status 报得出本机装了哪些、当前用哪个', async () => {
  const { paths, cleanup } = setup();
  try {
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);
    const manager = createKernelManager({ paths, channel: makeChannel(), fetchImpl: NO_NETWORK });
    await manager.activate(PINNED);

    const status = await manager.status();
    assert.equal(status.pinnedVersion, PINNED);
    assert.equal(status.activeVersion, PINNED);
    assert.deepEqual(status.installedVersions, [PINNED]);
    assert.equal(status.nodeReady, false, '这个用例没装 Node，就该老实说没装');
  } finally {
    cleanup();
  }
});
