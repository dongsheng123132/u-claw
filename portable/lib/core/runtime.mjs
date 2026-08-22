// runtime.mjs —— 影核（ActionParity）动作运行时
//
// 每个有业务意义的动作只在这里跑一次。GUI(Config.html)、CLI(uclaw.mjs)、
// 启动器(.bat/.command)、未来的 MCP 都是它的调用方，不是第二份实现。
// 规范：ActionParity 0.1.0 §7 (动作要求) / §10 (状态与事件) / §11 (安全与授权)
//
// 这一层负责、动作实现里不用重复关心的事：
//   - 输入按 JSON Schema 校验（§7.2），不合法直接 INVALID_INPUT，不进业务代码
//   - 统一结构化结果 {ok, execution_id, data, error, meta}（§7.5）
//   - 确认策略在表现层**之下**强制（§11.2）——GUI 不弹窗不等于绕开确认
//   - 超时（§7.4，每个动作必须有有限超时）
//   - 密钥脱敏：结果 / 错误 / 事件 / 审计里一律不出现明文 Key（§7.5、§11.4）
//   - 审计：状态变更动作按 execution_id 可追溯（§10.3）
//
// 零依赖，纯 Node。便携版 lib/ 的一贯约定。

import { randomUUID } from 'node:crypto';
import { appendActionLog } from './logger.mjs';

// ── 密钥脱敏 ────────────────────────────────────────────────────────────────
// 命中这些键名的值一律打码。宪法 #11：客户端当成可被反编译，输出更要当成会被贴到
// 公开 issue 里——事实上 bug.collect 收集的报告就是拿去贴 GitHub 的。
const SECRET_KEY_RE = /(api[_-]?key|apikey|token|secret|password|passwd|credential|authorization)/i;

/** 把字符串打码成 sk-a…f012 的形态，保留头尾便于用户认出是哪把 Key。 */
function maskValue(value) {
  if (typeof value !== 'string') return '***';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * 递归脱敏。返回新对象，不改原对象（调用方可能还要拿原值去写文件）。
 * 循环引用用 seen 兜住，避免 bug.collect 收集到自引用结构时栈溢出。
 *
 * seen 里装的是**当前这条路径上的祖先**，进去加、出来删 —— 不是"访问过的全部对象"。
 * 差别很要命：同一个对象被引用两次（不是环）在结果里很常见，
 * 比如 runtime.probe 的 node.chosen 就是 node.candidates 里的某一项。
 * 按"访问过就算环"来判，第二次出现会被整块换成 '[Circular]'，数据凭空少一半。
 */
export function redact(node, seen = new Set()) {
  if (node === null || typeof node !== 'object') return node;
  if (seen.has(node)) return '[Circular]';
  seen.add(node);
  try {
    if (Array.isArray(node)) return node.map((item) => redact(item, seen));

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = maskValue(value);
      } else {
        out[key] = redact(value, seen);
      }
    }
    return out;
  } finally {
    seen.delete(node);
  }
}

// ── 极简 JSON Schema 校验 ───────────────────────────────────────────────────
// 只覆盖清单里实际用到的子集（type / required / properties / enum /
// additionalProperties / items）。不引 ajv：便携版 lib/ 必须零依赖，
// 且这层只做入口卫兵，不是通用校验器。
export function validateSchema(schema, value, path = 'input') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} 必须是对象`);
      return errors;
    }
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(`${path}.${key} 是必填项`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key} 不是允许的字段`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) errors.push(...validateSchema(sub, value[key], `${path}.${key}`));
    }
    return errors;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} 必须是数组`);
      return errors;
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateSchema(schema.items, item, `${path}[${i}]`)));
    }
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是 ${schema.enum.join(' / ')} 之一，收到 ${JSON.stringify(value)}`);
    return errors;
  }

  if (type === 'string' && typeof value !== 'string') errors.push(`${path} 必须是字符串`);
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} 必须是布尔值`);
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${path} 必须是数字`);
  }
  return errors;
}

// ── 动作定义 ────────────────────────────────────────────────────────────────

/**
 * 声明一个动作。字段与 action-parity.json 清单一一对应——清单和实现共用
 * 同一份元数据，靠 tests/action-parity.test.mjs 断言两边不漂移（宪法 #8）。
 */
