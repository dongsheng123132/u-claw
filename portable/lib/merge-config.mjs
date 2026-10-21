// merge-config.mjs — openclaw.json 安全读写：合并写入 + 原子落盘。
//
// 背景（issue #58，微信扫码成功但 clawbot 不响应）：
//   config-server 的 POST /api/config 曾经是整体覆盖写盘（fs.writeFileSync(CONFIG_PATH,
//   JSON.stringify(config))），而 Config.html 的 buildOpenClawConfig() 每次保存模型配置时
//   只构造 gateway/commands/meta/models/agents 几个字段。用户先扫码连好微信（会往
//   config.plugins.entries['openclaw-weixin'] 写 {enabled:true}），之后只要再回配置页保存
//   一次模型，plugins 整段就被冲掉——UI 上没有任何报错，用户体感是"扫码明明成功了，为什么
//   机器人不理我"。同理受害的还有用户手工加进 openclaw.json 的任何 UI 不认识的字段。
//
// 修法——区分两类顶层字段：
//   - MANAGED_TOP_LEVEL_KEYS（UI 显式管理的）：models / agents / env / gateway / commands / meta。
//     这些字段以"本次请求"为准整体替换（不做深合并），从而天然支持删除
//     （比如用户在 models.providers 里删掉一个 provider，合并不会把它救回来）。
//     如果本次请求没带某个受管字段，视为该字段本次被清空——这跟改造前"整体覆盖"对这几个
//     字段的行为一致，不引入新差异，只是不再殃及无关字段；gateway 见下方单独保底。
//   - 其余所有顶层字段（plugins、以及任何未来出现的未知字段）：UI 从不碰，就算请求体里出现
//     也无视，一律原样保留磁盘上的版本。
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

const DEFAULT_GATEWAY = Object.freeze({
  mode: 'local',
  auth: Object.freeze({ mode: 'token', token: 'uclaw' }),
});

// 便携版只提供本地 Web 对话。保留非渠道插件，但旧版聊天平台配置不能随保存复活。
const CHANNEL_PLUGIN_ID = /(?:^|[/@._-])(?:telegram|wechat|weixin|feishu(?:-china)?|lark|qq(?:bot)?|dingtalk|wecom|whatsapp|discord|slack|signal|imessage|bluebubbles|matrix|msteams|mattermost|line|irc|nostr|twitch|tlon|zalo|nextcloud-talk)(?:$|[/@._-])/i;

export function removeChannelConfig(config) {
  delete config.channels;
  if (Array.isArray(config.bindings)) {
    config.bindings = config.bindings.filter((binding) => !binding?.match?.channel);
    if (!config.bindings.length) delete config.bindings;
  }
  if (isPlainObject(config.plugins)) {
    const plugins = structuredClone(config.plugins);
    for (const name of ['entries', 'installs']) {
      if (!isPlainObject(plugins[name])) continue;
      for (const id of Object.keys(plugins[name])) {
        if (CHANNEL_PLUGIN_ID.test(id)) delete plugins[name][id];
      }
      if (!Object.keys(plugins[name]).length) delete plugins[name];
    }
    for (const name of ['allow', 'deny']) {
      if (Array.isArray(plugins[name])) plugins[name] = plugins[name].filter((id) => !CHANNEL_PLUGIN_ID.test(id));
    }
    if (Array.isArray(plugins.load?.paths)) {
      plugins.load.paths = plugins.load.paths.filter((p) => !CHANNEL_PLUGIN_ID.test(String(p).replace(/\\/g, '/')));
    }
    config.plugins = plugins;
    if (!Object.keys(plugins).length) delete config.plugins;
  }
  return config;
}

