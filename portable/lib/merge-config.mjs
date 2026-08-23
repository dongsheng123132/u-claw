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
//     字段的行为一致，不引入新差异，只是不再殃及无关字段。
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
// 零依赖：只用 node:fs / node:path / node:crypto。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANAGED_TOP_LEVEL_KEYS = Object.freeze([
  'gateway', 'commands', 'meta', 'models', 'agents', 'env',
]);

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
    } else {
      delete merged[key];
    }
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
 */
export function saveConfigMerged(configPath, incomingConfig) {
  const existing = readConfigSafe(configPath);
  const merged = mergeConfig(existing, incomingConfig);
  writeConfigAtomic(configPath, merged);
  return merged;
}
