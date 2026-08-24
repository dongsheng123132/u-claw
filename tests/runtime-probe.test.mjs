// runtime-probe.test.mjs — v3 状态边界与运行时探测的回归用例
//
// 这些断言锁住的是**架构不变量**，不是实现细节：
//   - 钱包和用户数据必须在 U 盘，绝不落宿主机（u-dsh 踩过：每台插过 U 盘的电脑
//     都留一份能花钱的凭证）
//   - 运行时必须在本机，绝不落 U 盘（v2 的根本病，#39/#27/#43/#29/#37 都由它来）
//   - 锁和浏览器目录必须按盘隔离，绝不跨盘共享
//   - 内核版本的唯一真相源是 OPENCLAW_VERSION，通道文件不许自带一份
//   - 客户自己装的 openclaw 绝不被选中
//
// 纯 node:test，无第三方依赖，与仓库既有测试一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveRuntimePaths, resolveTarget, kernelRoot } from '../portable/lib/runtime-paths.mjs';
import { loadChannel } from '../portable/lib/runtime-channel.mjs';
import { probeRuntime } from '../portable/lib/runtime-probe.mjs';

const PORTABLE_DIR = fileURLToPath(new URL('../portable', import.meta.url));
const USB = 'I:\\U-Claw';
const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local', PATH: '' };

function winPaths(overrides = {}) {
  return resolveRuntimePaths({
    usbRoot: USB, platform: 'win32', arch: 'x64', env: WIN_ENV, nodeVersion: '22.23.2', ...overrides,
  });
}

// ── 平台目标 ────────────────────────────────────────────────────────────────

