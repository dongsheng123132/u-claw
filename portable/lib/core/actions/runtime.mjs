// runtime.mjs（actions/）—— Node 与 OpenClaw 内核本身的生命周期动作
//
// 注意区分两组动作，它们管的不是一回事（开发计划 §6.2 对齐表）：
//   gateway.start / gateway.stop  —— 网关**进程**的起停，已有实现，不动
//   runtime.probe / seed / install / activate / gc —— **Node 和内核**装在哪、用哪份
//
// 这一层是薄壳：真正的逻辑在 lib/runtime-probe.mjs 和 lib/kernel-manager.mjs 里，
// 它们本来就是无界面、零依赖、可测的。这里只做三件事：
//   1. 把它们注册进同一个动作注册表，让 CLI / GUI / 启动器 / MCP 走同一个入口
//      （宪法 #13：业务动作只实现一次）
//   2. 声明契约（input/output schema、effects、execution），受影核运行时统一管辖
//   3. 把 kernel-manager 的 {phase} 进度翻译成动作层的百分比进度
// 绝不在这里复制一份安装/探测逻辑 —— 那正是宪法 #8 说的漂移。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineAction, ActionError } from '../runtime.mjs';
import { loadChannel } from '../../runtime-channel.mjs';
import { resolveRuntimePaths, prepareHostDirs } from '../../runtime-paths.mjs';
import { createKernelManager } from '../../kernel-manager.mjs';
import { probeRuntime } from '../../runtime-probe.mjs';

// 便携版布局里 U 盘根 == portable 根（本仓库就是 U 盘内容本身，见 CLAUDE.md）。
// 测试和特殊部署可以用 --usb-root 覆盖。
function usbRootOf(input, ctx) {
  return input.usb_root || ctx.paths?.root || process.cwd();
}

/**
 * 组装 kernel-manager 需要的 {paths, channel}。
 * ctx.runtime 是测试注入点（{paths, channel, fetchImpl, runner, platform}），
 * 生产路径上没人传，一律从 U 盘根 + 版本通道现算。
 */
function runtimeContext(input, ctx) {
  if (ctx.runtime?.paths && ctx.runtime?.channel) return ctx.runtime;

  const usbRoot = usbRootOf(input, ctx);
  const platform = ctx.runtime?.platform || process.platform;
  const arch = ctx.runtime?.arch || process.arch;
  const bootstrap = resolveRuntimePaths({ usbRoot, platform, arch, env: ctx.env || process.env });

  let channel;
  try {
    channel = loadChannel({ portableDir: usbRoot, target: bootstrap.target });
  } catch (error) {
    throw new ActionError('CHANNEL_UNREADABLE', error?.message || String(error));
  }

  const paths = resolveRuntimePaths({
    usbRoot, platform, arch, env: ctx.env || process.env, nodeVersion: channel.node.version,
  });
  return { paths, channel, platform, fetchImpl: ctx.runtime?.fetchImpl, runner: ctx.runtime?.runner };
}

function makeManager(rt, overrides = {}) {
  return createKernelManager({
    paths: rt.paths,
    channel: rt.channel,
    platform: rt.platform || process.platform,
    ...(rt.fetchImpl ? { fetchImpl: rt.fetchImpl } : {}),
    ...(rt.runner ? { runner: rt.runner } : {}),
    ...overrides,
  });
}

// kernel-manager 报的是阶段名，用户要看的是"还要多久"。这张表只影响观感，
// 报错和结果都不依赖它。
const PHASE_PCT = {
  'seeding-node': 20,
  'downloading-node': 25,
  'extracting-node': 45,
  'seeding-kernel': 60,
  'installing-kernel': 70,
};
const PHASE_TEXT = {
  'seeding-node': '从 U 盘离线安装 Node',
  'downloading-node': '下载 Node',
  'extracting-node': '解压 Node',
  'seeding-kernel': '从 U 盘离线安装内核',
  'installing-kernel': '从 registry 安装内核',
};

/**
 * 把 kernel-manager 的 onProgress 接到动作层，顺便在阶段边界处理取消。
 * 说明：kernel-manager 内部的 npm / tar 子进程只认自己的超时，不认 AbortSignal，
 * 所以取消**在阶段边界生效**，不是立刻杀进程。execution.cancellable 声明的就是这个粒度。
 */
