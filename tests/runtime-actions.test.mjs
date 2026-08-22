// runtime-actions.test.mjs — runtime.* 五个动作的契约测试
//
// kernel-manager.test.mjs / runtime-probe.test.mjs 已经把**底层**测透了（离线 seed 真解压、
// 版本回退、gc 保留策略）。这里只测**动作层**该负责的那部分，不重复那些用例：
//   - 五个动作确实注册进了同一个注册表（宪法 #13：业务动作只实现一次）
//   - 失败路径给的是稳定错误码，不是随机 INTERNAL_ERROR —— 远程排障靠这个判读
//   - runtime.seed 缺离线包时**明确失败**，绝不偷偷回落到下载（否则"零网络依赖"就是空话）
//   - dry-run 真的不动盘
//   - 结果信封里的路径/版本没被脱敏层吞掉
//
// 全部在临时目录里跑，LOCALAPPDATA 也指向临时目录 —— 不碰这台机器上真实的
// %LOCALAPPDATA%\U-Claw（宪法 #10）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { execute, getAction, ACTIONS } from '../portable/lib/core/index.mjs';
import { resolveRuntimePaths } from '../portable/lib/runtime-paths.mjs';

const PORTABLE_DIR = fileURLToPath(new URL('../portable', import.meta.url));
const PINNED = '2026.7.1-2';
const NODE_VERSION = '22.22.1';
const RUNTIME_IDS = ['runtime.probe', 'runtime.seed', 'runtime.install', 'runtime.activate', 'runtime.gc'];

const NO_NETWORK = () => { throw new Error('测试禁止联网'); };

function makeChannel() {
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
  };
}

/** 造一棵结构真实的最小内核树。 */
function writeKernelTree(root, version) {
  const packageRoot = join(root, 'node_modules', 'openclaw');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'openclaw', version, bin: { openclaw: 'openclaw.mjs' }, engines: { node: '>=22.14.0' },
  }));
  writeFileSync(join(packageRoot, 'openclaw.mjs'), '#!/usr/bin/env node\n');
  return root;
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'uclaw-runtime-action-'));
  const usbRoot = join(base, 'usb');
  mkdirSync(join(usbRoot, 'vendor'), { recursive: true });
  const paths = resolveRuntimePaths({
    usbRoot, platform: 'win32', arch: 'x64', nodeVersion: NODE_VERSION,
    env: { LOCALAPPDATA: join(base, 'host') },
  });
  mkdirSync(paths.kernelsDir, { recursive: true });
  mkdirSync(paths.runtimeDir, { recursive: true });

  // ctx.paths 是影核既有形状（core/paths.mjs），ctx.runtime 是 v3 三层路径的注入点
  const ctx = {
    paths: { root: usbRoot, home: join(usbRoot, 'data'), stateDir: paths.stateDir, configPath: paths.configFile, logsDir: paths.logsDir },
    runtime: { paths, channel: makeChannel(), platform: process.platform, fetchImpl: NO_NETWORK },
    log: false,
  };
  return { base, usbRoot, paths, ctx, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const run = (id, input, ctx) => execute(getAction(id), input, ctx);

// ── 注册 ────────────────────────────────────────────────────────────────────

test('五个 runtime 动作都在同一个注册表里，且没有和 gateway.* 撞车', () => {
  const ids = ACTIONS.map((a) => a.id);
  for (const id of RUNTIME_IDS) assert.ok(ids.includes(id), `${id} 没注册进动作核心`);
  // 计划里自拟过 runtime.start/stop，和已有的 gateway.start/stop 撞了，已按对齐表删掉。
  assert.equal(ids.includes('runtime.start'), false, 'runtime.start 不该存在，网关生命周期归 gateway.*');
  assert.equal(ids.includes('runtime.stop'), false, 'runtime.stop 不该存在，网关生命周期归 gateway.*');
});

test('装类动作声明了足够长的超时 —— 首装解压 + npm 装 58 个依赖不是秒级的事', () => {
  assert.ok(getAction('runtime.seed').execution.timeout_ms >= 300000);
  assert.ok(getAction('runtime.install').execution.timeout_ms >= 600000);
});

// ── runtime.seed：断网承诺 ──────────────────────────────────────────────────

test('缺离线包时 runtime.seed 明确失败，绝不偷偷去下载', async () => {
  const { ctx, paths, cleanup } = setup();
  try {
    const result = await run('runtime.seed', {}, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SEED_MISSING');
    // 报错必须指名缺的是哪个文件，客户/远程运维照着找就行
    assert.ok(result.error.message.includes('vendor'), `报错没指出 vendor 路径：${result.error.message}`);
    // 失败不该留下半成品
    assert.equal(existsSync(join(paths.kernelsDir, PINNED)), false);
  } finally {
    cleanup();
  }
});

test('内核已装好时 runtime.seed 直接复用，不要求 U 盘上还留着离线包', async () => {
  const { ctx, paths, cleanup } = setup();
  try {
    // Node 已装（造出 node.exe + npm-cli.js 即视为已装）
    mkdirSync(join(paths.nodeHome, 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(paths.nodeHome, 'node.exe'), '');
    writeFileSync(join(paths.nodeHome, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);

    const result = await run('runtime.seed', {}, ctx);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.kernel.version, PINNED);
    assert.equal(result.data.kernel.reused, true);
    assert.equal(result.data.activated, false, 'seed 不负责切激活指针，那是 runtime.activate 的事');
  } finally {
    cleanup();
  }
});

test('runtime.seed --dry-run 不建目录、不装东西', async () => {
  const { ctx, paths, cleanup } = setup();
  try {
    writeFileSync(join(paths.vendorDir, `node-v${NODE_VERSION}-win-x64.zip`), 'not-a-real-zip');
    writeFileSync(join(paths.vendorDir, `openclaw-${PINNED}-${paths.target}.zip`), 'not-a-real-zip');

    const result = await run('runtime.seed', {}, { ...ctx, dryRun: true });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.activated, false);
    assert.equal(existsSync(join(paths.kernelsDir, PINNED)), false, 'dry-run 不许真装');
    assert.equal(existsSync(paths.nodeHome), false, 'dry-run 不许真解压 Node');
  } finally {
    cleanup();
  }
});

// ── runtime.activate ────────────────────────────────────────────────────────

test('激活一个没装的版本要失败，且不写坏激活指针', async () => {
  const { ctx, paths, cleanup } = setup();
  try {
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);
    const ok = await run('runtime.activate', { version: PINNED }, ctx);
    assert.equal(ok.ok, true, JSON.stringify(ok.error));

    const bad = await run('runtime.activate', { version: '2026.9.99' }, ctx);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'ACTIVATE_FAILED');

    // 指针还停在原来那版 —— 验不过就不写，这是 kernel-manager 的约定，动作层不能绕过
    const state = JSON.parse(readFileSync(paths.activeKernelFile, 'utf8'));
    assert.equal(state.version, PINNED);
  } finally {
    cleanup();
  }
});

