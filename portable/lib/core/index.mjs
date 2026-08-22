// index.mjs —— 动作注册表
//
// 唯一的动作清单来源。CLI、config-server、启动器、未来的 MCP 都从这里拿动作，
// 谁都不许自己另存一份列表（宪法 #8）。
// tests/action-parity.test.mjs 会断言这里的注册表和 action-parity.json 完全对齐。

import configActions from './actions/config.mjs';
import doctorActions from './actions/doctor.mjs';
import bugActions from './actions/bugreport.mjs';
import wechatActions from './actions/wechat.mjs';
import gatewayActions from './actions/gateway.mjs';
import logActions from './actions/log.mjs';
import runtimeActions from './actions/runtime.mjs';

export { execute, redact, ActionError, validateSchema, defineAction } from './runtime.mjs';
export { resolvePaths } from './paths.mjs';
export { appendActionLog, readRecentLogs, logFilePath } from './logger.mjs';

/** 所有动作，按 id 升序。 */
export const ACTIONS = [
  ...configActions,
  ...doctorActions,
  ...bugActions,
  ...wechatActions,
  ...gatewayActions,
  ...logActions,
  ...runtimeActions,
].sort((a, b) => a.id.localeCompare(b.id));

export const ACTIONS_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function getAction(id) {
  return ACTIONS_BY_ID.get(id) || null;
}

/**
 * 导出可被机器发现的动作描述（不含 run 实现）。
 * ActionParity §6.1 允许"用一条非交互 CLI 命令返回清单"作为发现机制，
 * `uclaw manifest --json` 就走这里。
 */
export function describeActions() {
  return ACTIONS.map(({ id, title, description, tags, input_schema, output_schema, effects, execution, bindings }) => ({
    id, title, description, tags, input_schema, output_schema, effects, execution,
    ...(bindings ? { bindings } : {}),
  }));
}
