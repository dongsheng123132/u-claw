// strip-provider-env.mjs — 启动 gateway 前，把宿主机残留的第三方 provider 凭证环境
// 变量剥掉，输出 KEY=VALUE 行给启动脚本 export/set。
//
// 移植自 v2 商业版 ClawX 的 buildGatewayRuntimeEnv（electron/gateway/process-launcher.ts，
// 2026-08-24 同步其 OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS 清单）。
//
// 为什么要剥（ClawX exFAT 交接单坑 #2，2026-08-22 定案）：
//
//   宿主机上有 DASHSCOPE_API_KEY 之类的变量时，OpenClaw 认为该外部 provider 已配置 →
//   启动迁移去装对应插件 → 装插件要在 U 盘建 node_modules junction → exFAT 建不了 →
//   gateway 永远不 ready。同一份 U 盘「插 A 电脑能用、插 B 电脑打不开」。
//   附带风险：继承这些变量还会静默烧掉宿主机主人的 API 额度。
//
// 与 ClawX 的差异：ClawX 在 Electron 主进程里改 env；本仓是脚本产物，由
// Windows-Start.bat / Mac-Start.command 消费本脚本的输出。
//
// 清单必须是字面量：它在启动路径上被读，早于任何 OpenClaw 模块加载；
// 从上游运行时动态推导会静默漂移（ClawX 用 check-provider-env 对账，本仓靠
// tests/strip-provider-env.test.mjs 锁住清单与行为）。

export const OFFICIAL_PROVIDER_ENV_VARS = Object.freeze([
  'AI_GATEWAY_API_KEY',
  'ARCEEAI_API_KEY',
  'BASETEN_API_KEY',
  'BYTEPLUS_API_KEY',
  'CEREBRAS_API_KEY',
  'CHUTES_API_KEY',
  'CHUTES_OAUTH_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'COMFY_API_KEY',
  'COMFY_CLOUD_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPINFRA_API_KEY',
  'DEEPSEEK_API_KEY',
  'FEATHERLESS_API_KEY',
  'FIREWORKS_API_KEY',
  'GROQ_API_KEY',
  'KILOCODE_API_KEY',
  'KIMI_API_KEY',
  'KIMICODE_API_KEY',
  'LONGCAT_API_KEY',
  'MISTRAL_API_KEY',
  'MODEL_API_KEY',
  'MODELSTUDIO_API_KEY',
  'MOONSHOT_API_KEY',
  'NOVITA_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_ZEN_API_KEY',
  'QIANFAN_API_KEY',
  'QWEN_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'STEPFUN_API_KEY',
  'SYNTHETIC_API_KEY',
  'TOKENHUB_API_KEY',
  'TOKENPLAN_API_KEY',
  'VENICE_API_KEY',
  'VOLCANO_ENGINE_API_KEY',
  'VOYAGE_API_KEY',
  'VYDRA_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
]);

/** 供测试注入；返回被剥掉的变量名列表（只报名字，不报值——值是第三方凭证）。 */
export function strippedVarNames(env = process.env) {
  return OFFICIAL_PROVIDER_ENV_VARS.filter((name) => {
    const v = env[name];
    return typeof v === 'string' && v.trim() !== '';
  });
}

// 输出格式与 resolve-no-proxy.mjs 一致：每行 KEY=VALUE，启动脚本逐行 set/export。
// 只输出「剥离动作」需要的 NO_PROXY 无关项：这里输出的是 UCLAW_STRIP_ENV=<逗号名单>，
// 由启动脚本按名单 delete 对应变量（cmd/bash 都好写），不把任何凭证值带进命令行。
const stripped = strippedVarNames();
if (stripped.length > 0) {
  console.log(`UCLAW_STRIP_ENV=${stripped.join(',')}`);
}
