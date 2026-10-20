// uclaw-cloud-endpoints.mjs — 虾盘云端点解析 + 故障切换（failover）。
//
// 移植自 v2 商业版 ClawX 的 electron/services/providers/uclaw-cloud-endpoint.ts
// （2026-08-24 同步，同一套端点策略），但按本仓约束裁剪：
//   - 纯 Node + 零依赖（node: 内置），供 config-server / wallet-client 使用
//   - 绝不在 import 时联网；只在被调用的接口函数里探测/重试
//
// 为什么需要它（ClawX exFAT 交接单的坑 #4）：
//
//   出厂默认端点是 api.u-claw.org.cn（国内可达）。那台服务器「抖一下」或被 SNI
//   reset 时，好 key 当场被拒——用户看到的是「这把密钥用不了」。修复不是换默认
//   端点，而是：网络层失败 / 5xx / 404 时自动改打 api.u-claw.org（国际站）。
//   鉴权失败（401/403）和限流（429）是服务端的权威判决，**绝不**靠换域名绕过。
//
// 运营方可以放一份 uclaw-cloud-endpoints.json 在 portable 根目录（Windows 下即
// U-Claw.exe/U-Claw 文件夹旁）覆盖内置清单，无需重新发版：
//
//   {
//     "version": 1,
//     "endpoints": [
//       { "id": "primary",  "apiBase": "https://api.u-claw.org.cn/v1", "payBase": "https://api.u-claw.org.cn" },
//       { "id": "fallback", "apiBase": "https://api.u-claw.org/v1",    "payBase": "https://api.u-claw.org" }
//     ]
//   }
//
//   version 必须 = 1；endpoints 最多 4 条；apiBase/payBase 必须是 https URL；
//   无效或缺失时静默退回内置清单（与 ClawX 行为一致）。

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ENDPOINT_CONFIG_FILENAME = 'uclaw-cloud-endpoints.json';

// 内置清单（与 ClawX 的 electron/shared/providers/uclaw-cloud-endpoints.json 保持一致）。
const BUNDLED_ENDPOINTS = Object.freeze([
  Object.freeze({ id: 'primary', apiBase: 'https://api.u-claw.org.cn/v1', payBase: 'https://api.u-claw.org.cn' }),
  Object.freeze({ id: 'fallback', apiBase: 'https://api.u-claw.org/v1', payBase: 'https://api.u-claw.org' }),
]);

const PROBE_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 20000;

function validHttpsBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return value.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * 有序端点候选。configPath 可注入（测试用）；默认找 portable 根目录下的
 * uclaw-cloud-endpoints.json（lib/ 的上一级）。文件缺失/无效 → 内置清单。
 */
export function loadEndpointCandidates(configPath = join(__dirname, '..', ENDPOINT_CONFIG_FILENAME)) {
  if (!existsSync(configPath)) return BUNDLED_ENDPOINTS.map((e) => ({ ...e }));
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    if (parsed.version !== 1 || !Array.isArray(parsed.endpoints)) {
      throw new Error('unsupported config shape');
    }
    const candidates = parsed.endpoints.slice(0, 4).flatMap((entry, index) => {
      const apiBase = validHttpsBase(entry.apiBase);
      const payBase = validHttpsBase(entry.payBase);
      if (!apiBase || !payBase) return [];
      return [{
        id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `endpoint-${index + 1}`,
        apiBase,
        payBase,
      }];
    });
    if (candidates.length === 0) throw new Error('no valid HTTPS endpoint');
    // 按 (apiBase, payBase) 去重，保持首次出现的顺序
    return candidates.filter((c, i) =>
      candidates.findIndex((x) => x.apiBase === c.apiBase && x.payBase === c.payBase) === i
    );
  } catch {
    return BUNDLED_ENDPOINTS.map((e) => ({ ...e }));
  }
}

export function joinUrl(base, pathName) {
  return `${base.replace(/\/+$/, '')}${pathName.startsWith('/') ? pathName : `/${pathName}`}`;
}

/** 把 apiBase（可能带 /v1 后缀）还原成 origin，用于打任意路径的 API。 */
export function apiOrigin(apiBase) {
  return new URL(apiBase).origin;
}

async function probeBaseUrl(fetchImpl, baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // HEAD /models：路由和网络路径有应答即可（<500 都算活）。
    // 401/403/404 说明域名活着、只是没带凭证/没这条路由 —— 不该因此换域名。
    const res = await fetchImpl(joinUrl(baseUrl, '/models'), { method: 'HEAD', signal: controller.signal });
    return !!res && res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测出第一个可用的端点。全部不通时 fail-soft 回第一候选（origin:
 * 'primary-unverified'），由调用方向用户报网络错误——启动链路绝不能因为
 * 探测失败而崩掉。
 */
export async function detectBestEndpoint(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  for (const [index, candidate] of loadEndpointCandidates(deps.configPath).entries()) {
    if (await probeBaseUrl(fetchImpl, candidate.apiBase)) {
      return { ...candidate, origin: index === 0 ? 'primary' : 'fallback' };
    }
  }
  const primary = loadEndpointCandidates(deps.configPath)[0];
  return { ...primary, origin: 'primary-unverified' };
}

/** 这些状态码才允许换下一个域名：网络异常（throw）、5xx、404（该边缘缺此路由）。 */
function shouldFailover(statusOrError) {
  return statusOrError instanceof Error || statusOrError === 404 || (typeof statusOrError === 'number' && statusOrError >= 500);
}

/**
 * 带 failover 的 API 调用：先打探测出的最优端点，失败（且允许切换）时按序
 * 重试其余候选。返回 { ok, status, body, endpointUsed } 形状与
 * wallet-client.mjs 现有的消费方式对齐。
 */
export async function fetchWithFailover(pathName, init = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const seen = new Set();
  const bases = [];
  for (const c of loadEndpointCandidates(deps.configPath)) {
    const origin = apiOrigin(c.apiBase);
    if (!seen.has(origin)) {
      seen.add(origin);
      bases.push(origin);
    }
  }

  let lastResponse = null;
  let lastError = null;
  for (let i = 0; i < bases.length; i++) {
    const url = joinUrl(bases[i], pathName);
    try {
      const res = await fetchImpl(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!shouldFailover(res.status)) {
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body: body || {}, endpointUsed: bases[i] };
      }
      lastResponse = res;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) {
    const body = await lastResponse.json().catch(() => ({}));
    return { ok: lastResponse.ok, status: lastResponse.status, body: body || {}, endpointUsed: bases[0] };
  }
  throw lastError instanceof Error ? lastError : new Error(`没有可用的虾盘云端点：${pathName}`);
}
