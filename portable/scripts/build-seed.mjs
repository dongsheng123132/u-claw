#!/usr/bin/env node
// build-seed.mjs —— 产 vendor/ 离线 seed 的唯一工具（本地和 CI 共用）
//
// v3 把 Node 和 OpenClaw 内核装到本机，U 盘只留 vendor/ 里的离线 seed
// （见 portable/lib/kernel-manager.mjs 的顺序：已装 → U 盘 seed → 网络）。
// seed 从哪来不能各写一份 —— CI 一份、本地临时脚本一份，两边迟早对不上
// （宪法第 8 条：同一事实存几份就漂几份）。这个脚本就是那个唯一来源。
//
// 产物：
//   portable/vendor/node-v<版本>-<target>.zip|tar.gz  —— Node 官方原包，字节对齐 nodejs.org
//   portable/vendor/openclaw-<版本>-<target>.tar.gz    —— 装好的整棵树（node_modules/ 在包根）
//   portable/vendor/SHA256SUMS                          —— 两者的校验和
//
// 四处刻意的设计，理由写在各自函数头部：
//   1. Node 包必须逐字节校验 SHA256 —— 客户端是断网首启时解这个包，那时校验失败无网可救。
//   2. 内核打的是"装好的整棵树"而不是 npm tarball —— openclaw 有 58 个依赖，
//      npm pack 出来的 tarball 不含依赖，装它照样要联网，等于没做离线 seed。
//   3. Windows 打 tar.gz 必须点名 System32 的 bsdtar（tarBinary()）—— PATH 上的
//      GNU tar 把 `C:\` 当远程主机名，会报 "Cannot connect to C:"。
//   4. 打包前必须 prune 掉 PRUNE_DIRS 里点名的大体积原生依赖目录 —— 照搬
//      .github/workflows/release.yml 里已经踩过的坑（见该文件 "Note: do not
//      pre-install..." 那段注释），否则 seed 会比 v2 整个便携包（150-200MB）
//      还大一倍多，直接把"U 盘装得下、下得动"这个前提破了。
//
// TODO（本次未处理）：微信插件 @tencent-weixin/openclaw-weixin 现在装到
// app/extensions/，不是内核树的一部分，seed 里不含它——release.yml 另有独立步骤。
//
// 契约（宪法第 14 条，写法对齐 portable/uclaw.mjs）：
//   stdout 只出结果，stderr 出日志/进度；非 TTY 不带颜色。
//   退出码：0 成功 / 1 运行失败 / 2 用法错误。

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadChannel } from '../lib/runtime-channel.mjs';
import { resolveTarget } from '../lib/runtime-paths.mjs';
import { tarBinary } from '../lib/kernel-manager.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORTABLE_DIR = path.join(SCRIPT_DIR, '..');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const isTTY = process.stderr.isTTY === true;
const C = isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', off: '' };

/** 日志一律走 stderr —— stdout 留给最终结果（宪法第 14 条 CLI 契约）。 */
function log(message) {
  process.stderr.write(`${message}\n`);
}

class BuildError extends Error {}
class UsageError extends Error {}

// ── 国内渠道插件（额外一项，尽力而为）──────────────────────────────────────
// 与 .github/workflows/release.yml 里预装的一致：QQ 官方渠道 + 三个非官方
// openclaw-china 生态包（钉钉/飞书中国版/企业微信）。单个装不上只 warning，
// 不阻断整个 seed 构建——个别包偶发 404 不该让离线包整体报废。
const CHANNEL_PLUGINS = [
  '@sliverp/qqbot',
  '@openclaw-china/dingtalk',
  '@openclaw-china/feishu-china',
  '@openclaw-china/wecom',
  '@openclaw-china/qqbot',
];

