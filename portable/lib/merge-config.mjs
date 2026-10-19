// merge-config.mjs — openclaw.json 安全读写：合并写入 + 原子落盘。
//
// 背景（issue #58，微信扫码成功但 clawbot 不响应）：
//   config-server 的 POST /api/config 曾经是整体覆盖写盘（fs.writeFileSync(CONFIG_PATH,
//   JSON.stringify(config))），而旧版配置页（Config.html，已移除）的 buildOpenClawConfig() 每次保存模型配置时
//   只构造 gateway/commands/meta/models/agents 几个字段。用户先扫码连好微信（会往
//   config.plugins.entries['openclaw-weixin'] 写 {enabled:true}），之后只要再回配置页保存
//   一次模型，plugins 整段就被冲掉——UI 上没有任何报错，用户体感是"扫码明明成功了，为什么
//   机器人不理我"。同理受害的还有用户手工加进 openclaw.json 的任何 UI 不认识的字段。
//
// 修法——区分三类顶层字段：
//   - MANAGED_TOP_LEVEL_KEYS（UI 显式管理的）：models / agents / env / gateway / commands / meta。
//     这些字段以"本次请求"为准整体替换（不做深合并），从而天然支持删除
//     （比如用户在 models.providers 里删掉一个 provider，合并不会把它救回来）。
//     如果本次请求没带某个受管字段，视为该字段本次被清空——这跟改造前"整体覆盖"对这几个
//     字段的行为一致，不引入新差异，只是不再殃及无关字段；gateway 见下方单独保底。
//   - REPLACE_IF_PRESENT_KEYS（issue #67）：channels。配置中心已不再编辑渠道，模型页保存也不带它；
//     规则保留，是为了让其他调用方（如 U-King 桌面壳 GET→改→POST）能保存 channels，同时保证
//     保存模型不会冲掉用户经 OpenClaw（`openclaw channels add`）配好的渠道：
//     请求带了且是对象 → 整体替换（同样支持删除）；没带/不是对象 → 保留磁盘版本。
//     不能放进 MANAGED_TOP_LEVEL_KEYS，否则"没带=清空"。
//   - 其余所有顶层字段（plugins、以及任何未来出现的未知字段）：UI 从不碰，就算请求体里出现
//     也无视，一律原样保留磁盘上的版本。
//   - models.providers 里"别的写入方"拥有的条目（options.keepProviders，目前只有虾盘云设备钱包
//     写的 uclaw-cloud）：配置中心 buildConfig() 一次只带用户选中的那一个 provider，按上面
//     "models 整体替换"保存会把已领取额度的凭据冲掉。调用方传 keepProviders=[id…] 后：请求带了
//     models.providers 却没点名这些 id → 把磁盘上的条目原样补回；请求点名了 → 以请求为准；
//     请求根本没带 models → 仍按"未带视为清空"。不传该选项则行为与上面完全一致（#58 的删除
//     语义、钱包 removeKey() 删 uclaw-cloud 都靠这一点）。
//   - options.preserveAdvanced（仅 POST /api/config 传，配置中心专用）：原生高级设置的保留，
//     "未带受管字段 = 保留磁盘版本，带了 = 保留未知层级后按请求更新"：
//       * agents：list、defaults.workspace/tools 等未知字段保留；defaults.model 里请求没带的
//         字段（fallbacks 等）保留，请求带的 primary 生效；
//       * gateway：磁盘上的未知字段（含 auth/remote 的未知子字段）在请求提交时一并保留；
//       * commands：磁盘上的未知命令项在请求提交时保留；meta / env（以及其余受管字段）未带
//         时保留，带了时整体替换。
//     不传该选项 = 上面的默认"未带视为清空"完全不变（wallet removeKey 等调用方都不传，
//     删除语义照旧）。这不是通用深合并框架，只处理上面这些已知层级。
//
// 别做无脑深合并：那会导致"用户在 UI 里删掉的东西被合并救回来"，一个 bug 换一个 bug。
//
// 同时把写盘从"直接 writeFileSync 目标路径"改成"写临时文件 + rename"（rename 在同一文件系统
// 内是原子操作），防止进程被杀/断电时留下半截 JSON 把配置整个报废；写之前尽力把旧文件备份成
// .bak（失败不阻断保存——备份是锦上添花，不是硬依赖）。
//
// 可复用：issue #61「多模型管理」是同一处代码的下一个症状，接下来的多 provider 编辑也建立在
// 这个"合并 + 原子写"地基上，不要在 server.js 里再叠一次一次性补丁。
//
// gateway 例外保底：仍信任任何不带 gateway 的保存请求，并保留磁盘上的 gateway；若它已被
// 旧版页面、上游写盘或第三方工具删掉，则补回本地 token 配置。否则 OpenClaw 会在每次重启时
// 生成新的 runtime token，Dashboard 固定使用 #token=uclaw 会永远得到 401。
// models / agents / env / commands / meta 仍严格遵循下方的受管字段整体替换/删除语义。
//
// 零依赖：只用 node:fs / node:path / node:crypto。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANAGED_TOP_LEVEL_KEYS = Object.freeze([
  'gateway', 'commands', 'meta', 'models', 'agents', 'env',
]);

