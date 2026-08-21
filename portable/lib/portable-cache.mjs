// portable-cache.mjs — 把"重 IO、可重建"的缓存从 U 盘搬到本机硬盘
//
// 背景（U 盘启动慢的最大根因）：
//   - OpenClaw 的浏览器 user-data 落在 OPENCLAW_STATE_DIR/browser/<profile>/user-data，
//     即 U 盘 data/.openclaw/ 下。Chromium 会对它做海量随机小写，慢 U 盘上极致拖累。
//   - Node 的 V8 编译缓存（module.enableCompileCache）默认落系统 temp，可能被清而每次重编译。
//
// 方案（移植自 v2 u-clawx 4.0 的 portable-session-data.ts 思路）：
//   把这两类"可重建、不需便携"的缓存重定向到本机硬盘的固定位置：
//     Windows: %LOCALAPPDATA%\U-Claw\...
//     macOS:   ~/Library/Caches/U-Claw/...
//     Linux:   $XDG_CACHE_HOME/U-Claw 或 ~/.cache/U-Claw
//   业务数据（openclaw.json、memory、账号）仍留在 U 盘 data/，便携性不变。
//
// 浏览器 user-data 的重定向手法：
//   OpenClaw 把浏览器 profile 硬编码在 CONFIG_DIR/browser/（无单独环境变量可改），
//   只有 OPENCLAW_STATE_DIR 能整体搬走——但那会连 openclaw.json 一起搬，破坏便携。
//   所以这里用"目录联接/符号链接"：把 U 盘的 data/.openclaw/browser 做成一个
//   junction(Windows) / symlink(mac/linux)，指向本机硬盘缓存。OpenClaw 照常写
//   CONFIG_DIR/browser，字节却落在本机盘上。配置仍在 U 盘，便携性不受影响。
//
// UUID 隔离（移植自 4.0）：
//   缓存子目录名 = sha256("portable-id:<UUID>") 前 16 hex。UUID 存在 U 盘 STATE_DIR 里，
//   所以同一支 U 盘从 D: 插到 E: 仍命中同一份本机缓存，不必重新热身。
//
// 设计原则：静默失败。任何一步出错都回退到"用 U 盘内目录"，绝不阻断启动。
//
// CLI 用法（供 .bat / .command source）：
//   node portable-cache.mjs <STATE_DIR> <USB_ROOT>
// 输出（每行 KEY=VALUE，路径已 mkdir）：
//   UCLAW_COMPILE_CACHE_DIR=...
//   UCLAW_BROWSER_USER_DATA_DIR=...
//   UCLAW_CACHE_ROOT=...

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync, symlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const CACHE_ID_FILE = 'portable-cache-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 本机缓存根：各平台的"用户缓存"约定位置。绝不放 U 盘。
// 导出给 runtime-paths.mjs 复用 —— 本机根目录的算法只能有一份，
// 存两份就会在某次改动后漂成两个目录（宪法 8）。
export function systemCacheRoot(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return env.LOCALAPPDATA?.trim() || join(homedir() || tmpdir(), 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return join(homedir() || tmpdir(), 'Library', 'Caches');
  }
  return env.XDG_CACHE_HOME?.trim() || join(homedir() || tmpdir(), '.cache');
}