test('resolveTarget 映射到 Node 官方压缩包的命名', () => {
  assert.equal(resolveTarget('win32', 'x64'), 'win-x64');
  assert.equal(resolveTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(resolveTarget('darwin', 'x64'), 'darwin-x64');
  assert.equal(resolveTarget('linux', 'x64'), 'linux-x64');
});

// ── 状态边界：三层不许互相串 ─────────────────────────────────────────────────

test('随盘走的数据全在 U 盘下', () => {
  const p = winPaths();
  for (const file of [p.dataDir, p.stateDir, p.configFile, p.walletFile, p.settingsFile, p.vendorDir]) {
    assert.ok(
      resolve(file).toLowerCase().startsWith(resolve(USB).toLowerCase()),
      `${file} 必须在 U 盘上`,
    );
  }
});

test('钱包文件绝不落宿主机 —— u-dsh 踩过的那个坑', () => {
  const p = winPaths();
  const host = resolve(p.hostRoot).toLowerCase();
  assert.ok(!resolve(p.walletFile).toLowerCase().startsWith(host));
  assert.ok(resolve(p.walletFile).toLowerCase().startsWith(resolve(USB).toLowerCase()));
});

test('运行时与内核全在本机，绝不落 U 盘', () => {
  const p = winPaths();
  const usb = resolve(USB).toLowerCase();
  for (const dir of [p.runtimeDir, p.nodeHome, p.kernelsDir, p.npmCacheDir, p.downloadsDir, p.activeKernelFile]) {
    assert.ok(!resolve(dir).toLowerCase().startsWith(usb), `${dir} 不许住在 U 盘上`);
  }
});

test('可重建的共享层跨盘复用，机器绑定的按盘隔离', () => {
  const a = winPaths();
  const b = resolveRuntimePaths({
    usbRoot: 'J:\\U-Claw', platform: 'win32', arch: 'x64', env: WIN_ENV, nodeVersion: '22.23.2',
  });
  // 两支不同的 U 盘：Node/内核共用一份，省掉第二次下载
  assert.equal(a.sharedDir, b.sharedDir);
  assert.equal(a.nodeHome, b.nodeHome);
  assert.equal(a.kernelsDir, b.kernelsDir);
  // 但锁和浏览器 profile 必须分开，否则 "gateway already running (pid XXXX)" 会回来
  assert.notEqual(a.slotDir, b.slotDir);
  assert.notEqual(a.locksDir, b.locksDir);
  assert.notEqual(a.browserDir, b.browserDir);
});

test('槽位目录与 shared 不会撞名', () => {
  const p = winPaths();
  assert.match(p.slot, /^[0-9a-f]{16}$/);
  assert.notEqual(p.slot, 'shared');
  assert.equal(p.sharedDir, join(p.hostRoot, 'shared'));
});

test('仍然认 v2 遗留布局，老 U 盘升上来不至于跑不起来', () => {
  const p = winPaths();
  assert.equal(p.legacy.kernelPackage, join(USB, 'app', 'core', 'node_modules', 'openclaw'));
  assert.equal(p.legacy.nodeHome, join(USB, 'app', 'runtime', 'node-win-x64'));
});

test('resolveRuntimePaths 是纯计算，不建本机目录', () => {
  const p = resolveRuntimePaths({
    usbRoot: USB, platform: 'win32', arch: 'x64', nodeVersion: '22.23.2',
    env: { LOCALAPPDATA: 'Z:\\definitely\\not\\writable\\uclaw-test', PATH: '' },
  });
  // 指到一个不存在的盘也不该抛：探测路径上任何副作用都是 Bug
  assert.ok(p.hostRoot.includes('uclaw-test'));
});

// ── 版本通道：内核版本只有一个真相源 ─────────────────────────────────────────

test('内核版本从 OPENCLAW_VERSION 读，通道文件里不许自带一份', () => {
  const channel = loadChannel({ portableDir: PORTABLE_DIR, target: 'win-x64' });
  const pinned = readFileSync(join(PORTABLE_DIR, 'OPENCLAW_VERSION'), 'utf8').trim();
  assert.equal(channel.kernel.version, pinned);

  const raw = JSON.parse(readFileSync(join(PORTABLE_DIR, 'config', 'runtime-channel.json'), 'utf8'));
  assert.equal(raw.kernel.versionFrom, 'OPENCLAW_VERSION');
  assert.equal(raw.kernel.version, undefined, '通道文件不许写死内核版本，否则会跟 OPENCLAW_VERSION 漂移');
});

test('通道文件给三个平台都备了带官方 sha256 的 Node', () => {
  const channel = loadChannel({ portableDir: PORTABLE_DIR });
  for (const target of ['win-x64', 'darwin-arm64', 'linux-x64']) {
    const spec = channel.node.targets[target];
    assert.ok(spec, `${target} 缺少 Node 目标`);
    assert.match(spec.sha256, /^[0-9a-f]{64}$/, `${target} 的 sha256 不是 64 位 hex`);
    assert.ok(spec.archive.includes(channel.node.version));
  }
});

test('复用开关默认关闭 —— 省一次下载不值得换来一类串线 Bug', () => {
  const channel = loadChannel({ portableDir: PORTABLE_DIR });
  assert.equal(channel.reuse.allowSystemNode, false);
  assert.equal(channel.reuse.allowForeignKernel, false);
});

test('不认识的目标平台要明确报错，不许静默降级', () => {
  assert.throws(
    () => loadChannel({ portableDir: PORTABLE_DIR, target: 'solaris-sparc' }),
    /没有 solaris-sparc 的 Node 目标/,
  );
});

// ── 探测：客户自装的内核绝不被选中 ───────────────────────────────────────────

test('系统里另有 openclaw 时，只报告不使用，并给出理由', async () => {
  const report = await probeRuntime({ usbRoot: USB, portableDir: PORTABLE_DIR });
  assert.equal(report.ok, true);
  assert.equal(report.schemaVersion, 1);

  for (const entry of report.kernel.foreign) {
    assert.equal(entry.used, false);
    assert.notEqual(report.kernel.chosen?.path, entry.path, '客户自装的 openclaw 绝不能被选中');
  }
  if (report.kernel.foreign.length > 0) {
    assert.ok(
      report.warnings.some((w) => w.includes('openclaw')),
      '探到系统里另有 openclaw 就必须在 warnings 里说清楚，否则客户永远不知道机器上有两份',
    );
  }
});

test('探测对同一台机器是幂等的 —— 只读动作跑两遍结果一致', async () => {
  const first = await probeRuntime({ usbRoot: USB, portableDir: PORTABLE_DIR });
  const second = await probeRuntime({ usbRoot: USB, portableDir: PORTABLE_DIR });
  assert.deepEqual(first.paths, second.paths);
  assert.equal(first.ready, second.ready);
  assert.equal(first.nextAction, second.nextAction);
});

test('nextAction 只在这四种取值里，供启动脚本分支', async () => {
  const report = await probeRuntime({ usbRoot: USB, portableDir: PORTABLE_DIR });
  assert.ok(['ready', 'seed', 'download', 'blocked'].includes(report.nextAction));
  assert.equal(report.ready, report.nextAction === 'ready');
});

test('本机不可写时判为 blocked，让调用方降级而不是报错退出', async () => {
  const report = await probeRuntime({
    usbRoot: USB,
    portableDir: PORTABLE_DIR,
    platform: 'win32',
    arch: 'x64',
    env: { LOCALAPPDATA: 'Z:\\no\\such\\volume', PATH: '' },
  });
  assert.equal(report.ok, true, '探测本身不许抛');
  assert.equal(report.host.writable, false);
  assert.ok(report.warnings.some((w) => w.includes('降级回落')));
});

test('内核候选目录按锁定版本命名', () => {
  const p = winPaths();
  assert.equal(kernelRoot(p, '2026.7.1-2'), join(p.kernelsDir, '2026.7.1-2'));
});