test('没有上一版时回退给的是 NO_ROLLBACK_TARGET，不是内部错误', async () => {
  const { ctx, paths, cleanup } = setup();
  try {
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);
    await run('runtime.activate', { version: PINNED }, ctx);

    const result = await run('runtime.activate', { rollback: true }, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NO_ROLLBACK_TARGET');
  } finally {
    cleanup();
  }
});

test('回退切回上一版 —— 新内核起不来时不用重装', async () => {
  const { ctx, paths, cleanup } = setup();
  try {
    const older = '2026.6.34';
    writeKernelTree(join(paths.kernelsDir, older), older);
    writeKernelTree(join(paths.kernelsDir, PINNED), PINNED);
    await run('runtime.activate', { version: older }, ctx);
    await run('runtime.activate', { version: PINNED }, ctx);

    const result = await run('runtime.activate', { rollback: true }, ctx);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.version, older);
    assert.equal(result.data.rolled_back, true);
  } finally {
    cleanup();
  }
});

// ── runtime.gc ──────────────────────────────────────────────────────────────

test('gc 保留 当前/上一版/锁定版，只清没人指向的旧树', async () => {
  const { ctx, paths, cleanup } = setup();
  try {
    const older = '2026.6.34';
    const ancient = '2026.5.7';
    for (const v of [ancient, older, PINNED]) writeKernelTree(join(paths.kernelsDir, v), v);
    await run('runtime.activate', { version: older }, ctx);
    await run('runtime.activate', { version: PINNED }, ctx);   // previous = older

    const preview = await run('runtime.gc', {}, { ...ctx, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview.error));
    assert.equal(preview.data.dry_run, true);
    assert.deepEqual(preview.data.removed.map((e) => e.version), [ancient]);
    assert.equal(existsSync(join(paths.kernelsDir, ancient)), true, 'dry-run 不许真删');

    const done = await run('runtime.gc', {}, ctx);
    assert.equal(done.ok, true, JSON.stringify(done.error));
    assert.equal(existsSync(join(paths.kernelsDir, ancient)), false);
    assert.equal(existsSync(join(paths.kernelsDir, older)), true, '上一版要留着给回退用');
    assert.equal(existsSync(join(paths.kernelsDir, PINNED)), true);
    assert.ok(done.data.freed_bytes > 0, '删了东西就该报出释放了多少');
  } finally {
    cleanup();
  }
});

