// wallet-client.mjs — 虾盘云「设备钱包」：一键领取额度 + 一键充值 + 换一把 + 填一把。
//
// # 红线 1：绝不在启动时静默联网
//
// 本仓 CLAUDE.md 有公开承诺——"U-Claw 不绑定设备、不打指纹、不向 api.u-claw.org 上传任何数据"，
// 2026-06-17 还专门删掉了自动开户的 bootstrap-xiapan.mjs。这个模块里的每一个会联网的导出函数
// （claimWallet / getBalance / rotateWallet / adoptWallet / settlePending）都只应该由用户在
// 配置页上点了按钮之后才被调用——本文件自己不会在 import 时或任何计时器里发起请求，
// 谁在启动链路上调用它，谁就违反了那条承诺。
//
// # 凭证由服务端签发，余额记在钱包上
//
// 状态机和字段命名照抄 v2 商业版 ClawX 的 electron/services/uclaw-device-wallet.ts（同一套
// 服务端协议），但本文件是纯 Node + 零依赖（只用 node: 内置），且**没有硬件指纹迁移这条老路**——
// 开源版从未做过设备指纹，不需要它。
//
// 存储 5 个字段，一个不能少：
//   apiKey      当前生效的凭证
//   walletId    服务端钱包 id，余额挂在它上面
//   pendingKey  已 mint 未 commit 的新凭证（两阶段提交中间态）
//   pendingKind 目前只有 'rotate'；不认识的值不猜（C3）
//   pendingFrom mint 时的旧 key，commit 要用它——不能靠"当前 key"倒推
//
// 存储落**便携目录**（data/.openclaw/uclaw-device.json，跟 U 盘走），绝不落宿主机 —— 这是
// 便携产品，钱包留在客户电脑本地磁盘上等于把能花钱的凭证送人。
//
// 六条硬契约（C1-C6，完整论证见
// ~/Desktop/claude/u-claw/虾盘云==api中装分发和官网/docs/设备钱包-客户端方案.md）：
//   C1 全程不抛异常（含"打开/读取存储文件"那两行）
//   C2 rotate 的验证只用只读接口（GET /v1/models），不消耗额度
//   C3 pendingKind 不认识就原样返回，不猜
//   C4 单一真相源 + in-flight 去重（并发调用复用同一个 Promise）
//   C5 领取/rotate/adopt 三条路径都汇到同一个 applyKey()
//   C6 存储损坏的取舍：get() 抛出时视为"还没绑定"，代价是可能重新领一个空钱包——
//      所以界面必须提供"填入已有密钥"的 adopt 入口。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfigSafe, saveConfigMerged } from './merge-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NETWORK_TIMEOUT_MS = 20_000;
const PENDING_ROTATE = 'rotate';

export const CLOUD_PROVIDER_ID = 'uclaw-cloud';
export const DEFAULT_MODEL_ID = 'deepseek-v4-flash';

// 端点默认值。实测于 2026-08-23（都可用环境变量覆盖）：
//   api.u-claw.org.cn    0.23s   ← 国内可达，默认走它
//   api.u-claw.org       1.34s   国际站，同样活着
//   cloud.u-claw.org.cn  不存在（HTTP 000），别往这里指
//   cloud.u-claw.org     能通但慢 1.6s，且 /recharge 会 302；部分国内网络会被 SNI reset
// 充值页直接用同域的 api.u-claw.org.cn/recharge（实测 200，无跳转）。
const DEFAULT_API_BASE_URL = 'https://api.u-claw.org.cn';
const DEFAULT_PAY_BASE_URL = 'https://api.u-claw.org.cn';

// 虾盘云内部额度单位：500,000 quota = $1（见 虾盘云 docs/api.md）
const QUOTA_PER_USD = 500000;

