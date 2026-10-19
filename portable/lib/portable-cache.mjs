// portable-cache.mjs — 唯一的本机缓存/临时/日志目录解析器（本批唯一真相源）
//
// 背景（U 盘启动慢的最大根因）：
//   - OpenClaw 的浏览器 user-data、V8 编译缓存、npm 缓存、临时文件、启动日志若落在 U 盘，
//     慢盘上的海量随机小写会把启动与会话拖到不可用。
//   - 旧版在首选本机根不可写时"回落到 U 盘"——本批删除该语义：无本机可写位置 = 明确失败，
//     由调用 helper 的入口（Start/CLI/Doctor）中止，绝不静默把缓存写回 U 盘。
//
// 候选顺序（依次尝试，前一个不合格就换下一个）：
//   1) 系统用户缓存根（win %LOCALAPPDATA% / mac ~/Library/Caches / linux $XDG_CACHE_HOME）
//   2) 本机 HOME 下的用户缓存目录（与 1 重复时自动去重）
//   3) 系统 temp（os.tmpdir()）
// 每个候选都要同时满足：
//   - realpath 后不在 usbRoot / stateDir 子树内（含其子目录同样检查）
//   - slot 根 + 全部子目录（compile/npm/tmp/logs/browser）真实 mkdir + 逐个写探测通过
// 任一子项失败 → 清掉本轮建出的目录，换下一个候选。
//
// UUID 隔离：缓存子目录名 = sha256("portable-id:<UUID>") 前 16 hex。UUID 存在 U 盘 STATE_DIR
// 的 portable-cache-id 里（仅首次小量写入；已存在但损坏的文件不覆盖，退回路径身份），
// 因此同一支盘从 D: 插到 E: 仍命中同一份本机缓存。
//
// CLI 用法（供 portable-cache-env.{bat,sh} 解析，不 eval 输出，逐行 KEY=VALUE）：
//   node portable-cache.mjs <STATE_DIR> <USB_ROOT>
// 可注入候选（仅测试用，避免真机系统回退干扰断言）：
//   环境变量 UCLAW_CACHE_CANDIDATES（path.delimiter 分隔的候选基目录列表）
// 输出（成功时每行 KEY=VALUE，目录已 mkdir + 写探测通过）：
//   UCLAW_CACHE_ROOT / UCLAW_COMPILE_CACHE_DIR / UCLAW_NPM_CACHE_DIR / UCLAW_TEMP_DIR /
//   UCLAW_LOG_DIR / UCLAW_MANAGED_BROWSER_DIR / UCLAW_BROWSER_USER_DATA_DIR /
//   UCLAW_LOCAL_CACHE_AVAILABLE=1
// 失败：stdout 只打 UCLAW_LOCAL_CACHE_AVAILABLE=0，stderr 打警告，exit 1。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

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

// 候选基目录（顺序即优先级）：系统缓存根 → HOME 缓存 → 系统 temp。
function defaultCandidateBases(platform, env) {
  const bases = [];
  const seen = new Set();
  const push = (p) => {
    if (!p) return;
    const k = platform === 'win32' ? String(p).toLowerCase() : String(p);
    if (seen.has(k)) return;
    seen.add(k);
    bases.push(p);
  };
  push(systemCacheRoot(platform, env));
  const home = homedir();
  if (home) {
    if (platform === 'win32') push(join(home, 'AppData', 'Local'));
    else if (platform === 'darwin') push(join(home, 'Library', 'Caches'));
    else push(env.XDG_CACHE_HOME?.trim() || join(home, '.cache'));
  }
  push(join(tmpdir(), 'u-claw-cache'));
  return bases;
}