function progressBridge(ctx) {
  return (event) => {
    if (ctx.signal?.aborted) throw new ActionError('CANCELLED', '安装已取消');
    const phase = event?.phase;
    if (!phase) return;
    ctx.progress?.(PHASE_PCT[phase] ?? 50, PHASE_TEXT[phase] || phase);
  };
}

const USB_ROOT_PROP = {
  usb_root: { type: 'string', description: 'U 盘根目录；留空=当前 U-Claw 目录' },
};

// ── runtime.probe ───────────────────────────────────────────────────────────

export const runtimeProbe = defineAction({
  id: 'runtime.probe',
  title: '探测运行时',
  description:
    '只读探测这台机器上已有的 Node 与 OpenClaw 内核（本机托管 → U 盘 v2 遗留 → 同门产品 → U 盘 seed → 系统 PATH），' +
    '给出下一步该做什么：ready / seed / download / blocked。不装任何东西、不建目录、不碰客户自己装的 openclaw。',
  tags: ['runtime', 'diagnostics'],
  input_schema: { type: 'object', additionalProperties: false, properties: { ...USB_ROOT_PROP } },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ready: { type: 'boolean' },
      next_action: { enum: ['ready', 'seed', 'download', 'blocked'] },
      platform: { type: 'string' },
      arch: { type: 'string' },
      target: { type: 'string' },
      channel: { type: 'object' },
      paths: { type: 'object' },
      host: { type: 'object' },
      node: { type: 'object' },
      kernel: { type: 'object' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['ready', 'next_action', 'target', 'node', 'kernel', 'warnings'],
  },
  effects: { class: 'read', risk: 'low', reversible: true, confirmation: 'never', audit_required: false },
  execution: { headless: true, idempotent: true, cancellable: false, timeout_ms: 60000, progress_events: false, headless_evidence: 'tests/runtime-actions.test.mjs' },
  async run(input, ctx) {
    const usbRoot = usbRootOf(input, ctx);
    let report;
    try {
      report = await probeRuntime({ usbRoot, portableDir: usbRoot, env: ctx.env || process.env });
    } catch (error) {
      throw new ActionError('PROBE_FAILED', error?.message || String(error));
    }
    return {
      ready: report.ready,
      next_action: report.nextAction,
      platform: report.platform,
      arch: report.arch,
      target: report.target,
      channel: report.channel,
      paths: report.paths,
      host: report.host,
      node: report.node,
      kernel: report.kernel,
      warnings: report.warnings,
    };
  },
});

// ── runtime.seed ────────────────────────────────────────────────────────────