test('gc 是破坏性动作，但不能声明 confirmation:never —— 启动时顺手清理也不该卡确认', () => {
  const gc = getAction('runtime.gc');
  assert.equal(gc.effects.class, 'destructive');
  assert.equal(gc.effects.confirmation, 'conditional');
});

// ── CLI 参数与全局标志的冲突 ────────────────────────────────────────────────

test('runtime.activate --version 是动作参数，不能被全局 --version 吞掉', () => {
  // 2026-08-22 真机撞到：`uclaw runtime.activate --version 2026.7.1-2` 只打印了一行
  // 内核版本号就退出，动作压根没跑 —— uclaw.mjs 把 version 列进保留标志，
  // 于是任何输入里叫 version 的动作都收不到值。这类失败最难查：退出码 0、有输出、
  // 看起来像成功。
  const home = mkdtempSync(join(tmpdir(), 'uclaw-cli-'));
  try {
    const cli = fileURLToPath(new URL('../portable/uclaw.mjs', import.meta.url));
    const env = { ...process.env, OPENCLAW_HOME: home, LOCALAPPDATA: home };

    const acted = spawnSync(process.execPath, [cli, 'runtime.activate', '--version', '2026.9.99', '--json'], { env, encoding: 'utf8' });
    const envelope = JSON.parse(acted.stdout);
    assert.equal(envelope.action_id, 'runtime.activate', '动作没被执行，--version 又被全局标志抢走了');
    assert.equal(envelope.ok, false, '2026.9.99 没装，本就该失败');
    assert.equal(envelope.error.code, 'ACTIVATE_FAILED');

    // 但没给动作时，`uclaw --version` 仍然要是"打印内核版本"
    const bare = spawnSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' });
    assert.equal(bare.status, 0);
    assert.match(bare.stdout.trim(), /^\d{4}\.\d+\.\d+/, `期望内核版本号，实得：${bare.stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── runtime.probe ───────────────────────────────────────────────────────────

test('probe 只读：跑完不在本机留下任何目录', async () => {
  const { base, usbRoot, cleanup } = setup();
  try {
    // 通道文件从仓库真件拷 —— 假的通道测不出"版本从 OPENCLAW_VERSION 读"这条
    mkdirSync(join(usbRoot, 'config'), { recursive: true });
    writeFileSync(join(usbRoot, 'config', 'runtime-channel.json'), readFileSync(join(PORTABLE_DIR, 'config', 'runtime-channel.json')));
    writeFileSync(join(usbRoot, 'OPENCLAW_VERSION'), readFileSync(join(PORTABLE_DIR, 'OPENCLAW_VERSION')));

    const hostRoot = join(base, 'probe-host');
    const result = await run('runtime.probe', {}, {
      paths: { root: usbRoot },
      env: { LOCALAPPDATA: hostRoot, PATH: '' },
      log: false,
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.ok(['ready', 'seed', 'download', 'blocked'].includes(result.data.next_action));
    assert.equal(result.data.ready, false, '空盘上不该报就绪');
    assert.equal(existsSync(join(hostRoot, 'U-Claw', 'shared')), false, '探测是只读动作，不许建目录');
  } finally {
    cleanup();
  }
});

test('脱敏层不许把重复引用当成环 —— probe 的 chosen 同时也在 candidates 里', async () => {
  const { base, usbRoot, cleanup } = setup();
  try {
    mkdirSync(join(usbRoot, 'config'), { recursive: true });
    writeFileSync(join(usbRoot, 'config', 'runtime-channel.json'), readFileSync(join(PORTABLE_DIR, 'config', 'runtime-channel.json')));
    writeFileSync(join(usbRoot, 'OPENCLAW_VERSION'), readFileSync(join(PORTABLE_DIR, 'OPENCLAW_VERSION')));

    const result = await run('runtime.probe', {}, {
      paths: { root: usbRoot },
      // 用本进程的 Node 当系统候选，保证 candidates 里至少有一项且会被 chosen 复用
      env: { LOCALAPPDATA: join(base, 'probe-host2'), PATH: '' },
      log: false,
    });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    for (const c of result.data.node.candidates) {
      assert.notEqual(c, '[Circular]', '候选被脱敏层吞了：同一对象出现两次不等于循环引用');
    }
  } finally {
    cleanup();
  }
});
