// update-channel.mjs — U-Claw 更新通道（stable / extended-stable）+ 上游版本查询 + 版本比较
//
// 背景（为什么有这个东西）：
//   上游 openclaw 的 npm dist-tags 同时挂着几条线，客户机要的是"保守通道"：
//     latest          → 最新稳定版（激进，追新版）
//     extended-stable → 长期支持线（保守，晚一点但少踩坑）
//   2026-11 实测：latest=2026.10.9、extended-stable=2026.9.36、beta=2026.10.10-beta.5。
//   U-Claw 默认走 stable（= today 的行为），想稳的机器可以切到 extended-stable。
//
// 三条硬约定（全部 fail-soft，绝不上抛）：
//   1. resolveChannel({ env, stateDir })  → 'stable' | 'extended-stable'
//        优先级：环境变量 UCLAW_UPDATE_CHANNEL > <stateDir>/update-channel.json 的 { channel }
//        > 默认 stable。非法/坏文件/读不到 → 回落 stable，不抛。
//   2. getChannelVersion(channel, { fetchImpl, timeoutMs }) → { ok, version, checkedAt, channel, error? }
//        打 npmmirror 的包元数据取 dist-tags，AbortController 硬超时（默认 5000ms）。
//        网络失败/超时/响应坏/缺 dist-tag → { ok:false, version:null, error }，绝不抛。
//   3. compareVersions(a, b) → -1 | 0 | 1
//        日期式版本按数字段比：2026.10.9 > 2026.9.36（不是字符串比较）。
//        容错：前缀 v、段数不同（缺的段按 0）、预发布后缀按 semver 语义排在同版本号之前。
//
// 零依赖（只用 node: 内置），import 时不联网——只在 getChannelVersion() 被调用时发请求。
//
// 只在 npmmirror 现网可用的两个小细节：
//   - 完整 packument 有 ~21MB（openclaw 版本历史太长），所以请求带
//     Accept: application/vnd.npm.install-v1+json（npm 的 abbreviated 格式），
//     响应缩到 ~1MB 且仍带 dist-tags。别把这个头删了，否则每次检查烧 21MB 流量。
//   - 可用 UCLAW_UPDATE_REGISTRY_URL 覆盖 registry 地址（换 npmjs 官方源 / 内网镜像 /
//     测试用 127.0.0.1 假源）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHANNEL_STABLE = 'stable';
export const CHANNEL_EXTENDED_STABLE = 'extended-stable';
export const DEFAULT_CHANNEL = CHANNEL_STABLE;

/** 通道清单（顺序即 UI/文档里的推荐顺序：默认 stable 在第一个）。 */
export const CHANNELS = Object.freeze([CHANNEL_STABLE, CHANNEL_EXTENDED_STABLE]);

/** 通道 → npm dist-tag。上游新增通道时在这里加一行即可。 */
export const CHANNEL_DIST_TAGS = Object.freeze({
  [CHANNEL_STABLE]: 'latest',
  [CHANNEL_EXTENDED_STABLE]: 'extended-stable',
});

/** 环境变量名：UCLAW_UPDATE_CHANNEL=stable|extended-stable */
export const UPDATE_CHANNEL_ENV = 'UCLAW_UPDATE_CHANNEL';
/** stateDir 下的覆盖文件名：{ "channel": "extended-stable" } */
export const UPDATE_CHANNEL_STATE_FILE = 'update-channel.json';
/** registry 覆盖环境变量（换源/测试用，一般不用设）。 */
export const UPDATE_REGISTRY_ENV = 'UCLAW_UPDATE_REGISTRY_URL';

/** 默认 registry（国内 npmmirror，与仓库其它下载保持一致）。 */
export const DEFAULT_REGISTRY_URL = 'https://registry.npmmirror.com/openclaw';

export const DEFAULT_TIMEOUT_MS = 5000;

// npm abbreviated packument 的媒体类型：响应体积从 ~21MB 降到 ~1MB，dist-tags 不变。
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json';

/**
 * 规范化通道名：去空白、忽略大小写；不是已知通道就返回 null（调用方决定回落）。
 * 不做 trim 后的模糊匹配（"extended" / "conservative" 之类的别名一律不认，
 * 免得客户机配置文件写错了还被静默"猜"成另一条线）。
 */
export function normalizeChannel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return CHANNELS.includes(normalized) ? normalized : null;
}

function readChannelFromState(stateDir) {
  try {
    if (typeof stateDir !== 'string' || !stateDir.trim()) return null;
    const filePath = join(stateDir, UPDATE_CHANNEL_STATE_FILE);
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalizeChannel(parsed && parsed.channel);
  } catch {
    // 文件不存在 / 坏 JSON / 无权限 → 静默忽略
    return null;
  }
}

/**
 * 解析最终生效的更新通道。
 * 优先级：env UCLAW_UPDATE_CHANNEL > <stateDir>/update-channel.json 的 channel > stable。
 * env 一旦设置了（非空白）就以它为准：值非法时回落 stable，而不是继续读文件——
 * 环境变量是运维/脚本的显式意图，"写错了"应该表现为稳定的默认行为，便于发现。
 */