const EMPTY_STATE = Object.freeze({
  apiKey: '',
  walletId: '',
  pendingKey: '',
  pendingKind: '',
  pendingFrom: '',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function describeError(error) {
  return String((error && error.message) || error || '未知错误');
}

// ---------------------------------------------------------------------------
// 存储：默认落 data/.openclaw/uclaw-device.json（便携目录），可注入用于测试
// ---------------------------------------------------------------------------

export function defaultStorePath() {
  return path.join(__dirname, '..', 'data', '.openclaw', 'uclaw-device.json');
}

export function defaultConfigPath() {
  return path.join(__dirname, '..', 'data', '.openclaw', 'openclaw.json');
}

/** 基于文件的钱包存储。get()/set() 会自然抛出 IO / JSON 错误——调用方负责按 C1 兜住。 */
export function createFileWalletStore(storePath) {
  return {
    async get() {
      if (!fs.existsSync(storePath)) return { ...EMPTY_STATE };
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? { ...EMPTY_STATE, ...parsed } : { ...EMPTY_STATE };
    },
    async set(state) {
      const dir = path.dirname(storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(
        dir,
        `.${path.basename(storePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
      );
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, storePath);
    },
  };
}

/** 内存存储，测试专用。 */
export function createMemoryWalletStore(initial) {
  let state = { ...EMPTY_STATE, ...(initial || {}) };
  return {
    async get() {
      return { ...state };
    },
    async set(next) {
      state = { ...next };
    },
  };
}

function defaultStore() {
  return createFileWalletStore(defaultStorePath());
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key[0] + '***';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

// ---------------------------------------------------------------------------
// HTTP —— 只在被调用时才碰网络
// ---------------------------------------------------------------------------

function apiBaseUrl(override) {
  return String(override || process.env.UCLAW_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

export function payBaseUrl(override) {
  return String(override || process.env.UCLAW_PAY_BASE_URL || DEFAULT_PAY_BASE_URL).replace(/\/+$/, '');
}

function joinUrl(base, p) {
  return `${base.replace(/\/+$/, '')}${p.startsWith('/') ? p : `/${p}`}`;
}

async function devicePost(pathName, payload, fetchImpl, apiBaseOverride) {
  const base = apiBaseUrl(apiBaseOverride);
  const res = await fetchImpl(joinUrl(base, pathName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body || {} };
}

/**
 * rotate/adopt 之后要不要生效的唯一判据：服务端认不认这把 key。
 * **只读**——查模型清单，不消耗额度。用真实模型调用来验的话，一把 0 余额的新 key 永远验不过（C2）。
 */
async function defaultVerifyReadOnly(apiKey, apiBaseOverride, fetchImpl = fetch) {
  try {
    const base = apiBaseUrl(apiBaseOverride);
    const res = await fetchImpl(joinUrl(base, '/v1/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// C5 汇流点：换 key 之后必须同步到实际用 key 的地方——只此一处
// ---------------------------------------------------------------------------

function buildProviderEntry(apiKey, apiBase) {
  return {
    baseUrl: apiBase || `${apiBaseUrl()}/v1`,
    apiKey,
    api: 'openai-completions',
    models: [
      {
        id: DEFAULT_MODEL_ID,
        name: DEFAULT_MODEL_ID,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
}

/**
 * 把一把新 key 写进 openclaw.json 的 uclaw-cloud provider（+ 默认设为主模型）。
 *
 * 复用 merge-config.mjs 的合并写入 + 原子落盘——绝不自己 writeFileSync，否则会把用户的
 * plugins（比如微信登录写入的 config.plugins.entries）静默冲掉，那正是 issue #58 刚修的 bug。
 *
 * 领取 / rotate / adopt 三条路径都必须调用这一个函数，漏一条就是一个 bug（C5）。
 */
export function applyKey(configPath, apiKey, opts = {}) {
  const existing = readConfigSafe(configPath);
  const models = isPlainObject(existing.models) ? { ...existing.models } : {};
  const providers = isPlainObject(models.providers) ? { ...models.providers } : {};
  providers[CLOUD_PROVIDER_ID] = buildProviderEntry(apiKey, opts.apiBase);
  models.providers = providers;
  models.mode = models.mode || 'merge';

  const incoming = { ...existing, models };

  // 主模型归属：默认「空位才占」——不抢用户已经配好的 provider。
  //
  // 领取额度是为了让没配过模型的人立刻能用，不是为了把付费用户设好的 MiniMax/DeepSeek
  // 换掉。商业版 ClawX 早有定论：「付费用户的默认模型必须活过重启」，这里遵循同一条。
  //
  //   setPrimary === false → 永不设置
  //   setPrimary === true  → 强制设置（留给"设为主模型"这类用户显式动作）
  //   未传（默认）          → 只在没有可用主模型、或主模型本来就指向本 provider 时才设置
  const currentPrimary =
    isPlainObject(existing.agents) &&
    isPlainObject(existing.agents.defaults) &&
    isPlainObject(existing.agents.defaults.model)
      ? String(existing.agents.defaults.model.primary || '').trim()
      : '';
  const primaryIsVacant = !currentPrimary || currentPrimary.startsWith(`${CLOUD_PROVIDER_ID}/`);
  const shouldSetPrimary =
    opts.setPrimary === true || (opts.setPrimary !== false && primaryIsVacant);

  if (shouldSetPrimary) {
    const agents = isPlainObject(existing.agents) ? { ...existing.agents } : {};
    const defaults = isPlainObject(agents.defaults) ? { ...agents.defaults } : {};
    defaults.model = { ...(isPlainObject(defaults.model) ? defaults.model : {}), primary: `${CLOUD_PROVIDER_ID}/${DEFAULT_MODEL_ID}` };
    agents.defaults = defaults;
    incoming.agents = agents;
  }

  return saveConfigMerged(configPath, incoming);
}

/** 移除 uclaw-cloud provider（reset-local 用）。若主模型正指向它，一并清空，避免残留死指针。 */
export function removeKey(configPath) {
  const existing = readConfigSafe(configPath);
  const models = isPlainObject(existing.models) ? { ...existing.models } : {};
  const providers = isPlainObject(models.providers) ? { ...models.providers } : {};
  if (CLOUD_PROVIDER_ID in providers) {
    const next = { ...providers };
    delete next[CLOUD_PROVIDER_ID];
    models.providers = next;
  }
  const incoming = { ...existing, models };

  const primary =
    existing.agents && existing.agents.defaults && existing.agents.defaults.model
      ? existing.agents.defaults.model.primary
      : '';
  if (typeof primary === 'string' && primary.startsWith(`${CLOUD_PROVIDER_ID}/`)) {
    const agents = { ...existing.agents, defaults: { ...existing.agents.defaults, model: {} } };
    incoming.agents = agents;
  }

  return saveConfigMerged(configPath, incoming);
}

function applyKeyToConfig(apiKey, deps) {
  const configPath = deps.configPath || defaultConfigPath();
  return applyKey(configPath, apiKey, { apiBase: deps.apiBase, setPrimary: deps.setPrimary });
}

function removeKeyFromConfig(deps) {
  const configPath = deps.configPath || defaultConfigPath();
  return removeKey(configPath);
}

// ---------------------------------------------------------------------------
// 本地状态（不联网）
// ---------------------------------------------------------------------------

/** 纯本地读取，供配置页首屏渲染用——绝不触网。 */
export async function getStatus(deps = {}) {
  const store = deps.store || defaultStore();
  try {
    const state = await store.get();
    return {
      ok: true,
      hasWallet: !!state.apiKey,
      // 本地配置页需要完整 key 才能实现「复制密钥」——openclaw.json 里本来就明文存着它，
      // 这里不隐藏不引入新的暴露面；maskedKey 只是给默认展示用的脱敏文案。
      apiKey: state.apiKey || '',
      maskedKey: maskKey(state.apiKey),
      walletId: state.walletId || '',
      hasPending: !!state.pendingKey,
      pendingKind: state.pendingKind || '',
    };
  } catch (error) {
    // C1/C6：存储打不开就当"还没绑定"，代价是界面必须留 adopt 入口。
    return { ok: false, error: describeError(error), hasWallet: false, apiKey: '', maskedKey: '', hasPending: false, pendingKind: '' };
  }
}

// ---------------------------------------------------------------------------
// settlePending：把上次没走完的两阶段提交收尾
// ---------------------------------------------------------------------------

async function settlePendingState(state, store, fetchImpl, verify, deps) {
  const pending = state.pendingKey;
  if (!pending) return state;

  // C3：pendingKind 不认识就原样返回，不猜——rotate 之外目前没有第二条链路，
  // 但字段可能被老版本/坏文件写成别的值，宁可什么都不做也不能拿旧 key 冒险乱套流程。
  if (state.pendingKind !== PENDING_ROTATE) {
    return state;
  }

  // C2：只读验证，不消耗额度。验不过就保留现状，下次再试。
  const ok = await verify(pending, deps.apiBase, fetchImpl);
  if (!ok) return state;

  const from = state.pendingFrom || state.apiKey;
  const res = await devicePost('/device/rotate/commit', { currentKey: from, newKey: pending }, fetchImpl, deps.apiBase);
  if (res.status !== 200) return state;

  const next = { ...state, apiKey: pending, pendingKey: '', pendingKind: '', pendingFrom: '' };
  await store.set(next);
  applyKeyToConfig(next.apiKey, deps); // C5：换 key 后同步到实际消费者
  return next;
}

/** 用户点了任意会联网的按钮时，先把上次没走完的收尾——不需要单独暴露成入口按钮。 */
export async function settlePending(deps = {}) {
  const store = deps.store || defaultStore();
  const fetchImpl = deps.fetch || fetch;
  const verify = deps.verifyReadOnly || defaultVerifyReadOnly;

  let state;
  try {
    state = await store.get();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  try {
    if (!state.pendingKey) return { ok: true, settled: false, apiKey: state.apiKey };
    const next = await settlePendingState(state, store, fetchImpl, verify, deps);
    return { ok: true, settled: next.pendingKey !== state.pendingKey || next.apiKey !== state.apiKey, apiKey: next.apiKey };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// claimWallet —— 用户点「一键领取额度」
// ---------------------------------------------------------------------------

// C4：并发去重。首屏按钮被手抖点两下、或配置页多个标签页同时点，
// 第二次不该再发一次 bind——两次 bind 会拿到两个钱包，界面上"哪个是我的"就乱了。
let claimInFlight = null;

export async function claimWallet(deps = {}) {
  if (claimInFlight) return claimInFlight;
  claimInFlight = doClaim(deps).finally(() => {
    claimInFlight = null;
  });
  return claimInFlight;
}

async function doClaim(deps) {
  const store = deps.store || defaultStore();
  const fetchImpl = deps.fetch || fetch;
  const verify = deps.verifyReadOnly || defaultVerifyReadOnly;

  let state;
  try {
    state = await store.get();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  // 领取失败要给普通用户看得懂的话。「HTTP 429」对客户是天书，而 429 恰恰是最常撞上的一种：
  // 服务端对匿名 bind 有限流（规范要求，防薅羊毛），同一网络下多人同时插 U 盘就会撞到。
  // 实测 2026-08-23：限流返回 429 {"error":"rate-limited"}。
  function describeClaimFailure(res) {
    if (res.status === 429) {
      return '领取的人太多，服务器让稍等一下。过几分钟再点一次就行（也可以先在下方"高级"里填自己的 API Key）。';
    }
    if (res.status === 0 || res.status >= 500) {
      return '连不上虾盘云服务器。检查一下网络，或稍后再试。';
    }
    const detail = res.body && res.body.error ? `（${res.body.error}）` : '';
    return `领取失败：HTTP ${res.status}${detail}`;
  }

  try {
    if (state.pendingKey) {
      state = await settlePendingState(state, store, fetchImpl, verify, deps);
    }
    if (state.apiKey) {
      return { ok: true, apiKey: state.apiKey, walletId: state.walletId, alreadyClaimed: true };
    }

    const res = await devicePost('/device/bind', {}, fetchImpl, deps.apiBase);
    if (res.status !== 200 || !res.body.apiKey) {
      return { ok: false, error: describeClaimFailure(res) };
    }

    const next = { ...EMPTY_STATE, apiKey: res.body.apiKey, walletId: res.body.walletId || '' };
    await store.set(next);
    applyKeyToConfig(next.apiKey, deps); // C5
    return { ok: true, apiKey: next.apiKey, walletId: next.walletId, alreadyClaimed: false };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// getBalance —— 用户点「刷新余额」
// ---------------------------------------------------------------------------

export async function getBalance(deps = {}) {
  const store = deps.store || defaultStore();
  const fetchImpl = deps.fetch || fetch;

  let state;
  try {
    state = await store.get();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  if (!state.apiKey) return { ok: false, error: '还没有设备钱包' };

  try {
    const base = apiBaseUrl(deps.apiBase);
    const headers = {
      Authorization: `Bearer ${state.apiKey}`,
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    };
    const today = deps.today || new Date().toISOString().slice(0, 10);

    // 两个 OpenAI 兼容的 billing 接口，实测于 api.u-claw.org.cn（2026-08-23）：
    //   /v1/dashboard/billing/subscription → { hard_limit_usd }
    //   /v1/dashboard/billing/usage        → { total_usage }   单位是 USD×100
    //   剩余 USD = hard_limit_usd - total_usage / 100
    // 换算：500,000 quota = $1（见虾盘云 docs/api.md）
    const [subRes, usageRes] = await Promise.all([
      fetchImpl(joinUrl(base, '/v1/dashboard/billing/subscription'), {
        headers: { Authorization: headers.Authorization },
        signal: headers.signal,
      }),
      fetchImpl(
        joinUrl(base, `/v1/dashboard/billing/usage?start_date=2020-01-01&end_date=${today}`),
        { headers: { Authorization: headers.Authorization }, signal: headers.signal }
      ),
    ]);

    if (!subRes.ok) return { ok: false, error: `查询余额失败：HTTP ${subRes.status}` };
    if (!usageRes.ok) return { ok: false, error: `查询用量失败：HTTP ${usageRes.status}` };

    const sub = await subRes.json().catch(() => ({}));
    const usage = await usageRes.json().catch(() => ({}));

    const hardLimitUsd = Number(sub.hard_limit_usd);
    const totalUsageUsd = Number(usage.total_usage) / 100;
    if (!Number.isFinite(hardLimitUsd) || !Number.isFinite(totalUsageUsd)) {
      return { ok: false, error: '余额返回格式不认识' };
    }

    const remainingUsd = hardLimitUsd - totalUsageUsd;
    return {
      ok: true,
      remainingUsd,
      usedUsd: totalUsageUsd,
      grantedUsd: hardLimitUsd,
      // quota 是服务端的内部单位，界面上按「可用 token 数」展示更直观
      remainingQuota: Math.round(remainingUsd * QUOTA_PER_USD),
      usedQuota: Math.round(totalUsageUsd * QUOTA_PER_USD),
      grantedQuota: Math.round(hardLimitUsd * QUOTA_PER_USD),
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// rotateWallet —— 用户点「换一把」（二次确认在界面层做）
// ---------------------------------------------------------------------------

let rotateInFlight = null;

export async function rotateWallet(deps = {}) {
  if (rotateInFlight) return rotateInFlight;
  rotateInFlight = doRotate(deps).finally(() => {
    rotateInFlight = null;
  });
  return rotateInFlight;
}

async function doRotate(deps) {
  const store = deps.store || defaultStore();
  const fetchImpl = deps.fetch || fetch;
  const verify = deps.verifyReadOnly || defaultVerifyReadOnly;

  let state;
  try {
    state = await store.get();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  try {
    if (!state.apiKey) return { ok: false, error: '还没有设备钱包，请先领取' };

    // 有没有上次没走完的？续用它，别再 mint 一把——否则会在服务端堆没人用的 token。
    if (!state.pendingKey) {
      const res = await devicePost('/device/rotate', { currentKey: state.apiKey }, fetchImpl, deps.apiBase);
      if (res.status !== 200 || !res.body.apiKey) {
        return { ok: false, error: `换密钥失败：HTTP ${res.status} ${res.body?.error || ''}`.trim() };
      }
      state = {
        ...state,
        walletId: res.body.walletId || state.walletId,
        pendingKey: res.body.apiKey,
        pendingKind: PENDING_ROTATE,
        pendingFrom: state.apiKey,
      };
      await store.set(state);
    }

    const before = state.apiKey;
    state = await settlePendingState(state, store, fetchImpl, verify, deps);
    if (state.apiKey === before) {
      return { ok: false, error: '新密钥验证未通过，已保留旧密钥，请稍后重试' };
    }
    return { ok: true, apiKey: state.apiKey, walletId: state.walletId };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// adoptWallet —— 用户点「填入已有密钥」
// ---------------------------------------------------------------------------

/**
 * 只验一次，不调服务端 bind/rotate——凭证的本质是"一张充值卡"，服务端认的是卡本身，
 * 不关心它躺在哪台机器上。所以"把 A 电脑的 key 抄到 B 电脑"= 把字符串写进配置，没有第二步。
 */
export async function adoptWallet(key, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const verify = deps.verifyReadOnly || defaultVerifyReadOnly;
  const trimmed = String(key ?? '').trim();

  if (!trimmed) return { ok: false, error: '请先填入密钥' };
  if (!trimmed.startsWith('sk-') || trimmed.length < 8) {
    return { ok: false, error: '这不像一把虾盘云密钥（应以 sk- 开头）' };
  }
  if (/\s/.test(trimmed)) return { ok: false, error: '密钥里混进了空格或换行，请重新复制' };

  try {
    const ok = await verify(trimmed, deps.apiBase, fetchImpl);
    if (!ok) return { ok: false, error: '这把密钥用不了，没有保存' };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  const store = deps.store || defaultStore();
  try {
    await store.set({ ...EMPTY_STATE, apiKey: trimmed, walletId: '' });
    applyKeyToConfig(trimmed, deps); // C5
    return { ok: true, apiKey: trimmed };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// resetLocalWallet —— 用户点「移除本机钱包」（危险区，界面层要求先备份 + 二次确认）
// ---------------------------------------------------------------------------

/**
 * 只清本地五字段 + 清实际消费者（openclaw.json 里的 provider），绝不调服务端删钱包/清余额——
 * 旧钱包余额不受影响，旧 key 之后仍可在别的机器上 adopt 回来。
 */
export async function resetLocalWallet(deps = {}) {
  const store = deps.store || defaultStore();

  let state;
  try {
    state = await store.get();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  // C3：遇到不认识的 pendingKind，拒绝执行，本地状态不变——宁可什么都不做。
  if (state.pendingKey && state.pendingKind !== PENDING_ROTATE && state.pendingKind !== '') {
    return { ok: false, error: '有未识别的待处理操作，为安全起见拒绝清除，请联系支持' };
  }

  try {
    try {
      removeKeyFromConfig(deps); // 先清实际消费者
    } catch {
      // 清 provider 失败不阻断清钱包——本地状态优先清干净，config 那半留给下次 applyKey 修。
    }
    await store.set({ ...EMPTY_STATE });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