// 请求里带了（且是对象）才整体替换，没带就保留磁盘版本——语义见文件头注释。
export const REPLACE_IF_PRESENT_KEYS = Object.freeze(['channels']);

const DEFAULT_GATEWAY = Object.freeze({
  mode: 'local',
  auth: Object.freeze({ mode: 'token', token: 'uclaw' }),
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 安全读取磁盘上的 openclaw.json。
 * 文件不存在 / JSON 解析失败 / 内容不是对象，一律返回 {}，绝不抛出——调用方（保存流程）
 * 不能因为读失败就中断，也不能把用户数据当垃圾清零（能保留的字段该保留，读不出来的
 * 那部分本来就没法恢复）。
 */
export function readConfigSafe(configPath) {
  try {
    if (!configPath || !fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // 磁盘上是损坏 JSON：没法恢复它里面的未知字段，但至少不能让保存流程崩掉。
    return {};
  }
}

// ── preserveAdvanced 的两段已知层级合并（配置中心专用，只做这两段，不做通用深合并） ──

// gateway：请求提交时，磁盘上的未知字段保留；auth / remote 各自再保留未知子字段。
function mergeGatewayAdvanced(existingGateway, incomingGateway) {
  const base = isPlainObject(existingGateway) ? existingGateway : {};
  const merged = { ...base, ...incomingGateway };
  for (const key of ['auth', 'remote']) {
    if (isPlainObject(base[key]) && isPlainObject(incomingGateway[key])) {
      merged[key] = { ...base[key], ...incomingGateway[key] };
    }
  }
  return merged;
}

// agents：磁盘上的未知顶层字段（list 等）保留；defaults 里的未知字段（workspace/tools 等）
// 保留；defaults.model 逐字段合并——请求带的 primary 生效，请求没带的（fallbacks 等）保留。
function mergeAgentsAdvanced(existingAgents, incomingAgents) {
  const base = isPlainObject(existingAgents) ? existingAgents : {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(incomingAgents)) {
    if (key === 'defaults' && isPlainObject(value)) {
      const baseDefaults = isPlainObject(base.defaults) ? base.defaults : {};
      const defaults = { ...baseDefaults };
      for (const [dk, dv] of Object.entries(value)) {
        if (dk === 'model' && isPlainObject(dv)) {
          const baseModel = isPlainObject(baseDefaults.model) ? baseDefaults.model : {};
          defaults.model = { ...baseModel, ...dv };
        } else {
          defaults[dk] = dv;
        }
      }
      merged.defaults = defaults;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * 合并现有配置（磁盘上的）与本次请求（前端提交的），返回待写盘的新对象。
 * 见文件头注释：受管字段整体替换（支持删除），channels 带了才整体替换，其余字段原样保留磁盘版本。
 *
 * options.keepProviders：provider ID 数组（默认空）。请求带了 models.providers 但没点名的 ID，
 * 若磁盘上有同名条目就原样补回（深拷贝，不改入参）；不传则与旧行为完全一致。
 * options.preserveAdvanced：true 时受管字段"未带 = 保留磁盘版本，带了 = 保留未知层级后按请求
 * 更新"（见文件头注释）；默认 false 保持"未带视为清空"的删除语义不变。
 */
export function mergeConfig(existingConfig, incomingConfig, options = {}) {
  const existing = isPlainObject(existingConfig) ? existingConfig : {};
  const incoming = isPlainObject(incomingConfig) ? incomingConfig : {};
  const keepProviders = options && Array.isArray(options.keepProviders) ? options.keepProviders : [];
  const preserveAdvanced = !!(options && options.preserveAdvanced === true);

  const merged = { ...existing };

  for (const key of MANAGED_TOP_LEVEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      if (preserveAdvanced && key === 'gateway' && isPlainObject(incoming[key])) {
        merged[key] = mergeGatewayAdvanced(existing[key], incoming[key]);
      } else if (preserveAdvanced && key === 'agents' && isPlainObject(incoming[key])) {
        merged[key] = mergeAgentsAdvanced(existing[key], incoming[key]);
      } else if (preserveAdvanced && key === 'commands' && isPlainObject(incoming[key]) && isPlainObject(existing[key])) {
        merged[key] = { ...existing[key], ...incoming[key] };
      } else {
        merged[key] = incoming[key];
      }
    } else if (!preserveAdvanced && key !== 'gateway') {
      // 默认：未带受管字段视为清空；preserveAdvanced：未带 = 保留磁盘版本。
      delete merged[key];
    }
  }

  // 只有请求自己带了 models.providers 才补回：请求没带 models 时"未带视为清空"照旧，
  // 不能借 keepProviders 把整段 models 救活。补回的条目放在请求自己的 provider 之后，
  // 主模型（agents）一概不碰。
  if (keepProviders.length && isPlainObject(incoming.models) && isPlainObject(incoming.models.providers)) {
    const diskProviders = isPlainObject(existing.models) && isPlainObject(existing.models.providers)
      ? existing.models.providers
      : {};
    let providers = null;
    for (const id of keepProviders) {
      if (typeof id !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(diskProviders, id) || !isPlainObject(diskProviders[id])) continue;
      if (Object.prototype.hasOwnProperty.call(incoming.models.providers, id)) continue;
      if (!providers) providers = { ...incoming.models.providers };
      providers[id] = structuredClone(diskProviders[id]);
    }
    if (providers) merged.models = { ...incoming.models, providers };
  }

  if (!isPlainObject(merged.gateway)) {
    merged.gateway = {
      mode: DEFAULT_GATEWAY.mode,
      auth: { ...DEFAULT_GATEWAY.auth },
    };
  } else {
    if (!isPlainObject(merged.gateway.auth)) {
      merged.gateway.auth = { ...DEFAULT_GATEWAY.auth };
    } else if (!merged.gateway.auth.mode || merged.gateway.auth.mode === 'token') {
      // token 模式下 token 缺失/null/空串都补回——只判空串会漏掉
      // {mode:'token'}（auth 在、token 键没了）这种残缺形态（opus 审码 2.1）。
      const t = merged.gateway.auth.token;
      if (typeof t !== 'string' || t === '') merged.gateway.auth.token = DEFAULT_GATEWAY.auth.token;
    }
  }

  for (const key of REPLACE_IF_PRESENT_KEYS) {
    if (isPlainObject(incoming[key])) merged[key] = incoming[key];
  }

  // 旧版废弃键，留着会让 OpenClaw 报 "agent.* was moved"（挪自原 server.js 逻辑，保持行为不变）。
  delete merged.agent;

  return merged;
}

/**
 * 原子写盘：写临时文件 → rename 到目标路径。
 * rename 在同一文件系统内是原子操作，中途被杀/断电不会留下半截 JSON。
 * 写之前尽力把旧文件备份成 .bak（失败不阻断保存）。
 */
export function writeConfigAtomic(configPath, config) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(configPath, configPath + '.bak');
    } catch {
      // 备份失败不阻断保存——备份是锦上添花，不是硬依赖。
    }
  }

  const tmpPath = path.join(
    dir,
    `.${path.basename(configPath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  fs.renameSync(tmpPath, configPath);
}

/**
 * 一步到位的便捷封装：读现有配置 → 合并 → 原子写回。给 server.js 的 POST /api/config 用。
 * options 原样传给 mergeConfig（目前有 keepProviders / preserveAdvanced），默认不传＝旧行为。
 */
export function saveConfigMerged(configPath, incomingConfig, options = {}) {
  const existing = readConfigSafe(configPath);
  const merged = mergeConfig(existing, incomingConfig, options);
  writeConfigAtomic(configPath, merged);
  return merged;
}
