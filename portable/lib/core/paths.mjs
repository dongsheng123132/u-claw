// paths.mjs —— U-Claw 路径的唯一真相源
//
// 为什么需要这个文件：改造前「openclaw.json 在哪」这件事散在 23 个文件里各算各的，
// 其中 config-server/server.js 用 `__dirname/../data/.openclaw/openclaw.json` 写死，
// 完全不认 OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR 环境变量，而同一个文件里的
// /api/update-status 又认——同一进程内两套算法，装到 ~/.uclaw 后就会写错文件。
// 宪法 #8：同一事实存在几份就会漂移几份。这里收成一份，其余只读。
//
// 解析优先级（高 → 低）：
//   1. 显式传入的 overrides（测试沙箱用，见宪法 #10 / SPEC §11.3）
//   2. 环境变量 OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR / OPENCLAW_HOME
//   3. 相对本文件的便携版布局（portable/lib/core/ → portable/data/.openclaw/）

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// portable/lib/core/paths.mjs → portable/
export const PORTABLE_ROOT = resolve(HERE, '..', '..');

/**
 * 解析 U-Claw 的全部关键路径。
 * @param {object} [overrides] 测试可注入 {root, home, stateDir, configPath}
 */
export function resolvePaths(overrides = {}) {
  const env = overrides.env || process.env;

  const root = overrides.root || PORTABLE_ROOT;
  const home = overrides.home || env.OPENCLAW_HOME || join(root, 'data');
  const stateDir = overrides.stateDir || env.OPENCLAW_STATE_DIR || join(home, '.openclaw');
  const configPath = overrides.configPath || env.OPENCLAW_CONFIG_PATH || join(stateDir, 'openclaw.json');

  return {
    root,
    home,
    stateDir,
    configPath,
    backupsDir: join(home, 'backups'),
    logsDir: join(home, 'logs'),
    extensionsDir: join(stateDir, 'extensions'),
    coreDir: join(root, 'app', 'core'),
    runtimeDir: join(root, 'app', 'runtime'),
    bundledExtensionsDir: join(root, 'app', 'extensions'),
    versionFile: join(root, 'OPENCLAW_VERSION'),
    runtimeJson: join(stateDir, 'runtime.json'),
  };
}
