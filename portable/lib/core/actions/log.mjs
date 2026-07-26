// log.mjs —— 读取动作执行日志
//
// 存在的理由：远程排障时最想问的三句话是"你刚才点了什么""它报了什么错""是什么时候"。
// 有了这个动作，一条命令就能拿到答案，不用再让客户去翻文件夹截图：
//     node uclaw.mjs log.tail --json
//
// 只读，不改任何东西。日志本身写入时已脱敏，这里不会二次泄漏。

import { defineAction } from '../runtime.mjs';
import { readRecentLogs } from '../logger.mjs';

export const logTail = defineAction({
  id: 'log.tail',
  title: '读取动作执行日志',
  description:
    '返回最近的动作执行记录（JSONL 解析后的对象数组），含动作 ID、来源 Surface、成功与否、' +
    '耗时、错误码。密钥在写入时已脱敏。远程排障用。',
  tags: ['diagnostics', 'support'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'number', description: '返回条数，默认 50，上限 500' },
      action_id: { type: 'string', description: '只看某个动作的记录' },
      failed_only: { type: 'boolean', description: '只看失败的' },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      entries: { type: 'array', items: { type: 'object' } },
      count: { type: 'number' },
      log_dir: { type: 'string' },
    },
    required: ['entries', 'count', 'log_dir'],
  },
  effects: { class: 'read', risk: 'low', reversible: true, confirmation: 'never', audit_required: false },
  execution: { headless: true, idempotent: true, cancellable: false, timeout_ms: 15000, progress_events: false, headless_evidence: 'tests/action-log.test.mjs' },
  async run(input, ctx) {
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 500);
    // 多读一些再过滤，否则加了筛选条件容易一条都剩不下
    let entries = readRecentLogs(ctx.paths.logsDir, limit * 4);

    if (input.action_id) entries = entries.filter((e) => e.action === input.action_id);
    if (input.failed_only) entries = entries.filter((e) => e.ok === false);

    entries = entries.slice(-limit);
    return { entries, count: entries.length, log_dir: ctx.paths.logsDir };
  },
});

export default [logTail];
