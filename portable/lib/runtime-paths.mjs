// runtime-paths.mjs — v3 瘦壳架构的状态边界，落成代码
//
// 开发计划 §2 那张三分表就是这个文件。v2 的根本病是运行时住在 U 盘上：
// node_modules 几万个小文件在 U 盘上随机读写，慢、易坏、还逼客户把 U 盘格成 NTFS。
// v3 把状态按"能不能重建、该不该跟着人走"切成三层：
//
//   ┌ 第 1 层 · 随盘走 ────────────────── <usbRoot>/data/
//   │   openclaw.json、会话、memory、Skills、设备钱包五字段、TaskPassport
//   │   换机器要带走的就这些，全是小文件，U 盘扛得住
//   │
//   ├ 第 2 层 · 本机共享、可重建 ──────── <hostRoot>/shared/
//   │   Node、各版本 OpenClaw 内核、npm 缓存、下载暂存
//   │   按机器共享：同一台机插第二支 U 盘不重下（这是首启提速的主要来源）
//   │
//   └ 第 3 层 · 本机、按盘隔离 ────────── <hostRoot>/<slot16>/
//       浏览器 user-data、V8 编译缓存、日志、锁
//       既不随盘走也不跨盘共享。锁要是共享了，"gateway already running (pid XXXX)"
//       就会换个马甲回来 —— 一台机插两支 U 盘、一支 U 盘插两台机都是真实场景。
//
// 第 3 层 portable-cache.mjs 已经做了（UUID 隔离，换盘符仍命中同一份），这里复用它的
// 槽位算法，不重算。本文件新增的是第 2 层。
//
// 兼容性：第 3 层沿用既有的 <hostRoot>/<slot16>/ 布局，不改成 slots/<slot16>/。
// 改了等于把已经装过 U-Claw 的机器上的缓存全变成孤儿，客户下次启动白热身一次（宪法 10）。
// "shared" 不是 16 位 hex，和槽位目录名不会撞。

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { resolveCacheSlot, systemCacheRoot } from './portable-cache.mjs';

const PRODUCT_DIR = 'U-Claw';

// Node 官方压缩包的目标名。archive 的解压目录名也按这个拼，别自己造。
export function resolveTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  return `${platform}-${arch}`;
}

/**
 * 解析三层路径。纯计算 —— 不建目录、不写文件（唯一例外是槽位 UUID，
 * 由 portable-cache 在 stateDir 里读/建，那是它既有的行为）。
 *
 * 要建目录请显式调 prepareHostDirs()。探测路径上不该有副作用：
 * runtime.probe 是只读动作，跑一次不该在客户机上留下一堆空目录。
 */
export function resolveRuntimePaths({
  usbRoot,
  nodeVersion,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const target = resolveTarget(platform, arch);
  const root = String(usbRoot || '');

  // ── 第 1 层：U 盘 ──────────────────────────────────────────
  const dataDir = join(root, 'data');
  const stateDir = join(dataDir, '.openclaw');           // OPENCLAW_STATE_DIR
  const uclawStateDir = join(dataDir, 'uclaw-state');    // v3 自己的状态，不混进 OpenClaw 的目录
  const vendorDir = join(root, 'vendor');                // 离线 seed

  // ── 第 2、3 层：本机 ───────────────────────────────────────
  const { cacheId, slot } = resolveCacheSlot({ stateDir, usbRoot: root });
  const hostRoot = join(systemCacheRoot(platform, env), PRODUCT_DIR);
  const sharedDir = join(hostRoot, 'shared');
  const slotDir = join(hostRoot, slot);

  const runtimeDir = join(sharedDir, 'runtime');
  const kernelsDir = join(sharedDir, 'kernels', 'openclaw');

  return {
    target,
    cacheId,
    slot,

    // 第 1 层 —— 随盘走
    usbRoot: root,
    dataDir,
    stateDir,
    configFile: join(stateDir, 'openclaw.json'),
    uclawStateDir,
    walletFile: join(uclawStateDir, 'device-wallet.json'),
    settingsFile: join(uclawStateDir, 'uclaw-settings.json'),
    vendorDir,
    vendorChecksums: join(vendorDir, 'SHA256SUMS'),

    // 第 2 层 —— 本机共享、可重建
    hostRoot,
    sharedDir,
    runtimeDir,
    nodeHome: nodeVersion ? join(runtimeDir, `node-v${nodeVersion}-${target}`) : null,
    kernelsDir,
    npmCacheDir: join(sharedDir, 'npm-cache'),
    downloadsDir: join(sharedDir, 'downloads'),
    activeKernelFile: join(sharedDir, 'active.json'),

    // 第 3 层 —— 本机、按盘隔离
    slotDir,
    browserDir: join(slotDir, 'browser'),
    compileCacheDir: join(slotDir, 'node-compile-cache'),
    logsDir: join(slotDir, 'logs'),
    locksDir: join(slotDir, 'locks'),

    // v2 遗留布局 —— 运行时曾经住在 U 盘上。仍然认它，别让老 U 盘一升级就跑不起来。
    legacy: {
      nodeHome: join(root, 'app', 'runtime', `node-${target}`),
      kernelRoot: join(root, 'app', 'core'),
      kernelPackage: join(root, 'app', 'core', 'node_modules', 'openclaw'),
    },
  };
}

/** 内核某个版本的安装根（npm 工程根，openclaw 在其 node_modules 下）。 */
export function kernelRoot(paths, version) {
  return join(paths.kernelsDir, version);
}

/**
 * 建本机目录。返回 { ok, root } —— ok=false 表示本机根不可写
 * （组策略限制、漫游配置文件同步都会造成），调用方必须降级回落 U 盘运行，
 * 不许直接启动失败（开发计划 §3 空间治理最后一条）。
 */
export function prepareHostDirs(paths) {
  const dirs = [
    paths.sharedDir, paths.runtimeDir, paths.kernelsDir,
    paths.npmCacheDir, paths.downloadsDir,
    paths.slotDir, paths.browserDir, paths.compileCacheDir, paths.logsDir, paths.locksDir,
  ];
  try {
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    return { ok: true, root: paths.hostRoot };
  } catch (error) {
    return { ok: false, root: paths.hostRoot, error: error?.message || String(error) };
  }
}