// ── 打包前必须 prune 的大体积目录 ───────────────────────────────────────────
// 唯一真相源：以后 release.yml 会改成直接调这个脚本，那时它自己那份
// （"7) Belt-and-suspenders" 那段 find + prune）要删掉，改认这里。
//
// 只列这两个，别自作主张多删——playwright-core / sharp / sqlite-vec-windows-x64
// 这类原生依赖 v2 的流水线也留着，砍掉是产品决策（少功能），不是这个脚本能替
// 用户做的"优化"。
const PRUNE_DIRS = [
  // openclaw 的 bundled runtime deps 里，clawdbot（本地 LLM 推理通道）拖进
  // node-llama-cpp，它自带预编译的 llama.cpp 二进制（CPU/CUDA/Metal 各一份），
  // 单这一个包解压后就有 701MB —— release.yml 的注释把这事记死了：第一次预装
  // bundled deps时 zip 从 153MB 涨到 540MB，就是它干的。
  // 删掉之后失去的功能：客户不能在断网、零配置的情况下用"本地跑的 LLM"
  // （clawdbot 本地推理通道）；但客户机原本也没有能跑大模型的 GPU/内存预期，
  // 这条通道本来就要求用户自己另外装（见 lib/setup-local-model.mjs），
  // 不是开箱可用的功能，删掉不影响"开箱即用"的其它渠道（QQ/钉钉/飞书/企业微信）。
  '@node-llama-cpp',
  'node-llama-cpp',
];

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 把 "22" / "22.23" / "v22.23.2" 都补成 [22,23,2]。缺位补 0。 */
function parseVersionTriple(value) {
  const m = String(value).trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareTriple(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 极简 semver range 判定：只覆盖 engines.node 实际用到的子集 ——
 * `||` 分隔的若干组，每组是空格分隔的 `>=x` `>x` `<=x` `<x` `=x` 比较符，组内取与、组间取或。
 * 例：">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0"
 *
 * 不引 semver 包：portable/ 全线零依赖，且这里只做一个卡口判定，不是通用实现。
 * 预发布标识（-rc.1）不处理 —— Node LTS 发行版没有，seed 也不该用预发布版。
 */
function satisfiesRange(version, range) {
  const target = parseVersionTriple(version);
  if (!target) return false;
  return String(range).split('||').some((group) => {
    const comparators = group.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((token) => {
      const m = token.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
      if (!m) return false;
      const [, op = '=', raw] = m;
      const bound = parseVersionTriple(raw);
      if (!bound) return false;
      const cmp = compareTriple(target, bound);
      switch (op) {
        case '>=': return cmp >= 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '<': return cmp < 0;
        case '=': return cmp === 0;
        // ^ / ~ 没在 engines.node 里出现过；真出现了宁可判不满足去人工看一眼，
        // 也不要在这里猜出一个错误的"通过"。
        default: return false;
      }
    });
  });
}

function run(command, args, { cwd, timeoutMs = 8 * 60_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`${path.basename(command)} 退出码 ${code ?? 'unknown'}：${(stderr || stdout).slice(-1500)}`));
    });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`${path.basename(command)} 超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成`));
    }, timeoutMs);
  });
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  const handle = await open(filename, 'r');
  try {
    const stream = handle.createReadStream();
    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('end', resolve);
      stream.once('error', reject);
    });
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * 单个 URL 的下载，带超时（宪法第 9 条：凡会卡的网络/IO 一律异步 + 超时）。
 * 写到调用方给的临时路径，成功与否都不在这里做校验或改名——校验/改名交给调用方，
 * 这样"下载成功但哈希不对"和"下载失败"能分开处理、分别决定要不要换源重试。
 */