export function resolveChannel({ env = process.env, stateDir } = {}) {
  try {
    const envValue = env && typeof env === 'object' ? env[UPDATE_CHANNEL_ENV] : undefined;
    if (typeof envValue === 'string' && envValue.trim()) {
      return normalizeChannel(envValue) || DEFAULT_CHANNEL;
    }
    return readChannelFromState(stateDir) || DEFAULT_CHANNEL;
  } catch {
    return DEFAULT_CHANNEL;
  }
}

/** 通道对应的 npm dist-tag（非法通道按 stable 处理）。 */
export function channelToDistTag(channel) {
  const resolved = normalizeChannel(channel) || DEFAULT_CHANNEL;
  return CHANNEL_DIST_TAGS[resolved];
}

function resolveRegistryUrl(registryUrl) {
  if (typeof registryUrl === 'string' && registryUrl.trim()) return registryUrl.trim();
  const fromEnv = process.env[UPDATE_REGISTRY_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_REGISTRY_URL;
}

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
}

/**
 * 查通道当前最新上游版本。
 *
 * @param {string} channel 'stable' | 'extended-stable'（非法值按 stable 处理）
 * @param {{ fetchImpl?: Function, timeoutMs?: number, registryUrl?: string }} [options]
 * @returns {Promise<{ok: boolean, version: string|null, checkedAt: string, channel: string, error?: string}>}
 *
 * 约定：任何失败都返回 { ok:false, error }，绝不 throw；version 失败时为 null。
 * fetchImpl 可注入（测试用），默认用全局 fetch。
 */
export async function getChannelVersion(channel, options = {}) {
  const resolvedChannel = normalizeChannel(channel) || DEFAULT_CHANNEL;
  const distTag = CHANNEL_DIST_TAGS[resolvedChannel];
  const checkedAt = new Date().toISOString();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const fail = (error) => ({ ok: false, version: null, checkedAt, channel: resolvedChannel, error });

  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return fail('fetch unavailable');

  const url = resolveRegistryUrl(options.registryUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        accept: REGISTRY_ACCEPT,
        'cache-control': 'no-cache',
      },
    });

    if (!res || typeof res !== 'object') return fail('empty response');
    // 简单 mock 可能没给 ok 字段：只有明确 false 才算 HTTP 失败
    if (res.ok === false) return fail(`HTTP ${res.status || 'error'}`);

    let doc;
    try {
      doc = await res.json();
    } catch {
      return fail('invalid JSON');
    }

    const tags = doc && doc['dist-tags'];
    if (!tags || typeof tags !== 'object') return fail('missing dist-tags');

    const version = tags[distTag];
    if (typeof version !== 'string' || !version.trim()) return fail(`missing dist-tag "${distTag}"`);

    return { ok: true, version: version.trim(), checkedAt, channel: resolvedChannel };
  } catch (err) {
    // AbortController 超时（fetch 被 abort）映射成语义明确的 'timeout'，其余用原始 message
    return fail(isAbortError(err) ? 'timeout' : (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
}

// ── 版本比较 ──────────────────────────────────────────────────────────────────

/**
 * 解析 "2026.10.9" / "v2026.10.9" / "2026.10.10-beta.5" / "2026.10.9+build.7"。
 * 无法解析返回 null（由 compareVersions 当作"不可比"处理）。
 */
function parseVersion(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const match = /^[vV]?([0-9]+(?:\.[0-9]+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!match) return null;
  return {
    numbers: match[1].split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: match[2] ? match[2].split('.') : null,
  };
}

/** semver 预发布段比较：数字段按数值、字母段按字典序，数字段 < 字母段，段少者 < 段多者。 */
function comparePrerelease(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    const xNum = /^[0-9]+$/.test(x);
    const yNum = /^[0-9]+$/.test(y);
    if (xNum && yNum) {
      const nx = Number.parseInt(x, 10);
      const ny = Number.parseInt(y, 10);
      if (nx > ny) return 1;
      if (nx < ny) return -1;
    } else if (xNum) {
      return -1;
    } else if (yNum) {
      return 1;
    } else if (x > y) {
      return 1;
    } else if (x < y) {
      return -1;
    }
  }
  return 0;
}

/**
 * 比较两个版本号（a 相对 b）：a<b 返回 -1，相等 0，a>b 返回 1。
 *
 * 必须是**数字段**比较：上游是日期式版本，字符串比较会把 2026.10.9 判成小于
 * 2026.9.36（'1' < '9'），于是保守通道误报"已是最新"——这正是要回归的坑。
 * 容错：
 *   - 前缀 v（v2026.10.9）
 *   - 段数不同：缺的段按 0（2026.10 == 2026.10.0）
 *   - 预发布（2026.10.10-beta.5 < 2026.10.10；无预发布后缀的版本更大）
 *   - 无法解析的入参 → 返回 0（视为相等：宁可不上报更新，也不误报/误导流）
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;

  const len = Math.max(pa.numbers.length, pb.numbers.length);
  for (let i = 0; i < len; i++) {
    const x = pa.numbers[i] || 0;
    const y = pb.numbers[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }

  // 数字段相同 → 按 semver 预发布语义：带预发布后缀的版本更小
  if (pa.prerelease === null && pb.prerelease !== null) return 1;
  if (pa.prerelease !== null && pb.prerelease === null) return -1;
  if (pa.prerelease !== null && pb.prerelease !== null) {
    return comparePrerelease(pa.prerelease, pb.prerelease);
  }
  return 0;
}
