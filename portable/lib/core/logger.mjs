// logger.mjs —— 动作执行日志（JSONL）
//
// 为什么每个动作都要记、而不只记"状态变更"的：
// 排障时最想知道的恰恰是"运维/GUI 到底查过什么、什么时候查的、返回了什么"。
// pc-4800 那次之所以只能干瞪眼，就是因为客户机上没有任何可回溯的执行轨迹。
//
// 格式选 JSONL 而不是人类可读文本：一行一条完整 JSON，`tail -f` 能看，
// 机器（bug.collect / 远程运维 / AI）也能直接逐行 parse，不用写解析器。
//
// 三条约束：
//   1. **绝不让日志拖垮动作。** 写失败一律吞掉（U 盘只读 / 磁盘满 / 杀软锁文件）。
//   2. **密钥不落盘。** 输入输出都先过 redact()，再做摘要。宪法 #11。
//   3. **有界。** U 盘空间金贵，按大小 + 天数双重轮转，绝不无限增长。

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './runtime.mjs';

const MAX_BYTES = 5 * 1024 * 1024;   // 单文件上限
const MAX_AGE_DAYS = 7;              // 保留天数
const FILE_RE = /^actions-(\d{4}-\d{2}-\d{2})\.jsonl(\.\d+)?$/;

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function logFilePath(logsDir, day = today()) {
  return join(logsDir, `actions-${day}.jsonl`);
}

/**
 * 输入/输出摘要。完整对象可能很大（bug.collect 的 markdown 有几 KB），
 * 全量落盘既浪费 U 盘又拖慢启动，所以只留形状 + 标量值。
 * 注意：调用方必须先 redact()，这里只负责压缩体积。
 */
function summarize(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return `<array:${value.length}>`;
  if (depth >= 1) return `<obj:${Object.keys(value).length} keys>`;

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = summarize(v, depth + 1);
  return out;
}

/** 轮转：单文件超限就改名让位；过期文件直接删。失败一律静默。 */
function rotate(logsDir, file) {
  try {
    if (statSync(file).size > MAX_BYTES) {
      // 同名加序号，避免覆盖今天早些时候的记录
      let n = 1;
      while (n < 100) {
        const candidate = `${file}.${n}`;
        try { statSync(candidate); n++; } catch {
          renameSync(file, candidate);   // 不存在 → 让位给新文件
          break;
        }
      }
    }
  } catch { /* 文件不存在等 → 无需轮转 */ }

  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
    for (const name of readdirSync(logsDir)) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      if (new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) unlinkSync(join(logsDir, name));
    }
  } catch { /* 目录不存在等 */ }
}

/**
 * 追加一条动作执行记录。
 * @param {object} paths  resolvePaths() 的产物
 * @param {object} record {execution_id, action_id, ok, duration_ms, surface, input, data, error, dry_run}
 */
export function appendActionLog(paths, record) {
  if (!paths?.logsDir) return;
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    const file = logFilePath(paths.logsDir);
    rotate(paths.logsDir, file);

    const line = {
      ts: new Date().toISOString(),
      id: record.execution_id,
      action: record.action_id,
      surface: record.surface || 'unknown',
      ok: record.ok,
      ms: record.duration_ms,
      ...(record.dry_run ? { dry_run: true } : {}),
      // redact 在前、summarize 在后：先保证密钥不落盘，再压体积
      ...(record.input !== undefined ? { input: summarize(redact(record.input)) } : {}),
      ...(record.ok
        ? (record.data !== undefined ? { data: summarize(record.data) } : {})
        : { error: record.error?.code, message: record.error?.message }),
    };
    appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
  } catch {
    // 日志绝不能让动作失败
  }
}

/** 读取最近 N 条记录（供 log.tail 动作 / bug.collect 使用）。 */
export function readRecentLogs(logsDir, limit = 50) {
  const entries = [];
  try {
    const files = readdirSync(logsDir)
      .filter((f) => FILE_RE.test(f))
      .sort()
      .reverse()          // 新的在前
      .slice(0, 3);       // 最多回溯 3 个文件，够用且不至于读爆
    for (const name of files) {
      const raw = readFileSync(join(logsDir, name), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* 半行/损坏，跳过 */ }
      }
      if (entries.length >= limit * 2) break;
    }
  } catch { /* 无日志目录 */ }
  return entries.slice(-limit);
}
