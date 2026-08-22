// config.mjs —— openclaw.json 的读写动作
//
// 改造前这个动作有两份实现，行为还不一致：
//   - Config.html:531  存模型  → buildOpenClawConfig() 从零构造后整份 POST
//   - Config.html:692  存渠道  → 先 GET 再 merge 后 POST
//   - config-server/server.js  微信登录成功后又直接 writeFileSync 一次
// 结果：用户接完微信、再回配置中心改个模型，channels 和 plugins 被整份冲掉，
// 微信直接掉线。宪法 #8（一份事实一个源）+ #10（绝不静默覆盖你没创建的东西）。
//
// 现在只有这一份实现，且默认深合并、写前留底、原子落盘。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineAction, ActionError, redact } from '../runtime.mjs';

const MAX_BACKUPS = 10;

function readConfig(configPath) {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ActionError('CONFIG_CORRUPT', `openclaw.json 解析失败：${err.message}。已保留原文件，未做任何写入。`);
  }
}

/** 深合并。数组整体替换（渠道列表这类语义上"整体替换"更符合直觉）。 */
// 脱敏标记的形态。config.get 出口会把 Key 打码成 `sk-S…9999` / `***`，
// 如果调用方（尤其是 GUI：读配置 → 填表单 → 原样存回）把打码值当真值存回来，
// 用户的真 Key 就被永久毁掉了。这里当最后一道闸：一旦发现要写入的值是打码产物，
// 直接拒绝，让调用方重填。宪法 #10：绝不静默覆盖你没创建的东西。
const REDACTION_MARKER_RE = /^\*{3}$|\*{3}REDACTED\*{3}|…/;

function findRedactedSecrets(node, out = [], trail = []) {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    const here = [...trail, key];
    if (typeof value === 'string' && REDACTION_MARKER_RE.test(value)) out.push(here.join('.'));
    else if (value && typeof value === 'object') findRedactedSecrets(value, out, here);
  }
  return out;
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(out[key], value)
      : value;
  }
  return out;
}

/** 写前留底，只保留最近 MAX_BACKUPS 份，避免 U 盘被备份撑爆。 */
function backup(configPath, backupsDir) {
  if (!existsSync(configPath)) return null;
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(backupsDir, `openclaw.${stamp}.json`);
  copyFileSync(configPath, dest);

  try {
    const olds = readdirSync(backupsDir)
      .filter((f) => /^openclaw\..*\.json$/.test(f))
      .sort()
      .reverse()
      .slice(MAX_BACKUPS);
    for (const f of olds) unlinkSync(join(backupsDir, f));
  } catch {
    // 清理失败无所谓，备份本身已经写成功了
  }
  return dest;
}

/** 原子写：先写同目录临时文件再 rename，避免断电/拔盘留下半个 JSON。 */
function atomicWrite(configPath, obj) {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, configPath);
}

export const configGet = defineAction({
  id: 'config.get',
  title: '读取配置',
  description: '读取 openclaw.json 的当前内容。返回值中的 API Key 等密钥字段一律脱敏。',
  tags: ['config'],
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      exists: { type: 'boolean' },
      path: { type: 'string' },
      config: { type: 'object' },
    },
    required: ['exists', 'path', 'config'],
  },
  effects: { class: 'read', risk: 'low', reversible: true, confirmation: 'never', audit_required: false },
  execution: { headless: true, idempotent: true, cancellable: false, timeout_ms: 5000, progress_events: false, headless_evidence: 'tests/action-core.test.mjs' },
  async run(_input, ctx) {
    const { configPath } = ctx.paths;
    // 没有 reveal_secrets 这种开关：出口一律脱敏。GUI 想改 Key 就让用户重填一次，
    // 不需要把明文 Key 再吐回浏览器——那正是被任意网页读走的那条路。
    return {
      exists: existsSync(configPath),
      path: configPath,
      config: readConfig(configPath),
    };
  },
});

export const configSet = defineAction({
  id: 'config.set',
  title: '写入配置',
  description:
    '把一份配置片段合并进 openclaw.json。默认深合并，不会冲掉调用方没提到的字段（如 channels / plugins）。写前自动留底、原子落盘。',
  tags: ['config'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['patch'],
    properties: {
      patch: { type: 'object', description: '要合并进去的配置片段' },
      mode: {
        enum: ['merge', 'replace'],
        description: 'merge=深合并（默认，安全）；replace=整份替换（危险，需确认）',
      },
      unset: {
        type: 'array',
        items: { type: 'string' },
        description:
          '要删除的键路径（点分，如 "agent" 或 "models.providers.foo"）。深合并表达不了删除，' +
          '所以删除必须显式声明——避免"少传一个字段"被误当成删除（那正是原来整份覆盖的祸根）。',
      },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      backup: { type: ['string', 'null'] },
      changed_keys: { type: 'array', items: { type: 'string' } },
      config: { type: 'object' },
    },
    required: ['path', 'changed_keys', 'config'],
  },
  // replace 模式是破坏性的，但 merge 是日常操作。这里声明 conditional：
  // runtime 会要求 confirmed，由 CLI --yes / GUI 确认框提供。见下方 run() 里
  // 对 merge 的放行——真正需要拦的是 replace。
  effects: { class: 'write', risk: 'medium', reversible: true, confirmation: 'conditional', audit_required: true },
  execution: { headless: true, idempotent: false, cancellable: false, timeout_ms: 10000, progress_events: false, headless_evidence: 'tests/action-core.test.mjs' },
  async run(input, ctx) {
    const { configPath, backupsDir } = ctx.paths;
    const mode = input.mode || 'merge';

    // 先拦打码值：调用方把 config.get 的输出原样存回来时，这里就是最后一道防线
    const masked = findRedactedSecrets(input.patch);
    if (masked.length) {
      throw new ActionError(
        'REDACTED_VALUE_WRITE',
        `拒绝写入脱敏占位值（会毁掉真实密钥）：${masked.join(', ')}。请重新填写这些字段，或从 patch 里去掉它们。`,
        { fields: masked },
      );
    }

    const before = readConfig(configPath);
    const after = mode === 'replace' ? input.patch : deepMerge(before, input.patch);

    // 显式删除。点分路径，最后一段不存在就当已删除，不报错（幂等）。
    for (const dotted of input.unset || []) {
      const segments = dotted.split('.').filter(Boolean);
      if (!segments.length) continue;
      let node = after;
      for (let i = 0; i < segments.length - 1 && node; i++) node = node[segments[i]];
      if (node && typeof node === 'object') delete node[segments.at(-1)];
    }

    // 保命闸：replace 会丢字段，必须让调用方明确知道丢了什么。
    if (mode === 'replace') {
      const lost = Object.keys(before).filter((k) => !(k in after));
      if (lost.length && !ctx.confirmed) {
        throw new ActionError('DESTRUCTIVE_REPLACE', `replace 模式会丢失顶层字段：${lost.join(', ')}。确认后重试。`, { lost });
      }
    }

    const changedKeys = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));

    if (ctx.dryRun) {
      return { path: configPath, backup: null, changed_keys: changedKeys, config: after };
    }

    const backupPath = backup(configPath, backupsDir);
    atomicWrite(configPath, after);
    return { path: configPath, backup: backupPath, changed_keys: changedKeys, config: after };
  },
});

export default [configGet, configSet];