async function downloadToFile(url, destination, timeoutMs) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${url}`);
  const handle = await open(destination, 'w');
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

/** 临时文件 → 原子改名，绝不让半个产物冒充成品留在 outDir 里。 */
async function moveIntoPlace(temporaryPath, finalPath) {
  await mkdir(path.dirname(finalPath), { recursive: true });
  await rename(temporaryPath, finalPath);
}

// ── Node 官方包（校验和是硬约束）──────────────────────────────────────────

/**
 * 拉 Node 官方压缩包并校验 SHA256。
 *
 * 为什么必须逐字节校验：客户是断网首启时才解这个包（kernel-manager.mjs 的
 * ensureNode() 顺序是 已装 → U 盘 seed → 网络，seed 就是给断网场景兜底的）。
 * 那个时刻校验失败是没有网络可以重下的，所以校验必须在"进 vendor/"之前做完，
 * 校验不过就直接失败退出——绝不把可疑的包留在 vendor/ 冒充能用。
 *
 * 下载顺序：通道里的 node.mirrors（已含国内镜像优先），逐个失败换源；
 * 最后兜底 nodejs.org 官方源（哪怕 mirrors 漏配也不会失去这一步）。
 */
async function ensureNodeSeed({ channel, target, outDir, timeoutMs }) {
  const spec = channel.node.targets?.[target];
  if (!spec) throw new BuildError(`版本通道里没有 ${target} 的 Node 目标`);

  const finalPath = path.join(outDir, spec.archive);
  if (existsSync(finalPath)) {
    const existingHash = await sha256File(finalPath);
    if (existingHash === spec.sha256) {
      log(`${C.dim}[node] 已有文件哈希一致，跳过下载：${finalPath}${C.off}`);
      return { path: finalPath, bytes: (await stat(finalPath)).size, sha256: existingHash, source: 'cached' };
    }
    log(`${C.yellow}[node] 已有文件哈希不符，重新下载${C.off}`);
  }

  const urls = [...channel.node.mirrors.map((mirror) => `${mirror.replace(/\/$/, '')}/v${channel.node.version}/${spec.archive}`)];
  const officialFallback = `https://nodejs.org/dist/v${channel.node.version}/${spec.archive}`;
  if (!urls.includes(officialFallback)) urls.push(officialFallback);

  let lastError;
  for (const url of urls) {
    const temporary = path.join(outDir, `.${spec.archive}.${process.pid}.download`);
    try {
      log(`${C.dim}[node] 下载：${url}${C.off}`);
      await mkdir(outDir, { recursive: true });
      await downloadToFile(url, temporary, timeoutMs);
      const hash = await sha256File(temporary);
      if (hash !== spec.sha256) {
        log(`${C.yellow}[node] SHA256 不符（期望 ${spec.sha256}，实得 ${hash}），换源重试${C.off}`);
        await rm(temporary, { force: true });
        lastError = new Error(`${url} 的 SHA256 不匹配`);
        continue;
      }
      await moveIntoPlace(temporary, finalPath);
      log(`${C.green}[node] 校验通过：${finalPath}${C.off}`);
      return { path: finalPath, bytes: (await stat(finalPath)).size, sha256: hash, source: url };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      lastError = error;
    }
  }
  throw new BuildError(`Node 包所有源均下载/校验失败：${lastError?.message || lastError}`);
}

// ── 内核树（装好的整棵树，不是 npm tarball）─────────────────────────────────

/** 递归量一棵树的字节数与文件数——prune 前后各测一次，用来在 --json 里留证据。 */
async function measureTree(root) {
  let bytes = 0;
  let files = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await stat(full)).size;
        } catch {
          // 文件在测量途中被并发删除之类的极端情况，跳过不算数，不阻断构建。
        }
      }
    }
  }
  await walk(root);
  return { bytes, files };
}

/**
 * 照搬 release.yml 里 `find "$core_dir/node_modules" -maxdepth 3 -type d -name "$big_pat" -prune`
 * 的语义：只在 node_modules 往下最多 3 层里找名字匹配的目录（第 1 层是
 * node_modules 的直接子目录，例如 @scope/ 或某个包名；第 3 层能覆盖到
 * "某包的 node_modules 下再嵌一层"这种常见的依赖提升失败场景）。
 * 命中就整个目录删掉、不再往里递归（对应 find 的 -prune：反正都要删，
 * 没必要白费功夫扫它内部）。
 */
