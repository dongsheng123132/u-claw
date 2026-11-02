// boot-timing.mjs — 便携版冷启动耗时埋点（零依赖、静默失败、不阻塞启动）。
//
// 为什么需要：客户说"启动慢"时，我们现在只能靠肉眼猜（U 盘慢？Node 冷启？config-server？
// Gateway 第一次加载插件？）。这个助手把关键阶段的时间戳落成一行一个 JSON，远程诊断直接
// 看 `node lib/boot-timing.mjs report <stateDir>` 就能给出各阶段耗时，不需要在客户机上
// 蹲点抓日志。
//
// 设计原则（与 lib/ 其它助手一致）：
//   - 零依赖：只用 node:fs / node:path
//   - 静默失败：任何 IO 错误都吞掉，绝不让启动脚本挂掉或变慢
//   - 有界体积：单个 boot-timing.jsonl 超过 64 KB 时，下一次 mark 直接截断重来
//   - 主线程开销极小：一次 mark = 一次 appendFileSync（几毫秒）
//
// CLI：
//   node lib/boot-timing.mjs start  <stateDir>            # 新一次启动，重置当前 boot
//   node lib/boot-timing.mjs mark   <stateDir> <phase>    # 记录一个阶段（自动带耗时）
//   node lib/boot-timing.mjs report <stateDir>            # 打印最近一次启动各阶段耗时
//
// 文件格式（<stateDir>/boot-timing.jsonl，一行一个阶段）：
//   {"boot":"20261102T105930-1234","phase":"launcher","at":1762... ,"durationMs":0,"sinceStartMs":0}
//   durationMs   = 相对上一个阶段的耗时
//   sinceStartMs = 相对本次 start 的累计耗时

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE_NAME = 'boot-timing.jsonl';
const MAX_BYTES = 64 * 1024;
const MAX_PHASES_PER_BOOT = 40;

function filePath(stateDir) {
  return path.join(stateDir, FILE_NAME);
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && typeof entry.phase === 'string') out.push(entry);
    } catch {
      // 坏行跳过：埋点数据不值得让任何调用方失败
    }
  }
  return out;
}

function trim(file, lines) {
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_BYTES || lines.length > MAX_PHASES_PER_BOOT * 4) {
      fs.writeFileSync(file, '');
      return [];
    }
  } catch {
    return lines;
  }
  return lines;
}

function writeLine(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** 开始一次新的启动记录；返回 boot id（失败返回 null，调用方应忽略）。 */
export function startBoot(stateDir, { now = Date.now() } = {}) {
  const file = filePath(stateDir);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const boot = `${stamp}-${process.pid}`;
    fs.writeFileSync(file, '');
    writeLine(file, { boot, phase: 'start', at: now, durationMs: 0, sinceStartMs: 0 });
    return boot;
  } catch {
    return null;
  }
}

/** 记录一个阶段；返回 { ok, durationMs }，失败时 ok=false 且不抛。 */
export function mark(stateDir, phase, { now = Date.now() } = {}) {
  const file = filePath(stateDir);
  try {
    if (!phase || typeof phase !== 'string') return { ok: false, durationMs: null };
    const entries = trim(file, parseLines(readLines(file)));
    const boot = entries.length && entries[entries.length - 1].boot ? entries[entries.length - 1].boot : null;
    if (!boot) return { ok: false, durationMs: null };
    const last = entries[entries.length - 1];
    const lastAt = Number.isFinite(last.at) ? last.at : now;
    const startAt = entries.find((e) => e.phase === 'start');
    const baseAt = startAt && Number.isFinite(startAt.at) ? startAt.at : lastAt;
    const durationMs = Math.max(0, now - lastAt);
    const sinceStartMs = Math.max(0, now - baseAt);
    const ok = writeLine(file, { boot, phase, at: now, durationMs, sinceStartMs });
    return { ok, durationMs, sinceStartMs };
  } catch {
    return { ok: false, durationMs: null };
  }
}

/** 最近一次启动的阶段列表（按写入顺序）。 */
export function readLastBoot(stateDir) {
  const entries = parseLines(readLines(filePath(stateDir)));
  if (!entries.length) return [];
  const boot = entries[entries.length - 1].boot;
  return entries.filter((e) => e.boot === boot);
}

/** 人类可读的最近一次启动报告（供 Diagnose / 售后直接用）。 */
export function formatReport(stateDir) {
  const entries = readLastBoot(stateDir);
  if (!entries.length) return 'no boot timing recorded yet';
  const lines = ['last boot: ' + entries[0].boot];
  for (const entry of entries) {
    const dur = Number.isFinite(entry.durationMs) ? String(entry.durationMs) : '-';
    const total = Number.isFinite(entry.sinceStartMs) ? String(entry.sinceStartMs) : '-';
    lines.push(`  ${String(entry.phase).padEnd(18)} +${dur}ms (total ${total}ms)`);
  }
  return lines.join('\n');
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const [command, stateDir, phase] = process.argv.slice(2);
  if (!command || !stateDir) {
    process.stderr.write('usage: boot-timing.mjs <start|mark|report> <stateDir> [phase]\n');
    process.exitCode = 2;
  } else if (command === 'start') {
    startBoot(stateDir);
    process.stdout.write('UCLAW_BOOT_TIMING=started\n');
  } else if (command === 'mark') {
    const result = mark(stateDir, phase);
    process.stdout.write(`UCLAW_BOOT_MARK=${result.ok ? 'ok' : 'failed'}\n`);
  } else if (command === 'report') {
    process.stdout.write(formatReport(stateDir) + '\n');
  } else {
    process.stderr.write('unknown command: ' + command + '\n');
    process.exitCode = 2;
  }
}