// 读/建 U 盘上的稳定 UUID，使缓存身份与盘符解耦。
function readOrCreateCacheId(stateDir) {
  if (!stateDir) return null;
  const idPath = join(stateDir, CACHE_ID_FILE);
  try {
    if (existsSync(idPath)) {
      const existing = readFileSync(idPath, 'utf8').trim();
      if (UUID_RE.test(existing)) return existing.toLowerCase();
    }
    const next = randomUUID();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(idPath, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
    return next;
  } catch {
    return null;
  }
}

// 解析"这支 U 盘在本机的槽位身份"，纯计算 + 至多写一个 UUID 文件，不建目录、不做链接。
// 单独导出是给 runtime-probe.mjs 用的：探测是只读动作，不该顺手把浏览器目录链掉。
export function resolveCacheSlot({ stateDir, usbRoot } = {}) {
  const cacheId = readOrCreateCacheId(stateDir);
  // 有 UUID 用 UUID，否则退而用 U 盘路径做身份（仍稳定，只是换盘符会换目录）
  const identity = cacheId ? `portable-id:${cacheId}` : String(usbRoot || stateDir || 'u-claw').toLowerCase();
  return { cacheId, slot: createHash('sha256').update(identity).digest('hex').slice(0, 16) };
}

// 解析本机缓存目录集合。stateDir 缺失/不可写时回退到 U 盘内目录。
export function resolvePortableCache({
  stateDir,
  usbRoot,
  platform = process.platform,
  env = process.env,
} = {}) {
  const { cacheId, slot } = resolveCacheSlot({ stateDir, usbRoot });

  let root;
  try {
    root = join(systemCacheRoot(platform, env), 'U-Claw', slot);
    mkdirSync(root, { recursive: true });
  } catch {
    // 本机缓存根不可写 → 整体回退到 U 盘内（保证不报错，只是没加速）
    root = stateDir ? join(stateDir, 'cache') : join(tmpdir(), 'u-claw-cache', slot);
    try { mkdirSync(root, { recursive: true }); } catch { /* 实在不行就让调用方拿到路径自己兜底 */ }
  }

  const compileCacheDir = join(root, 'node-compile-cache');
  const browserUserDataDir = join(root, 'browser');
  for (const d of [compileCacheDir, browserUserDataDir]) {
    try { mkdirSync(d, { recursive: true }); } catch { /* 静默 */ }
  }

  // 把 U 盘的 .openclaw/browser 链到本机缓存。失败就不链——OpenClaw 退回原地写 U 盘，只是没加速。
  let browserLinked = false;
  if (stateDir) {
    browserLinked = linkBrowserDir(join(stateDir, 'browser'), browserUserDataDir, platform);
  }

  return { root, compileCacheDir, browserUserDataDir, browserLinked, cacheId };
}

// 判断一个路径是否"已是指向 target 的链接"。
function isLinkTo(linkPath, target) {
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) {
      // Windows junction 在 lstat 下 isDirectory()=true、isSymbolicLink()=false，
      // 用 readlink 兜底判断：能 readlink 成功且指向 target 就算已链。
      try {
        const resolved = readlinkSync(linkPath);
        return resolved && target && resolved.replace(/[\\/]+$/, '') === target.replace(/[\\/]+$/, '');
      } catch {
        return false;
      }
    }
    const resolved = readlinkSync(linkPath);
    return resolved.replace(/[\\/]+$/, '') === target.replace(/[\\/]+$/, '');
  } catch {
    return false; // 不存在
  }
}

// 把 linkPath（U 盘 .openclaw/browser）做成指向 target（本机缓存/browser）的链接。
// 返回 true=已链好。已存在真实目录且非空则不动（保住用户既有 profile，宁可慢也不丢数据）。
function linkBrowserDir(linkPath, target, platform) {
  try {
    if (existsSync(linkPath)) {
      if (isLinkTo(linkPath, target)) return true; // 之前已链好
      // 是真实目录：若为空可以安全替换成链接；非空则保守不动。
      let entries = [];
      try { entries = readdirSync(linkPath); } catch { return false; }
      if (entries.length > 0) return false; // 有既有 profile，不冒险，留在 U 盘
      // 空目录：删掉再链
      try { rmdirCompat(linkPath); } catch { return false; }
    }
    if (platform === 'win32') {
      // mklink /J 目录联接：无需管理员权限，行为最接近"同一目录"
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore' });
    } else {
      symlinkSync(target, linkPath, 'dir');
    }
    return isLinkTo(linkPath, target);
  } catch {
    return false;
  }
}

function rmdirCompat(dir) {
  // 只删空目录，避免误删用户数据
  rmdirSync(dir);
}

// CLI：打印 KEY=VALUE，供启动脚本逐行 set / export。
import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  const stateDir = process.argv[2] || process.env.OPENCLAW_STATE_DIR;
  const usbRoot = process.argv[3] || process.env.UCLAW_DIR;
  try {
    const c = resolvePortableCache({ stateDir, usbRoot });
    process.stdout.write(
      `UCLAW_CACHE_ROOT=${c.root}\n` +
      `UCLAW_COMPILE_CACHE_DIR=${c.compileCacheDir}\n` +
      `UCLAW_BROWSER_USER_DATA_DIR=${c.browserUserDataDir}\n` +
      `UCLAW_BROWSER_LINKED=${c.browserLinked ? '1' : '0'}\n`,
    );
    process.exit(0);
  } catch (err) {
    // 静默失败：不输出任何 KEY，启动脚本会按"未设置"继续（缓存留 U 盘）
    process.stderr.write(`[portable-cache] ${err && err.message}\n`);
    process.exit(1);
  }
}