export const runtimeSeed = defineAction({
  id: 'runtime.seed',
  title: '离线安装运行时',
  description:
    '只用 U 盘 vendor/ 里的离线包安装 Node 和内核，全程不联网 —— release note 承诺的"解压即用、零网络依赖"就靠它。' +
    '缺哪个 seed 就明确报错，绝不偷偷回落到下载。装完不切换激活指针，由 runtime.activate 决定。',
  tags: ['runtime', 'offline'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { ...USB_ROOT_PROP, version: { type: 'string', description: '内核版本；留空=OPENCLAW_VERSION 锁定的那个' } },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      node: { type: 'object' },
      kernel: { type: 'object' },
      version: { type: 'string' },
      activated: { type: 'boolean' },
    },
    required: ['node', 'kernel', 'version', 'activated'],
  },
  effects: { class: 'write', risk: 'medium', reversible: true, confirmation: 'never', audit_required: true },
  execution: { headless: true, idempotent: true, cancellable: true, timeout_ms: 600000, progress_events: true, headless_evidence: 'tests/runtime-actions.test.mjs' },
  async run(input, ctx) {
    const rt = runtimeContext(input, ctx);
    const version = input.version || rt.channel.kernel.version;
    const manager = makeManager(rt, {
      // 断网兜底：前面的预检已经保证走不到网络分支，这里再钉一道，
      // 免得哪天 kernel-manager 加了新的回退路径就把承诺悄悄破了。
      fetchImpl: () => { throw new ActionError('NETWORK_FORBIDDEN', 'runtime.seed 不允许联网'); },
    });

    // 预检：缺 seed 就早失败，并且告诉用户缺的是哪个文件。
    const status = await manager.status();
    const nodeArchive = rt.channel.node.target?.archive;
    if (!status.nodeReady && !(nodeArchive && existsSync(join(rt.paths.vendorDir, nodeArchive)))) {
      throw new ActionError('SEED_MISSING', `U 盘上没有 Node 离线包：${join(rt.paths.vendorDir, nodeArchive || '(通道未声明目标)')}`);
    }
    let kernelInstalled = true;
    try { await manager.resolveKernel(version); } catch { kernelInstalled = false; }
    if (!kernelInstalled && !manager._internal.kernelSeedArchive(version)) {
      throw new ActionError('SEED_MISSING', `U 盘上没有内核离线包：${join(rt.paths.vendorDir, `openclaw-${version}-${rt.paths.target}.{zip,tar.gz}`)}`);
    }

    if (ctx.dryRun) {
      return { node: { source: 'usb-seed', dry_run: true }, kernel: { version, source: 'usb-seed', dry_run: true }, version, activated: false };
    }

    const host = prepareHostDirs(rt.paths);
    if (!host.ok) throw new ActionError('HOST_NOT_WRITABLE', `本机缓存根不可写（${host.root}）：${host.error}`);

    const onProgress = progressBridge(ctx);
    ctx.progress?.(5, '检查离线包');
    const node = await manager.ensureNode(onProgress);
    const kernel = await manager.installKernel(version, onProgress);
    ctx.progress?.(100, '离线安装完成');
    return {
      node: { source: node.source, reused: !!node.reused, path: node.nodeExecutable },
      kernel: { version: kernel.version, source: kernel.source, reused: !!kernel.reused, root: kernel.root, entry: kernel.entry },
      version,
      activated: false,
    };
  },
});

// ── runtime.install ─────────────────────────────────────────────────────────

export const runtimeInstall = defineAction({
  id: 'runtime.install',
  title: '安装运行时',
  description:
    '保证本机有可用的 Node 和内核。顺序固定：已装 → U 盘离线 seed → 网络（镜像回退）。' +
    '全程"临时目录 → 校验 → 原子改名"，装坏了不会污染正在用的那份。默认装完切换激活指针。',
  tags: ['runtime'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...USB_ROOT_PROP,
      version: { type: 'string', description: '内核版本；留空=OPENCLAW_VERSION 锁定的那个' },
      activate: { type: 'boolean', description: '装完是否切换激活指针，默认 true' },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      node: { type: 'object' },
      kernel: { type: 'object' },
      version: { type: 'string' },
      previous: { type: ['string', 'null'] },
      activated: { type: 'boolean' },
    },
    required: ['node', 'kernel', 'version', 'activated'],
  },
  // class:external —— 可能走网络。装的是本机缓存，可回退，所以不是 destructive。
  effects: { class: 'external', risk: 'medium', reversible: true, confirmation: 'never', audit_required: true },
  execution: { headless: true, idempotent: true, cancellable: true, timeout_ms: 900000, progress_events: true, headless_evidence: 'tests/runtime-actions.test.mjs' },
  async run(input, ctx) {
    const rt = runtimeContext(input, ctx);
    const version = input.version || rt.channel.kernel.version;
    const shouldActivate = input.activate !== false;

    if (ctx.dryRun) {
      return { node: { dry_run: true }, kernel: { version, dry_run: true }, version, previous: null, activated: false };
    }

    const host = prepareHostDirs(rt.paths);
    if (!host.ok) throw new ActionError('HOST_NOT_WRITABLE', `本机缓存根不可写（${host.root}）：${host.error}`);

    const manager = makeManager(rt);
    const onProgress = progressBridge(ctx);
    const previous = await manager.activeVersion();

    ctx.progress?.(5, '准备 Node');
    const node = await manager.ensureNode(onProgress);
    const kernel = await manager.installKernel(version, onProgress);

    let activated = false;
    if (shouldActivate) {
      ctx.progress?.(95, '切换激活版本');
      await manager.activate(version, { source: kernel.source });
      activated = true;
    }
    ctx.progress?.(100, '安装完成');
    return {
      node: { source: node.source, reused: !!node.reused, path: node.nodeExecutable },
      kernel: { version: kernel.version, source: kernel.source, reused: !!kernel.reused, root: kernel.root, entry: kernel.entry },
      version,
      previous,
      activated,
    };
  },
});

