// check-model-configured.mjs — 判断 openclaw.json 是否已配置模型（agents.defaults.model.primary）
//
// 背景（issue #24）：Windows-Start.bat / Mac-Start.command 曾经无条件打开 Config Center，
// 导致老用户每次双击启动都被强弹一次配置页——哪怕早就配置好模型了。仓库 CLAUDE.md 里写的
// 设计其实是："首次运行（未配置模型）才自动打开 Config Center；已配置则只开 Dashboard。"
// 代码没照着这个设计写，这个助手就是补上判断那一步。
//
// 设计原则（照抄 lib/ 里其它助手的惯例）：
//   - 零依赖：只用 node:fs
//   - 静默失败：文件不存在 / 解析失败 / 字段缺失，一律当"未配置"处理——
//     宁可多弹一次配置页（首次体验），也不能因为判断出错让用户再也看不到配置入口
//   - 打印 KEY=VALUE 给 .bat 用 `for /f` 读、给 .command 用 `while IFS='=' read` 读
//
// CLI 用法：
//   node check-model-configured.mjs <CONFIG_PATH>
// 输出：
//   UCLAW_MODEL_CONFIGURED=1   已配置模型（agents.defaults.model.primary 非空字符串）
//   UCLAW_MODEL_CONFIGURED=0   未配置（含文件不存在 / JSON 解析失败 / 字段缺失）

import { existsSync, readFileSync } from 'node:fs';

export function isModelConfigured(configPath) {
  try {
    if (!configPath || !existsSync(configPath)) return false;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const primary = config?.agents?.defaults?.model?.primary;
    return typeof primary === 'string' && primary.trim().length > 0;
  } catch {
    // 静默失败：配置文件损坏也不能让启动脚本挂掉，当作"未配置"处理
    return false;
  }
}

import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const configPath = process.argv[2] || process.env.OPENCLAW_CONFIG_PATH;
  const configured = isModelConfigured(configPath);
  process.stdout.write(`UCLAW_MODEL_CONFIGURED=${configured ? '1' : '0'}\n`);
}
