// portable/lib/core-mode.mjs — Lite/Full 内核选择状态（启动器只读它决定起哪个内核）。
//
// 单一真相源：data/.openclaw/core-mode，内容只能是 "lite" 或 "openclaw"，缺省 "lite"。
//
// 关键契约（与钱包双写解耦）：
//   - core-mode **只**决定启动器起哪个内核，绝不被钱包写入逻辑读取
//     （否则切档后一侧凭据 stale）。钱包 applyKey/removeKey 无条件双写两核。
//   - 读：损坏/未知/缺失一律按默认 lite + 可见 stderr 警告，**永不抛**（启动器不能因一字节坏而崩）。
//   - 写：只接受两个枚举值，非法值直接抛，绝不把文件内容拼进路径/命令/env。
//   - 原子写：临时文件 + renameSync（同盘即时），中途崩不留半截文件。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CORE_MODE_LITE = 'lite';
export const CORE_MODE_OPENCLAW = 'openclaw';
const VALID = new Set([CORE_MODE_LITE, CORE_MODE_OPENCLAW]);
const DEFAULT = CORE_MODE_LITE;

export function isValidCoreMode(value) {
  return VALID.has(value);
}

/**
 * 读 core-mode。永远不抛。
 * @param {string} stateDir data/.openclaw 所在目录（STATE_DIR）
 * @param {{ warn?: (msg: string) => void }} [opts]
 * @returns {'lite'|'openclaw'}
 */
export function readCoreMode(stateDir, opts = {}) {
  const warn = opts.warn || ((m) => console.warn(m));
  const file = join(stateDir, 'core-mode');
  if (!existsSync(file)) return DEFAULT;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    warn('[core-mode] 读取失败，回退默认 lite。');
    return DEFAULT;
  }
  const value = raw.trim();
  if (!value) {
    warn('[core-mode] 文件为空，回退默认 lite。');
    return DEFAULT;
  }
  if (!VALID.has(value)) {
    warn('[core-mode] 内容非法，回退默认 lite（合法值：lite | openclaw）。');
    return DEFAULT;
  }
  return value;
}

/**
 * 写 core-mode。非法值直接抛（调用方必须先用 isValidCoreMode 校验 UI 输入）。
 * @param {string} stateDir
 * @param {'lite'|'openclaw'} mode
 */
export function writeCoreMode(stateDir, mode) {
  if (!VALID.has(mode)) {
    throw new Error(`core-mode 只能写 "lite" 或 "openclaw"，收到: ${String(mode)}`);
  }
  const file = join(stateDir, 'core-mode');
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, `.core-mode.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, mode, { encoding: 'utf8' });
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* no temporary file */ }
    throw error;
  }
  return mode;
}

// CLI 入口（供 bat 读取/写入 core-mode，绝不让 bat 直接读文件内容拼进路径/命令/env）。
//   node core-mode.mjs get <STATE_DIR>   → 打印 lite|openclaw（缺省 lite）
//   node core-mode.mjs set <STATE_DIR> <lite|openclaw>  → 写，非法值 stderr+exit 1
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const op = process.argv[2];
  const stateDir = process.argv[3];
  if (!op || !stateDir) {
    console.error('usage: node core-mode.mjs get|set <STATE_DIR> [lite|openclaw]');
    process.exitCode = 2;
  } else if (op === 'get') {
    process.stdout.write(readCoreMode(stateDir) + '\n');
  } else if (op === 'set') {
    const mode = process.argv[4];
    if (!isValidCoreMode(mode)) {
      console.error('core-mode 只能写 "lite" 或 "openclaw"，收到: ' + String(mode));
      process.exitCode = 1;
    } else {
      writeCoreMode(stateDir, mode);
      process.stdout.write(mode + '\n');
    }
  } else {
    console.error('unknown op: ' + op);
    process.exitCode = 2;
  }
}