async function pruneKernelTree(nodeModulesRoot, names, maxDepth) {
  const removed = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (names.includes(entry.name)) {
        const measured = await measureTree(full);
        await rm(full, { recursive: true, force: true });
        removed.push({
          name: path.relative(nodeModulesRoot, full).replace(/\\/g, '/'),
          bytes: measured.bytes,
          files: measured.files,
        });
        continue; // -prune：命中的目录不再往里递归
      }
      if (depth < maxDepth) await walk(full, depth + 1);
    }
  }
  await walk(nodeModulesRoot, 1);

  // 收尾：删掉指向已删包的 .bin shim。npm 会给 node-llama-cpp 这类带 bin 的包在
  // node_modules/.bin/ 下生成三个入口（无扩展名 / .cmd / .ps1），包删了 shim 还在，
  // 就成了一跑就报 MODULE_NOT_FOUND 的死链接。字节数可以忽略，但客户机上任何
  // "遍历 .bin 检查完整性" 的工具（含 npm 自己的 doctor）都会因此报错。
  // release.yml 那版 prune 就漏了这一步，v2 至今带着三个死 shim 在发。
  const binDir = path.join(nodeModulesRoot, '.bin');
  for (const name of names) {
    for (const suffix of ['', '.cmd', '.ps1']) {
      const shim = path.join(binDir, `${name}${suffix}`);
      try {
        await rm(shim, { force: true });
      } catch { /* 本来就没有，忽略 */ }
    }
  }
  return removed;
}

/**
 * 定位本机 npm-cli.js。
 *
 * 这不是重新实现"怎么找 npm"——是复用 runtime-channel.json 里已经登记好的
 * 目标平台布局（node.targets[*].npmCliRelativePath）：官方 Node 分发包的
 * "npm-cli.js 相对 node.exe 的路径"是固定的，构建机当前运行的这个 node
 * 只要也是官方标准布局（CI 的 actions/setup-node、开发机的官方安装包都是），
 * 用同一套相对路径就能找到它的 npm，不用另写一份探测逻辑。
 * 找不到就退化到 PATH 上的 npm（Windows 需要 shell:true 因为它是 npm.cmd）。
 */
async function resolveNpmCli(channel) {
  const hostTarget = resolveTarget(process.platform, process.arch);
  const relative = channel.node.targets?.[hostTarget]?.npmCliRelativePath;
  if (relative) {
    const candidate = path.join(path.dirname(process.execPath), relative);
    if (existsSync(candidate)) return { command: process.execPath, prefixArgs: [candidate], viaShell: false };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [], viaShell: process.platform === 'win32' };
}

/**
 * npm install 装好一整棵内核树，再打成 tar.gz。
 *
 * 为什么打整棵树而不是 npm tarball：openclaw 有 58 个依赖 + 原生 sqlite-vec，
 * `npm pack` 出来的 tarball 只有 openclaw 自己的代码，装它到客户机照样要
 * 联网拉依赖——那就完全没有"离线 seed"这回事了。所以这里的产物是
 * "npm install 之后那个完整的临时目录"，压缩包根直接是 node_modules/openclaw/，
 * 因为 kernel-manager.mjs 的 locateRoot() 就是按这条路径去认包根的。
 */
