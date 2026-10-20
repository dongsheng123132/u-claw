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
//   U-Claw 对固定版本 OpenClaw 打入受管浏览器目录补丁，读取
//   OPENCLAW_MANAGED_BROWSER_DIR；因此只将 Chromium profile 放本机盘。STATE_DIR
//   （SQLite 会话、设备身份、授权）始终留在 U 盘，不能与浏览器一起搬走。
//
// UUID 隔离（移植自 4.0）：
//   缓存子目录名 = sha256("portable-id:<UUID>") 前 16 hex。UUID 存在 U 盘 STATE_DIR 里，
//   所以同一支 U 盘从 D: 插到 E: 仍命中同一份本机缓存，不必重新热身。
//
// 设计原则：本机盘优先；本机缓存不可写时才回退到 U 盘，绝不阻断启动。
//
// CLI 用法（供 .bat / .command source）：
//   node portable-cache.mjs <STATE_DIR> <USB_ROOT>
// 输出（每行 KEY=VALUE，路径已 mkdir）：
//   UCLAW_COMPILE_CACHE_DIR=...
//   UCLAW_BROWSER_USER_DATA_DIR=...
//   UCLAW_CACHE_ROOT=...

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const CACHE_ID_FILE = 'portable-cache-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 本机缓存根：各平台的"用户缓存"约定位置。绝不放 U 盘。
function systemCacheRoot(platform = process.platform, env = process.env) {
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

// 解析本机缓存目录集合。stateDir 缺失/不可写时回退到 U 盘内目录。
export function resolvePortableCache({
  stateDir,
  usbRoot,
  platform = process.platform,
  env = process.env,
} = {}) {
  const cacheId = readOrCreateCacheId(stateDir);
  // 有 UUID 用 UUID，否则退而用 U 盘路径做身份（仍稳定，只是换盘符会换目录）
  const identity = cacheId ? `portable-id:${cacheId}` : String(usbRoot || stateDir || 'u-claw').toLowerCase();
  const slot = createHash('sha256').update(identity).digest('hex').slice(0, 16);

  let root;
  let localCacheAvailable = true;
  try {
    root = join(systemCacheRoot(platform, env), 'U-Claw', slot);
    mkdirSync(root, { recursive: true });
  } catch {
    // 本机缓存根不可写 → 整体回退到 U 盘内（保证不报错，只是没加速）
    localCacheAvailable = false;
    root = stateDir ? join(stateDir, 'cache') : join(tmpdir(), 'u-claw-cache', slot);
    try { mkdirSync(root, { recursive: true }); } catch { /* 实在不行就让调用方拿到路径自己兜底 */ }
  }

  const compileCacheDir = join(root, 'node-compile-cache');
  // If the host cache cannot be created, leave the variable empty. OpenClaw
  // then uses its normal portable STATE_DIR/browser location; never invent a
  // second state location or inherit a caller-supplied local browser root.
  const managedBrowserDir = localCacheAvailable ? join(root, 'managed-browser') : '';
  const browserUserDataDir = managedBrowserDir ? join(managedBrowserDir, 'openclaw', 'user-data') : '';
  for (const d of [compileCacheDir, managedBrowserDir, browserUserDataDir].filter(Boolean)) {
    try { mkdirSync(d, { recursive: true }); } catch { /* 静默 */ }
  }

  return { root, compileCacheDir, managedBrowserDir, browserUserDataDir, localCacheAvailable, cacheId };
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
      `UCLAW_MANAGED_BROWSER_DIR=${c.managedBrowserDir}\n` +
      `UCLAW_BROWSER_USER_DATA_DIR=${c.browserUserDataDir}\n` +
      `UCLAW_LOCAL_CACHE_AVAILABLE=${c.localCacheAvailable ? '1' : '0'}\n`,
    );
    process.exit(0);
  } catch (err) {
    // 静默失败：不输出任何 KEY，启动脚本会按"未设置"继续（缓存留 U 盘）
    process.stderr.write(`[portable-cache] ${err && err.message}\n`);
    process.exit(1);
  }
}