/** 便携版模型配置收敛：规整虾盘云这条 provider，同时保留用户自接的第三方 provider。 */
export function simplifyPortableConfig(config, opts = {}) {
  const next = removeChannelConfig(structuredClone(isPlainObject(config) ? config : {}));
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(new URL('../models.json', import.meta.url), 'utf8')); } catch {}
  const cloud = catalog?.providers?.find((p) => p.id === 'uclaw-cloud');
  const model = cloud?.model || 'deepseek-v4-flash';
  const provider = next.models?.providers?.['uclaw-cloud'];
  const cloudPrimary = 'uclaw-cloud/' + model;

  // v2.3.2 起恢复第三方 / 自定义 OpenAI 兼容：只规整虾盘云这一条 provider
  // （baseUrl / api / 模型清单），用户自己接的 provider 原样保留。
  // 删除语义仍由上层「受管字段整体替换」保证——用户删掉的 provider 不会被合并救回来。
  const providers = isPlainObject(next.models?.providers) ? { ...next.models.providers } : {};
  if (provider) {
    providers['uclaw-cloud'] = {
      ...provider,
      baseUrl: provider.baseUrl || cloud?.baseUrl || 'https://api.u-claw.org/v1',
      api: 'openai-completions',
      models: [{ id: model, name: model, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    };
  }
  next.models = { mode: 'replace', providers };

  next.agents = isPlainObject(next.agents) ? next.agents : {};
  next.agents.defaults = isPlainObject(next.agents.defaults) ? next.agents.defaults : {};
  const currentPrimary = isPlainObject(next.agents.defaults.model) ? next.agents.defaults.model.primary : '';
  // 钱包领取 / 换钥是显式动作，默认模型切到虾盘云；配置页保存则尊重用户已选的 provider。
  const keepCurrent = !opts.preferCloudPrimary && primaryHasProvider(providers, currentPrimary);
  const primary = keepCurrent ? currentPrimary : cloudPrimary;
  next.agents.defaults.model = { primary };
  const modelsMap = isPlainObject(next.agents.defaults.models) ? { ...next.agents.defaults.models } : {};
  modelsMap[primary] = {};
  next.agents.defaults.models = modelsMap;
  if (Array.isArray(next.agents.list)) {
    for (const agent of next.agents.list) if (isPlainObject(agent) && agent.model) agent.model = primary;
  }
  return next;
}

/** primary 形如 "provider/model"：provider 还在、且模型仍在清单里才算有效。 */
function primaryHasProvider(providers, primary) {
  if (typeof primary !== 'string' || !primary) return false;
  const providerId = primary.split('/')[0];
  const entry = providers[providerId];
  if (!isPlainObject(entry)) return false;
  const models = entry.models;
  if (!Array.isArray(models) || !models.length) return true;
  const modelId = primary.slice(providerId.length + 1);
  return models.some((m) => isPlainObject(m) && m.id === modelId);
}

/** 配置里是否已有可用的模型（provider 存在且带明文 key）——启动时决定要不要用本地钱包补。 */
export function hasUsableModel(config) {
  const providers = isPlainObject(config?.models?.providers) ? config.models.providers : {};
  const primary = config?.agents?.defaults?.model?.primary;
  const candidates = [];
  if (typeof primary === 'string' && primary) candidates.push(primary.split('/')[0]);
  for (const id of Object.keys(providers)) candidates.push(id);
  return candidates.some((id) => {
    const entry = providers[id];
    if (!isPlainObject(entry)) return false;
    const key = entry.apiKey;
    // 明文 Key，或已迁移到密钥库后的 secret-ref（{source:'store'|'saved'}）都算有 Key。
    return (typeof key === 'string' && key !== '') ||
      (isPlainObject(key) && (key.source === 'store' || key.source === 'saved'));
  });
}

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

/**
 * 合并现有配置（磁盘上的）与本次请求（前端提交的），返回待写盘的新对象。
 * 见文件头注释：受管字段整体替换（支持删除），其余字段原样保留磁盘版本。
 */
export function mergeConfig(existingConfig, incomingConfig) {
  const existing = isPlainObject(existingConfig) ? existingConfig : {};
  const incoming = isPlainObject(incomingConfig) ? incomingConfig : {};

  const merged = { ...existing };

  for (const key of MANAGED_TOP_LEVEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      merged[key] = incoming[key];
    } else if (key !== 'gateway') {
      delete merged[key];
    }
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

  // 旧版废弃键，留着会让 OpenClaw 报 "agent.* was moved"（挪自原 server.js 逻辑，保持行为不变）。
  delete merged.agent;

  return removeChannelConfig(merged);
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
 */
export function saveConfigMerged(configPath, incomingConfig) {
  const existing = readConfigSafe(configPath);
  const merged = mergeConfig(existing, incomingConfig);
  writeConfigAtomic(configPath, merged);
  return merged;
}