// ── runtime.activate ────────────────────────────────────────────────────────

export const runtimeActivate = defineAction({
  id: 'runtime.activate',
  title: '切换内核版本',
  description:
    '把激活指针指向某个已安装的内核版本；切之前先验证那份树真的能用，验不过就不写指针。' +
    'rollback=true 则回退到上一版 —— 新内核起不来时不需要重装，旧版本还在盘上。',
  tags: ['runtime'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...USB_ROOT_PROP,
      version: { type: 'string', description: '要激活的版本；rollback=true 时忽略' },
      rollback: { type: 'boolean', description: '回退到上一版' },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'string' },
      previous: { type: ['string', 'null'] },
      root: { type: 'string' },
      entry: { type: 'string' },
      rolled_back: { type: 'boolean' },
    },
    required: ['version', 'rolled_back'],
  },
  effects: { class: 'write', risk: 'medium', reversible: true, confirmation: 'never', audit_required: true },
  execution: { headless: true, idempotent: true, cancellable: false, timeout_ms: 30000, progress_events: false, headless_evidence: 'tests/runtime-actions.test.mjs' },
  async run(input, ctx) {
    const rt = runtimeContext(input, ctx);
    const manager = makeManager(rt);
    const rollback = input.rollback === true;
    const version = rollback ? null : (input.version || rt.channel.kernel.version);

    if (ctx.dryRun) {
      return { version: version || '(上一版)', previous: await manager.activeVersion(), root: '', entry: '', rolled_back: rollback };
    }

    try {
      const result = rollback ? await manager.rollback() : await manager.activate(version, { source: 'manual' });
      return {
        version: result.version,
        previous: result.previous ?? null,
        root: result.root,
        entry: result.entry,
        rolled_back: rollback,
      };
    } catch (error) {
      throw new ActionError(rollback ? 'NO_ROLLBACK_TARGET' : 'ACTIVATE_FAILED', error?.message || String(error));
    }
  },
});

// ── runtime.gc ──────────────────────────────────────────────────────────────

export const runtimeGc = defineAction({
  id: 'runtime.gc',
  title: '清理旧内核',
  description:
    '删掉本机上不再需要的旧内核，保留：当前激活的、上一版（回退要用）、通道锁定的。' +
    '每台插过 U 盘的电脑会留约 1 GB，不给清理入口就是在慢慢塞满客户的 C 盘。--dry-run 只报不删。',
  tags: ['runtime', 'maintenance'],
  input_schema: { type: 'object', additionalProperties: false, properties: { ...USB_ROOT_PROP } },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kept: { type: 'array', items: { type: 'string' } },
      removed: { type: 'array', items: { type: 'object' } },
      freed_bytes: { type: 'number' },
      dry_run: { type: 'boolean' },
    },
    required: ['kept', 'removed', 'freed_bytes', 'dry_run'],
  },
  // 删目录属破坏性动作，不能声明 confirmation:'never'。用 conditional：
  // 安全边界由动作自己守 —— 当前版/上一版/锁定版一律不动，删的只可能是没人指向的旧树。
  // 这个判定比弹窗更硬，也让"启动时顺手 gc 一次"不至于卡在确认上（同 lock.clean）。
  effects: { class: 'destructive', risk: 'low', reversible: false, confirmation: 'conditional', audit_required: true },
  execution: { headless: true, idempotent: true, cancellable: false, timeout_ms: 120000, progress_events: false, headless_evidence: 'tests/runtime-actions.test.mjs' },
  async run(input, ctx) {
    const rt = runtimeContext(input, ctx);
    const manager = makeManager(rt);
    const result = await manager.gc({ dryRun: !!ctx.dryRun });
    return {
      kept: result.kept,
      removed: result.removed,
      freed_bytes: result.removed.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
      dry_run: !!result.dryRun,
    };
  },
});

export default [runtimeProbe, runtimeSeed, runtimeInstall, runtimeActivate, runtimeGc];