// realpath 化（不存在的尾段逐级拼回）：把 junction/符号链接/.. 都折进真实路径再比边界。
function realPathOf(p) {
  const target = resolve(p);
  const tail = [];
  let cur = target;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return target;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

function normalizeForCompare(p, platform) {
  const s = String(p);
  return platform === 'win32' ? s.toLowerCase() : s;
}

// child（及自身）是否位于 root 子树内。
function isWithin(childReal, rootReal, platform) {
  if (!childReal || !rootReal) return false;
  const c = normalizeForCompare(childReal, platform);
  const r = normalizeForCompare(rootReal, platform);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

// 只读取，不写入：已存在但损坏的 UUID 文件保持原样（不覆盖）。
function readCacheIdIfExists(stateDir) {
  if (!stateDir) return { state: 'missing', id: null };
  try {
    const idPath = join(stateDir, CACHE_ID_FILE);
    if (!existsSync(idPath)) return { state: 'missing', id: null };
    const existing = readFileSync(idPath, 'utf8').trim();
    if (UUID_RE.test(existing)) return { state: 'valid', id: existing.toLowerCase() };
    return { state: 'corrupt', id: null };
  } catch {
    return { state: 'missing', id: null };
  }
}

// 在候选基目录下建 slot 根 + 全部子目录，并逐目录写探测；任一失败即回滚并返回 null。
function prepareSlotRoot(base, slot, platform) {
  const root = join(base, 'U-Claw', slot);
  const sub = {
    compileCacheDir: join(root, 'node-compile-cache'),
    npmCacheDir: join(root, 'npm-cache'),
    tempDir: join(root, 'tmp'),
    logDir: join(root, 'logs'),
    managedBrowserDir: join(root, 'managed-browser'),
    browserUserDataDir: join(root, 'managed-browser', 'openclaw', 'user-data'),
  };
  try {
    mkdirSync(root, { recursive: true });
    for (const d of Object.values(sub)) mkdirSync(d, { recursive: true });
    for (const d of [root, ...Object.values(sub)]) {
      const probe = join(d, `.uclaw-wprobe-${process.pid}`);
      writeFileSync(probe, '');
      unlinkSync(probe);
    }
    return { root, ...sub };
  } catch {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 尽力回滚 */ }
    return null;
  }
}

/**
 * 解析本机缓存目录集合。
 * options.candidates 可注入候选基目录（测试用；不传则按平台默认顺序）。
 * 找不到可写本机候选 → 返回 root 为空 + localCacheAvailable:false，且不在 stateDir/usbRoot
 * 创建任何目录、不写 UUID。
 */
export function resolvePortableCache({
  stateDir,
  usbRoot,
  platform = process.platform,
  env = process.env,
  candidates,
} = {}) {
  const idInfo = readCacheIdIfExists(stateDir);
  // UUID 只在内存里参与 slot 计算，确认本机可用后才落盘（损坏文件永不覆盖）。
  const uuid = idInfo.state === 'valid' ? idInfo.id : (idInfo.state === 'missing' ? randomUUID() : null);
  const identity = uuid
    ? `portable-id:${uuid}`
    : String(usbRoot || stateDir || 'u-claw').toLowerCase();
  const slot = createHash('sha256').update(identity).digest('hex').slice(0, 16);

  const realUsb = usbRoot ? realPathOf(usbRoot) : null;
  const realState = stateDir ? realPathOf(stateDir) : null;

  const bases = Array.isArray(candidates) && candidates.length
    ? candidates.filter(Boolean)
    : defaultCandidateBases(platform, env);

  for (const base of bases) {
    const realBase = realPathOf(base);
    // 候选基目录（及其真实落点）不得在 U 盘或 stateDir 子树内。
    if (isWithin(realBase, realUsb, platform) || isWithin(realBase, realState, platform)) continue;
    const prepared = prepareSlotRoot(base, slot, platform);
    if (!prepared) continue;
    if (isWithin(realPathOf(prepared.root), realUsb, platform)
        || isWithin(realPathOf(prepared.root), realState, platform)) {
      try { rmSync(prepared.root, { recursive: true, force: true }); } catch { /* 尽力回滚 */ }
      continue;
    }
    // 本机确认可用后，才把"仅首次"的 UUID 小量写入 stateDir（损坏的旧文件不覆盖）。
    if (idInfo.state === 'missing' && uuid && stateDir) {
      try {
        if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, CACHE_ID_FILE), `${uuid}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch { /* 写失败只是换盘符时缓存不复用，不阻断 */ }
    }
    return { ...prepared, localCacheAvailable: true, cacheId: uuid };
  }

  // 无可用本机候选：不建任何目录、不写 USB、不回落。
  return {
    root: '',
    compileCacheDir: '',
    npmCacheDir: '',
    tempDir: '',
    logDir: '',
    managedBrowserDir: '',
    browserUserDataDir: '',
    localCacheAvailable: false,
    cacheId: idInfo.state === 'valid' ? idInfo.id : null,
    reason: 'no-writable-local-candidate',
  };
}

const OUTPUT_KEYS = Object.freeze({
  root: 'UCLAW_CACHE_ROOT',
  compileCacheDir: 'UCLAW_COMPILE_CACHE_DIR',
  npmCacheDir: 'UCLAW_NPM_CACHE_DIR',
  tempDir: 'UCLAW_TEMP_DIR',
  logDir: 'UCLAW_LOG_DIR',
  managedBrowserDir: 'UCLAW_MANAGED_BROWSER_DIR',
  browserUserDataDir: 'UCLAW_BROWSER_USER_DATA_DIR',
});

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  const stateDir = process.argv[2] || process.env.OPENCLAW_STATE_DIR;
  const usbRoot = process.argv[3] || process.env.UCLAW_DIR;
  const injected = (process.env.UCLAW_CACHE_CANDIDATES || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const c = resolvePortableCache({
      stateDir,
      usbRoot,
      candidates: injected.length ? injected : undefined,
    });
    if (!c.localCacheAvailable) {
      process.stdout.write('UCLAW_LOCAL_CACHE_AVAILABLE=0\n');
      process.stderr.write('[portable-cache] no writable local cache directory; refusing to fall back to the portable drive\n');
      process.exit(1);
    }
    process.stdout.write(
      Object.entries(OUTPUT_KEYS).map(([k, key]) => `${key}=${c[k]}`).join('\n') + '\n'
      + 'UCLAW_LOCAL_CACHE_AVAILABLE=1\n',
    );
    process.exit(0);
  } catch (err) {
    process.stdout.write('UCLAW_LOCAL_CACHE_AVAILABLE=0\n');
    process.stderr.write(`[portable-cache] ${err && err.message}\n`);
    process.exit(1);
  }
}
