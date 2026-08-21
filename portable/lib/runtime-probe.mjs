// runtime-probe.mjs — 这台电脑上已经有什么？（影核动作 runtime.probe）
//
// v3 首启要回答的第一个问题是"这台机器上已经有 Node 和内核了吗"。答对了，首启从
// 几分钟变几秒；答错了，就是 #51 那种"跟客户自己环境串线、查半天查不出"的 Bug。
//
// 探测顺序（开发计划 §3），核心是**先本机托管、后 U 盘 seed、再网络，系统的排最后**：
//
//   Node    1 本机 shared/ 托管（版本精确匹配）
//           2 U 盘 v2 遗留 app/runtime/（老 U 盘升上来的）
//           3 同门产品的托管 Node（U-King 的 ~/.uking/runtime/node）
//           4 U 盘 vendor/ 离线 seed —— 有包但还没装
//           5 系统 PATH 上的 Node —— 默认不用，见下
//
//   内核    1 本机 shared/kernels/openclaw/<版本>
//           2 U 盘 v2 遗留 app/core/
//           3 U 盘 vendor/ 离线 seed
//           × 客户自己 npm i -g 装的 openclaw —— 只报告，绝不使用
//
// 为什么系统 Node 默认不用：nvm / volta / fnm 这类 shim 会在客户不知情时切版本，
// 公司机上的 Node 可能老到 npm 行为都不一样。省一次下载不值得换来一类查不出的 Bug。
// 想开就改 runtime-channel.json 的 reuse.allowSystemNode。
//
// 为什么客户自装的 openclaw 绝不复用（这条比系统 Node 更硬）：
// U-Claw 的卖点之一是"聊天渠道开箱即用"——微信/QQ/钉钉/飞书/企业微信插件是随包预装的。
// 客户 npm i -g 装的那份没有这些插件，复用它等于静默砍掉一个头部功能，
// 而症状会表现成"渠道页面是空的"，没人会联想到内核来源。报告它、不碰它。
//
// 本模块是**只读**的：不建目录、不下载、不改任何东西。跑一百遍和跑一遍一样。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadChannel } from './runtime-channel.mjs';
import { kernelRoot, resolveRuntimePaths } from './runtime-paths.mjs';

const execFileAsync = promisify(execFile);
const SHIM_MARKERS = ['nvm', 'volta', 'fnm', '.asdf', 'nodenv'];

function parseVersion(value) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(actual, minimum) {
  const a = parseVersion(actual);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function looksLikeShim(executable) {
  const lower = executable.toLowerCase();
  return SHIM_MARKERS.some((marker) => lower.includes(marker));
}

async function nodeVersionOf(executable) {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], {
      timeout: 5000, windowsHide: true, shell: false,
    });
    return parseVersion(stdout)?.join('.') ?? null;
  } catch {
    // PATH 上常年躺着已卸载的 Node，探不通是常态，不是错误。
    return null;
  }
}

function readManifest(packageJsonPath) {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean).map((value) => resolve(value)))];
}

// ── Node ────────────────────────────────────────────────────────────────────

function systemNodeCandidates(env, platform) {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  const out = [];
  for (const entry of String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    out.push(join(entry, exe));
  }
  if (platform === 'win32' && env.ProgramFiles) out.push(join(env.ProgramFiles, 'nodejs', 'node.exe'));
  return uniquePaths(out);
}

async function probeNode({ paths, channel, env, platform }) {
  const target = channel.node.target;
  const candidates = [];

  const record = async (source, executable, extra = {}) => {
    if (!executable || !existsSync(executable)) return null;
    const version = await nodeVersionOf(executable);
    const shim = looksLikeShim(executable);
    const entry = {
      source,
      path: executable,
      version,
      shim,
      meetsMinimum: version ? atLeast(version, channel.node.minimumVersion) : false,
      ...extra,
    };
    candidates.push(entry);
    return entry;
  };

  // 1 本机 shared/ 托管：目录名里就带版本号，命中即精确匹配
  const managed = paths.nodeHome && target
    ? await record('managed-shared', join(paths.nodeHome, target.nodeRelativePath), { exact: true })
    : null;

  // 2 U 盘 v2 遗留布局
  const legacy = target
    ? await record('legacy-usb', join(paths.legacy.nodeHome, target.nodeRelativePath))
    : null;

  // 3 同门产品的托管 Node（U-King 装在这里，是我们自己控的版本，可信）
  const siblingExe = platform === 'win32'
    ? join(homedir(), '.uking', 'runtime', 'node', 'node.exe')
    : join(homedir(), '.uking', 'runtime', 'node', 'bin', 'node');
  const sibling = await record('sibling-product', siblingExe);

  // 4 U 盘 vendor/ 离线 seed —— 只看在不在，不解压
  const seedArchive = target ? join(paths.vendorDir, target.archive) : null;
  const seedAvailable = Boolean(seedArchive && existsSync(seedArchive));
  if (seedAvailable) {
    candidates.push({ source: 'usb-seed', path: seedArchive, version: channel.node.version, installed: false });
  }

  // 5 系统 PATH —— 默认不用，只报告
  const system = [];
  for (const executable of systemNodeCandidates(env, platform)) {
    const version = await nodeVersionOf(executable);
    if (!version) continue;
    system.push({
      source: 'system',
      path: executable,
      version,
      shim: looksLikeShim(executable),
      meetsMinimum: atLeast(version, channel.node.minimumVersion),
    });
    if (system.length >= 3) break;   // 报告用，够看就行，别把整条 PATH 都跑一遍
  }
  candidates.push(...system);

  const usable = (entry) => entry && entry.version && (entry.exact || entry.meetsMinimum) && !entry.shim;
  let chosen = [managed, legacy, sibling].find(usable) ?? null;

  if (!chosen && channel.reuse.allowSystemNode) {
    chosen = system.find((entry) => entry.meetsMinimum && !entry.shim) ?? null;
  }

  return { chosen, candidates, seedAvailable };
}