export function defineAction(spec) {
  const required = ['id', 'title', 'description', 'input_schema', 'output_schema', 'effects', 'execution', 'run'];
  for (const key of required) {
    if (spec[key] === undefined) throw new Error(`动作定义缺少 ${key}: ${spec.id || '(无 id)'}`);
  }
  return spec;
}

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 带稳定错误码的业务错误。§7.5 要求失败必须有稳定 code + 可读 message。 */
export class ActionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.details = details;
  }
}

// ── 执行 ────────────────────────────────────────────────────────────────────

/**
 * 执行一个动作，返回 ActionParity §7.5 规定的结构化结果。
 * 永不抛异常——所有失败都变成 {ok:false, error:{code,message}}，
 * 这样 CLI / GUI / MCP 三个 surface 拿到的形状完全一致。
 *
 * @param {object} action defineAction() 的产物
 * @param {object} input  动作输入
 * @param {object} ctx    {paths, confirmed, dryRun, onProgress, env}
 */
export async function execute(action, input = {}, ctx = {}) {
  const executionId = `exec_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const startedAt = Date.now();

  const done = (ok, data, error) => {
    const durationMs = Date.now() - startedAt;
    const result = {
      ok,
      execution_id: executionId,
      action_id: action.id,
      data: ok ? redact(data ?? {}) : null,
      error: ok ? null : { code: error.code, message: error.message, ...(error.details ? { details: redact(error.details) } : {}) },
      meta: { duration_ms: durationMs, dry_run: !!ctx.dryRun },
    };

    // 每个动作都记 —— 不只 audit_required 的那几个。
    // 排障时最想知道的往往是"谁在什么时候查过什么"，只读动作同样有价值：
    // pc-4800 那次拿不到任何执行轨迹，正是因为客户机上根本没有这层日志。
    if (ctx.paths && ctx.log !== false) {
      appendActionLog(ctx.paths, {
        execution_id: executionId,
        action_id: action.id,
        surface: ctx.surface,
        ok,
        duration_ms: durationMs,
        dry_run: !!ctx.dryRun,
        input,
        data: ok ? result.data : undefined,
        error: ok ? undefined : error,
      });
    }
    return result;
  };

  // 1) 输入校验（§7.2）。不合法就不进业务代码。
  const errors = validateSchema(action.input_schema, input);
  if (errors.length) {
    return done(false, null, new ActionError('INVALID_INPUT', `输入不合法：${errors.join('；')}`));
  }

  // 2) 确认策略强制（§11.2）。注意这一步在表现层之下——
  //    GUI 不弹确认框、CLI 不加 --yes，一样过不去。这正是 config-server
  //    那三个洞的架构性堵法：任意网页就算能打到 HTTP 端点，也拿不到 confirmed。
  //
  //    always      = 运行时无条件要确认
  //    conditional = 由动作自己按输入判断（run() 里自行抛 CONFIRMATION_REQUIRED /
  //                  DESTRUCTIVE_* ），因为"什么情况算危险"是业务知识，运行时不知道。
  //                  例：config.set 的 merge 是日常操作，replace 丢字段才要拦。
  //    never       = 不需要确认
  if (action.effects.confirmation === 'always' && !ctx.confirmed && !ctx.dryRun) {
    return done(false, null, new ActionError(
      'CONFIRMATION_REQUIRED',
      `动作 ${action.id} 需要显式确认（风险等级 ${action.effects.risk}）。CLI 加 --yes，GUI 需用户点确认。`,
    ));
  }

  // 3) 带超时执行（§7.4：每个动作必须有有限超时。宪法 #9：凡会卡的一律超时）
  const timeoutMs = action.execution.timeout_ms;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ActionError('TIMEOUT', `动作 ${action.id} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  try {
    const data = await Promise.race([
      action.run(input, {
        ...ctx,
        executionId,
        signal: controller.signal,
        progress: (pct, msg) => ctx.onProgress?.({ execution_id: executionId, action_id: action.id, pct, message: msg }),
      }),
      timeout,
    ]);
    return done(true, data);
  } catch (err) {
    if (err instanceof ActionError) return done(false, null, err);
    return done(false, null, new ActionError('INTERNAL_ERROR', err?.message || String(err)));
  } finally {
    clearTimeout(timer);
  }
}