async function ensureKernelSeed({ channel, target, outDir, timeoutMs, tarTimeoutMs, npmCli }) {
  const version = channel.kernel.version;
  const finalPath = path.join(outDir, `openclaw-${version}-${target}.tar.gz`);
  const staging = await mkdtemp(path.join(tmpdir(), 'uclaw-seed-'));
  const pluginsInstalled = [];
  const pluginsFailed = [];
  try {
    await writeFile(
      path.join(staging, 'package.json'),
      `${JSON.stringify({
        name: 'u-claw-kernel-seed',
        version: '0.0.0',
        private: true,
        dependencies: { [channel.kernel.package]: version },
      }, null, 2)}\n`,
      'utf8',
    );

    const registry = channel.kernel.installRegistries[0];
    log(`${C.dim}[kernel] npm install ${channel.kernel.package}@${version}（registry=${registry}）${C.off}`);
    await run(npmCli.command, [...npmCli.prefixArgs, 'install',
      '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', `--registry=${registry}`,
    ], { cwd: staging, timeoutMs, env: { ...process.env, npm_config_update_notifier: 'false' } });

    // 追加安装国内渠道插件——同一棵树、装完主包之后。单个失败只 warning，
    // 不让个别包偶发 404 拖垮整个离线包（release.yml 里同样的策略）。
    for (const pkg of CHANNEL_PLUGINS) {
      log(`${C.dim}[kernel] 安装渠道插件：${pkg}${C.off}`);
      try {
        await run(npmCli.command, [...npmCli.prefixArgs, 'install', `${pkg}@latest`,
          '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${registry}`,
        ], { cwd: staging, timeoutMs, env: { ...process.env, npm_config_update_notifier: 'false' } });
        pluginsInstalled.push(pkg);
      } catch (error) {
        log(`${C.yellow}[kernel] 渠道插件安装失败（跳过，不阻断）：${pkg} —— ${error.message}${C.off}`);
        pluginsFailed.push(pkg);
      }
    }

    // prune：必须在自检和打包**之前**做——照搬 release.yml 的 belt-and-suspenders
    // 那一步（find -maxdepth 3 -prune），删掉 PRUNE_DIRS 里点名的大体积原生依赖
    // 目录。不这么做，内核 tar.gz 会比 v2 整个便携 zip（150-200MB）还大一倍多，
    // 断网首启下这个体积的包中断率会很难看。
    const beforePrune = await measureTree(staging);
    const removed = await pruneKernelTree(path.join(staging, 'node_modules'), PRUNE_DIRS, 3);
    const afterPrune = await measureTree(staging);
    const beforeMb = (beforePrune.bytes / (1024 * 1024)).toFixed(1);
    const afterMb = (afterPrune.bytes / (1024 * 1024)).toFixed(1);
    if (removed.length > 0) {
      log(`${C.dim}[kernel] prune 前 ${beforeMb} MB / ${beforePrune.files} 文件 → prune 后 `
        + `${afterMb} MB / ${afterPrune.files} 文件（删除 ${removed.map((r) => r.name).join(', ')}）${C.off}`);
    } else {
      log(`${C.dim}[kernel] prune：没找到 ${PRUNE_DIRS.join(' / ')}，${beforeMb} MB 保持不变${C.off}`);
    }

    // 自检：解压包不现实（还没打包），但至少断言临时目录里的包身份对得上。
    const manifestPath = path.join(staging, 'node_modules', channel.kernel.package, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw new BuildError(`自检失败：读不到 ${manifestPath}：${error.message}`);
    }
    if (manifest.name !== channel.kernel.package || manifest.version !== version) {
      throw new BuildError(`自检失败：期望 ${channel.kernel.package}@${version}，实际 ${manifest.name}@${manifest.version}`);
    }

    // 自检 2：通道钉的 Node 必须满足**这个版本内核**的 engines.node。
    // 2026-08-22 血的教训：通道钉 22.22.1、minimumVersion 写 22.14.0，seed 装完
    // 网关直接拒启——openclaw 2026.7.1-2 要 >=22.22.3。engines 会随内核升级悄悄收紧，
    // 而 track-upstream.yml 每天自动升 OPENCLAW_VERSION，没有这道卡就是等着某天
    // 发一个"解压即用、但一启动就报 Node 版本不对"的包出去。
    // 装好的树就在手边，这是唯一能拿到真 engines 的时刻，卡就卡在这里。
    const enginesRange = manifest.engines?.node;
    if (!enginesRange) {
      log(`${C.yellow}[kernel] 警告：内核没声明 engines.node，跳过 Node 版本卡口${C.off}`);
    } else {
      for (const [label, candidate] of [['node.version', channel.node.version], ['node.minimumVersion', channel.node.minimumVersion]]) {
        if (!satisfiesRange(candidate, enginesRange)) {
          throw new BuildError(
            `自检失败：runtime-channel.json 的 ${label}=${candidate} 不满足 ` +
            `${manifest.name}@${manifest.version} 的 engines.node（${enginesRange}）。\n` +
            '  改 portable/config/runtime-channel.json 的 node.version / node.minimumVersion，' +
            '并从 nodejs.org 官方 SHASUMS256.txt 换上对应的 sha256。',
          );
        }
      }
      log(`${C.dim}[kernel] Node 版本卡口通过：${channel.node.version} / 最低 ${channel.node.minimumVersion} 满足 ${enginesRange}${C.off}`);
    }

    // 打包：必须用 tarBinary() 点名 System32 的 bsdtar——PATH 上的 GNU tar
    // 把 `C:\Users\...` 里的冒号当成 host:path 分隔符，会报
    // "Cannot connect to C: resolve failed"，这是 v3 已经踩过的坑（见文件头）。
    await mkdir(outDir, { recursive: true });
    const temporaryArchive = path.join(outDir, `.openclaw-${version}-${target}.${process.pid}.tar.gz.tmp`);
    await rm(temporaryArchive, { force: true }).catch(() => {});
    log(`${C.dim}[kernel] 打包整棵树 → ${finalPath}${C.off}`);
    // 打包和 npm install 用独立超时：内核树几万个小文件（含渠道插件），
    // bsdtar 遍历它们比 npm install 本身还慢，沿用 npm 的超时会假阳性失败。
    await run(tarBinary(), ['-czf', temporaryArchive, '-C', staging, '.'], { timeoutMs: tarTimeoutMs });

    // 打完再自检一遍：确认压缩包能被列出，且第一层就是 node_modules/openclaw/，
    // 这是 kernel-manager.mjs 的 locateRoot() 认包根的依据，打错了本地能跑、
    // 上线才炸，必须在这里就拦下来。
    const listing = await run(tarBinary(), ['-tzf', temporaryArchive], { timeoutMs: tarTimeoutMs });
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    const hasRoot = entries.some((entry) => entry.replace(/^\.\//, '') === `node_modules/${channel.kernel.package}/package.json`);
    if (!hasRoot) {
      await rm(temporaryArchive, { force: true }).catch(() => {});
      throw new BuildError(`自检失败：压缩包根不是 node_modules/${channel.kernel.package}/（打包结构不符）`);
    }

    await rm(finalPath, { force: true }).catch(() => {});
    await moveIntoPlace(temporaryArchive, finalPath);
    const sha256 = await sha256File(finalPath);
    log(`${C.green}[kernel] 打包完成并自检通过：${finalPath}${C.off}`);
    return {
      path: finalPath, bytes: (await stat(finalPath)).size, sha256,
      source: registry, version, pluginsInstalled, pluginsFailed,
      pruned: { before_bytes: beforePrune.bytes, after_bytes: afterPrune.bytes, removed },
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ── SHA256SUMS ───────────────────────────────────────────────────────────

/** 合并写 SHA256SUMS：保留本次没碰的旧条目，本次产物的条目覆盖更新。 */
async function writeChecksums(outDir, updates) {
  const file = path.join(outDir, 'SHA256SUMS');
  const existing = new Map();
  if (existsSync(file)) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (match) existing.set(match[2], match[1]);
    }
  }
  for (const [name, hash] of updates) existing.set(name, hash);

  // 补齐：outDir 里**存在但没被任何一次构建记进来**的产物，在这里现算补上。
  //
  // 2026-08-23 踩到的：第一次构建在打包步骤超时挂掉，那次已经下好并校验过的
  // node-v22.23.2-win-x64.zip 留在了目录里，但 writeChecksums 从没被调用过；
  // 第二次带 --skip-node 重跑，只记了内核。结果 vendor 目录里躺着两个包，
  // SHA256SUMS 却只覆盖其中一个 —— 而 `sha256sum -c SHA256SUMS` 只校验**列出来的**
  // 文件，所以它照样全绿。一个"看着齐全、实际只保了一半"的完整性文件，
  // 比没有更危险：下游（CI 的 Verify 步骤、客户首启）都会把它当成全覆盖。
  for (const name of await readdir(outDir)) {
    if (name === 'SHA256SUMS' || name.startsWith('.')) continue;
    if (existing.has(name)) continue;
    const full = path.join(outDir, name);
    let info;
    try { info = await stat(full); } catch { continue; }
    if (!info.isFile()) continue;
    log(`${C.yellow}[checksums] 补算漏记的产物：${name}（多半是上一次构建中途失败留下的）${C.off}`);
    existing.set(name, await sha256File(full));
  }

  // 丢掉指向已不存在文件的条目。合并保留旧条目是为了 --skip-node / --skip-kernel
  // 这类只产一半的构建，但升 Node 版本时旧包会被换掉（文件名带版本号），
  // 留着旧条目会让 `sha256sum -c SHA256SUMS` 直接报 "No such file"，
  // 把一份好产物判成坏的——首启校验失败在客户机上是没法自救的那类故障。
  for (const name of [...existing.keys()]) {
    if (!existsSync(path.join(outDir, name))) existing.delete(name);
  }

  const sorted = [...existing.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = sorted.map(([name, hash]) => `${hash}  ${name}\n`).join('');
  const temporary = path.join(outDir, `.SHA256SUMS.${process.pid}.tmp`);
  await writeFile(temporary, body, 'utf8');
  await moveIntoPlace(temporary, file);
  return { path: file, bytes: Buffer.byteLength(body, 'utf8') };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`不认识的参数：${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-/g, '_');
    if (inlineValue !== undefined) { flags[key] = inlineValue; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  const known = new Set(['target', 'out', 'skip_node', 'skip_kernel', 'allow_cross', 'json', 'help', 'node_timeout_ms', 'npm_timeout_ms', 'tar_timeout_ms']);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) throw new UsageError(`不认识的参数：--${key.replace(/_/g, '-')}`);
  }
  return flags;
}

function printHelp() {
  log('U-Claw seed 构建器 —— 产 portable/vendor/ 离线 seed 的唯一工具\n');
  log('用法: node portable/scripts/build-seed.mjs [选项]\n');
  log('选项:');
  log('  --target <t>       目标平台（win-x64 / darwin-arm64 / darwin-x64 / linux-x64），默认当前平台');
  log('  --out <dir>        产物目录，默认 portable/vendor');
  log('  --skip-node        不产 Node 包');
  log('  --skip-kernel      不产内核树');
  log('  --allow-cross      允许在非目标平台上打内核（默认拒绝：原生依赖跟构建机走，跨平台包起不来）');
  log('  --json             以 JSON 信封输出结果到 stdout');
  log('  --node-timeout-ms  Node 单次下载超时（默认 180000）');
  log('  --npm-timeout-ms   npm install 单次超时（默认 600000）');
  log('  --tar-timeout-ms   tar 打包/列包超时（默认 1200000）');
  log('  --help             显示本帮助');
}

async function main() {
  let flags;
  try {
    flags = parseArgv(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      log(`${C.red}${error.message}${C.off}`);
      printHelp();
      return EXIT_USAGE;
    }
    throw error;
  }

  if (flags.help) {
    printHelp();
    return EXIT_OK;
  }

  const target = typeof flags.target === 'string' ? flags.target : resolveTarget();
  const outDir = typeof flags.out === 'string' ? path.resolve(flags.out) : path.join(PORTABLE_DIR, 'vendor');
  const nodeTimeoutMs = flags.node_timeout_ms ? Number(flags.node_timeout_ms) : 3 * 60_000;
  const npmTimeoutMs = flags.npm_timeout_ms ? Number(flags.npm_timeout_ms) : 10 * 60_000;
  // bsdtar 打包几万个小文件（内核树 + 5 个渠道插件）比 npm install 更吃时间，
  // 单独给一个更宽松的超时，别让打包步骤被 npm 那档超时误杀。
  //
  // 2026-08-23 实测把默认值从 20 分钟提到 45：Windows 开发机上这棵树 prune 后仍有
  // **74690 个文件 / 755.9 MB**，bsdtar 跑满 1200 秒只写出约 49 MB gz 就被超时杀掉。
  // 瓶颈是 Defender 对每个小文件的实时扫描（Linux 上同样的树快一个数量级）。
  // 20 分钟这个默认值是按"能过"估的，没拿真树量过——量完发现它在 Windows 上必挂，
  // 而 seed job 恰恰只在 windows-latest / macos-latest 上跑（原生依赖不能交叉打）。
  const tarTimeoutMs = flags.tar_timeout_ms ? Number(flags.tar_timeout_ms) : 45 * 60_000;

  // 跨平台守卫：--target 只决定 Node 包和文件名，内核树是拿本机 npm 装出来的，
  // 里面的原生 optionalDependency（sqlite-vec 等）跟着**构建机**走，不跟着 --target 走。
  // 在 ubuntu 上 `--target win-x64` 会产出一个"名字写着 win-x64、里面是 Linux 二进制"
  // 的 seed —— 打包不报错、上传不报错、客户断网首启时才炸，而那时无网可救。
  // 所以默认只允许打本机平台；真要跨平台打（比如只想要 Node 包）必须显式 --allow-cross。
  const hostTarget = resolveTarget();
  if (target !== hostTarget && !flags.allow_cross && !flags.skip_kernel) {
    log(`${C.red}拒绝跨平台打内核 seed：--target ${target}，但本机是 ${hostTarget}。${C.off}`);
    log('内核树的原生依赖跟构建机走，跨平台打出来的包在目标机上起不来。');
    log(`办法：① 在 ${target} 的机器/runner 上打（CI 的 seed job 就是按平台矩阵跑的）；`);
    log('     ② 只要 Node 包就加 --skip-kernel；③ 明知后果仍要打加 --allow-cross。');
    return EXIT_USAGE;
  }

  let channel;
  try {
    channel = loadChannel({ portableDir: PORTABLE_DIR, target });
  } catch (error) {
    log(`${C.red}${error.message}${C.off}`);
    return EXIT_USAGE;
  }

  const startedAt = Date.now();
  const artifacts = { node: null, kernel: null, checksums: null };
  const checksumUpdates = new Map();

  try {
    await mkdir(outDir, { recursive: true });

    if (!flags.skip_node) {
      const node = await ensureNodeSeed({ channel, target, outDir, timeoutMs: nodeTimeoutMs });
      artifacts.node = node;
      checksumUpdates.set(path.basename(node.path), node.sha256);
    } else {
      log(`${C.dim}[node] --skip-node，跳过${C.off}`);
    }

    if (!flags.skip_kernel) {
      const npmCli = await resolveNpmCli(channel);
      const kernel = await ensureKernelSeed({ channel, target, outDir, timeoutMs: npmTimeoutMs, tarTimeoutMs, npmCli });
      artifacts.kernel = kernel;
      checksumUpdates.set(path.basename(kernel.path), kernel.sha256);
    } else {
      log(`${C.dim}[kernel] --skip-kernel，跳过${C.off}`);
    }

    if (checksumUpdates.size > 0) {
      artifacts.checksums = await writeChecksums(outDir, checksumUpdates);
    }

    const durationMs = Date.now() - startedAt;
    const envelope = { ok: true, target, outDir, durationMs, artifacts };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      log(`${C.green}完成${C.off}（${(durationMs / 1000).toFixed(1)}s）`);
      if (artifacts.node) log(`  node:   ${artifacts.node.path}（${artifacts.node.bytes} bytes）`);
      if (artifacts.kernel) log(`  kernel: ${artifacts.kernel.path}（${artifacts.kernel.bytes} bytes）`);
      if (artifacts.checksums) log(`  sums:   ${artifacts.checksums.path}`);
    }
    return EXIT_OK;
  } catch (error) {
    const envelope = { ok: false, target, outDir, error: { message: error?.message || String(error) } };
    if (flags.json) process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    else log(`${C.red}失败：${error?.stack || error}${C.off}`);
    return EXIT_FAIL;
  }
}

// 只有被直接执行时才跑构建 —— 测试要 import satisfiesRange，不能顺手启动一次
// 几百 MB 的 npm install。
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`build-seed 内部错误: ${error?.stack || error}\n`);
      process.exit(EXIT_FAIL);
    });
}

export { satisfiesRange, PRUNE_DIRS, writeChecksums };