// ── 内核（OpenClaw） ─────────────────────────────────────────────────────────

function foreignKernelRoots(env, platform) {
  const out = [];
  if (env.NPM_CONFIG_PREFIX?.trim()) out.push(join(env.NPM_CONFIG_PREFIX.trim(), 'node_modules', 'openclaw'));
  if (platform === 'win32' && env.APPDATA?.trim()) {
    out.push(join(env.APPDATA.trim(), 'npm', 'node_modules', 'openclaw'));
  } else {
    out.push(join(homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw'));
    out.push('/usr/local/lib/node_modules/openclaw');
    out.push('/opt/homebrew/lib/node_modules/openclaw');
  }
  // 一键安装版装在 ~/.uclaw/，那是我们自己的产物，但它是**另一份独立安装**，
  // 有自己的配置目录。同样只报告，让用户知道机器上有两份，不要自动接管。
  out.push(join(homedir(), '.uclaw', 'node_modules', 'openclaw'));
  return uniquePaths(out);
}

function probeKernel({ paths, channel, env, platform }) {
  const pinned = channel.kernel.version;
  const candidates = [];

  const inspect = (source, packageDir, extra = {}) => {
    const manifest = readManifest(join(packageDir, 'package.json'));
    if (!manifest || manifest.name !== channel.kernel.package) return null;
    const entry = {
      source,
      path: packageDir,
      version: manifest.version,
      matchesPinned: manifest.version === pinned,
      ...extra,
    };
    candidates.push(entry);
    return entry;
  };

  // 1 本机 shared/kernels/openclaw/<版本>
  const managed = inspect(
    'managed-shared',
    join(kernelRoot(paths, pinned), 'node_modules', 'openclaw'),
  );

  // 2 U 盘 v2 遗留 app/core/
  const legacy = inspect('legacy-usb', paths.legacy.kernelPackage);

  // 3 U 盘 vendor/ 离线 seed
  const seedArchive = join(paths.vendorDir, `openclaw-${pinned}.tgz`);
  const seedAvailable = existsSync(seedArchive);
  if (seedAvailable) {
    candidates.push({ source: 'usb-seed', path: seedArchive, version: pinned, installed: false });
  }

  // × 客户机上别处的 openclaw —— 报告，不用
  const foreign = [];
  for (const packageDir of foreignKernelRoots(env, platform)) {
    const manifest = readManifest(join(packageDir, 'package.json'));
    if (manifest?.name === channel.kernel.package) {
      foreign.push({ path: packageDir, version: manifest.version, used: false });
    }
  }

  let chosen = managed?.matchesPinned ? managed : null;
  if (!chosen && legacy?.matchesPinned) chosen = legacy;
  if (!chosen && channel.reuse.allowForeignKernel) {
    const match = foreign.find((entry) => entry.version === pinned);
    if (match) chosen = { source: 'foreign', path: match.path, version: match.version, matchesPinned: true };
  }

  return { chosen, candidates, foreign, seedAvailable };
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

function hostWritable(paths, env, platform) {
  // 只读地判断本机缓存根能不能写：对**已存在的**上级目录做 W_OK，不去创建任何东西。
  // 公司机上 %LOCALAPPDATA% 被组策略锁住是真会发生的，撞上要降级回落 U 盘，不是报错退出。
  let dir = paths.hostRoot;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(dir)) {
      try {
        accessSync(dir, constants.W_OK);
        return { writable: true, checked: dir };
      } catch {
        return { writable: false, checked: dir };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { writable: false, checked: dir };
}

export async function probeRuntime({
  usbRoot,
  portableDir,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const warnings = [];
  const bootstrapPaths = resolveRuntimePaths({ usbRoot, platform, arch, env });
  const channel = loadChannel({ portableDir, target: bootstrapPaths.target });
  const paths = resolveRuntimePaths({
    usbRoot, platform, arch, env, nodeVersion: channel.node.version,
  });

  const node = await probeNode({ paths, channel, env, platform });
  const kernel = probeKernel({ paths, channel, env, platform });
  const host = hostWritable(paths, env, platform);

  if (!host.writable) {
    warnings.push(`本机缓存根不可写（${host.checked}）—— 需降级回落 U 盘运行，不要直接失败`);
  }
  if (kernel.foreign.length > 0) {
    warnings.push(
      `系统中另有 ${kernel.foreign.length} 份 openclaw（${kernel.foreign.map((f) => f.version).join(', ')}）` +
      '，U-Claw 不会使用它们：那些安装没有随包预装的微信/QQ/钉钉/飞书渠道插件',
    );
  }
  if (node.candidates.some((c) => c.shim)) {
    warnings.push('PATH 上的 Node 来自 nvm/volta/fnm 这类版本切换器，不作为候选');
  }

  const ready = Boolean(node.chosen && kernel.chosen);
  let nextAction = 'ready';
  if (!ready) {
    const canSeed = (!node.chosen && node.seedAvailable) || (!kernel.chosen && kernel.seedAvailable);
    const stillMissingAfterSeed =
      (!node.chosen && !node.seedAvailable) || (!kernel.chosen && !kernel.seedAvailable);
    if (canSeed && !stillMissingAfterSeed) nextAction = 'seed';
    else if (host.writable) nextAction = 'download';
    else nextAction = 'blocked';
  }

  return {
    schemaVersion: 1,
    ok: true,
    ready,
    nextAction,
    platform, arch, target: paths.target,
    channel: {
      node: channel.node.version,
      nodeMinimum: channel.node.minimumVersion,
      kernel: channel.kernel.version,
      allowSystemNode: channel.reuse.allowSystemNode,
      allowForeignKernel: channel.reuse.allowForeignKernel,
    },
    paths: {
      usbRoot: paths.usbRoot,
      dataDir: paths.dataDir,
      vendorDir: paths.vendorDir,
      hostRoot: paths.hostRoot,
      sharedDir: paths.sharedDir,
      slotDir: paths.slotDir,
      slot: paths.slot,
    },
    host,
    node,
    kernel,
    warnings,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// 退出码：0 就绪 / 2 未就绪但有办法（seed 或下载）/ 3 卡住 / 1 探测本身出错
// stdout 只出结果，stderr 出日志（宪法 14）。

import { pathToFileURL } from 'node:url';

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

function describe(report) {
  const lines = [];
  const mark = (value) => (value ? '✓' : '×');
  lines.push(`U-Claw 运行时探测 · ${report.target}`);
  lines.push(`  U 盘        ${report.paths.usbRoot || '(未指定)'}`);
  lines.push(`  本机缓存    ${report.paths.hostRoot}  ${report.host.writable ? '可写' : '不可写'}`);
  lines.push(`  槽位        ${report.paths.slot}`);
  lines.push('');
  lines.push(`  Node   期望 v${report.channel.node}（最低 v${report.channel.nodeMinimum}）`);
  if (report.node.chosen) {
    lines.push(`    ${mark(true)} 采用 ${report.node.chosen.source}  v${report.node.chosen.version}`);
    lines.push(`      ${report.node.chosen.path}`);
  } else {
    lines.push(`    ${mark(false)} 没有可用的 Node`);
  }
  for (const c of report.node.candidates) {
    if (c === report.node.chosen) continue;
    lines.push(`      · ${c.source}  ${c.version ? `v${c.version}` : '(未探通)'}${c.shim ? '  [版本切换器,跳过]' : ''}`);
  }
  lines.push('');
  lines.push(`  内核   期望 openclaw ${report.channel.kernel}`);
  if (report.kernel.chosen) {
    lines.push(`    ${mark(true)} 采用 ${report.kernel.chosen.source}  ${report.kernel.chosen.version}`);
    lines.push(`      ${report.kernel.chosen.path}`);
  } else {
    lines.push(`    ${mark(false)} 没有可用的内核`);
  }
  for (const c of report.kernel.candidates) {
    if (c === report.kernel.chosen) continue;
    lines.push(`      · ${c.source}  ${c.version}${c.matchesPinned === false ? '  [版本不符]' : ''}`);
  }
  for (const f of report.kernel.foreign) {
    lines.push(`      · 系统其它安装  ${f.version}  [仅报告,不使用]`);
    lines.push(`        ${f.path}`);
  }
  lines.push('');
  lines.push(`  结论   ${report.ready ? '就绪' : '未就绪'}  →  ${report.nextAction}`);
  for (const w of report.warnings) lines.push(`  注意   ${w}`);
  return lines.join('\n');
}

if (isMain) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const usbRoot = argv.find((a) => !a.startsWith('--'))
    || process.env.UCLAW_DIR
    || join(dirname(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

  try {
    const report = await probeRuntime({ usbRoot });
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${describe(report)}\n`);
    process.exit(report.ready ? 0 : report.nextAction === 'blocked' ? 3 : 2);
  } catch (error) {
    const message = error?.message || String(error);
    if (asJson) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: message })}\n`);
    process.stderr.write(`[runtime-probe] ${message}\n`);
    process.exit(1);
  }
}
