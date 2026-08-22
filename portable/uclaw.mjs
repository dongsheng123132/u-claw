#!/usr/bin/env node
// uclaw.mjs —— U-Claw 的 CLI Surface（影核 / ActionParity）
//
// 这不是"另一个实现"，只是动作核心的一个投影：每条命令都直通 lib/core 的同一个
// 动作。GUI（Config.html + config-server）、启动器（.bat/.command）走的是同一批动作。
//
// 遵循 ActionParity §9 CLI profile：
//   - 结果只走 stdout，日志/进度只走 stderr（管道里 `| jq` 不会被日志污染）
//   - 非 TTY 时自动关掉颜色和进度
//   - 退出码：0=成功  1=运行失败  2=用法错误
//   - --json / --quiet / --verbose / --no-input / --yes / --version
//
// 用法：
//   node uclaw.mjs <action.id> [--key value ...] [--json] [--yes] [--dry-run]
//   node uclaw.mjs list                     列出所有动作
//   node uclaw.mjs manifest                 输出机器可读清单（§6.1 发现机制）
//
// 例：
//   node uclaw.mjs doctor.diagnose --json
//   node uclaw.mjs config.set --patch '{"agents":{"defaults":{"model":{"primary":"deepseek/deepseek-chat"}}}}'
//   node uclaw.mjs bug.collect --note "启动就闪退"

import { readFileSync, existsSync } from 'node:fs';
import { execute, resolvePaths, ACTIONS, getAction, describeActions } from './lib/core/index.mjs';

const isTTY = process.stdout.isTTY === true;
const C = isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

const EXIT_OK = 0, EXIT_FAIL = 1, EXIT_USAGE = 2;

/** 日志一律走 stderr —— stdout 是留给结果的。 */
function log(...args) { process.stderr.write(args.join(' ') + '\n'); }

function parseArgv(argv) {
  const opts = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const [rawKey, inlineValue] = a.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-/g, '_');
    if (inlineValue !== undefined) { opts.flags[key] = inlineValue; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts.flags[key] = true;
    else { opts.flags[key] = next; i++; }
  }
  return opts;
}

/** 把 --key value 按动作的 input_schema 转成正确类型（CLI 传进来全是字符串）。 */
function coerceInput(action, flags) {
  const props = action.input_schema?.properties || {};
  const reserved = new Set(['json', 'quiet', 'verbose', 'no_input', 'yes', 'dry_run', 'version', 'help']);
  const input = {};
  for (const [key, raw] of Object.entries(flags)) {
    if (reserved.has(key)) continue;
    const schema = props[key];
    if (!schema) { input[key] = raw; continue; } // 交给 runtime 的 schema 校验去报错

    const type = schema.type;
    if (type === 'boolean') input[key] = raw === true || raw === 'true' || raw === '1';
    else if (type === 'number' || type === 'integer') input[key] = Number(raw);
    else if (type === 'object' || type === 'array') {
      try { input[key] = JSON.parse(raw); }
      catch { throw new Error(`--${key} 需要是合法 JSON，收到：${raw}`); }
    } else input[key] = raw;
  }
  return input;
}

function printHuman(action, result) {
  if (!result.ok) {
    log(`${C.red}✗${C.off} ${action.id} 失败 [${result.error.code}]`);
    log(`  ${result.error.message}`);
    return;
  }
  const d = result.data;
  // 诊断结果给人看时排版一下，其余动作直接吐 JSON（本来就是结构化的）
  if (action.id === 'doctor.diagnose') {
    const icon = { ok: `${C.green}✓${C.off}`, info: `${C.dim}·${C.off}`, warn: `${C.yellow}!${C.off}`, error: `${C.red}✗${C.off}` };
    for (const f of d.findings) process.stdout.write(`${icon[f.level] || ' '} ${f.title}: ${f.detail}\n`);
    process.stdout.write(`\n${d.healthy ? `${C.green}健康${C.off}` : `${C.red}发现 ${d.summary.error} 个错误${C.off}`}，警告 ${d.summary.warn} 个\n`);
    return;
  }
  process.stdout.write(JSON.stringify(d, null, 2) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgv(argv);
  const cmd = _[0];

  if (flags.version) {
    const paths = resolvePaths();
    const v = existsSync(paths.versionFile) ? readFileSync(paths.versionFile, 'utf8').trim() : '未知';
    process.stdout.write(`${v}\n`);
    return EXIT_OK;
  }

  if (!cmd || flags.help || cmd === 'help') {
    log(`${C.bold}U-Claw CLI${C.off} — 影核动作核心的命令行投影\n`);
    log('用法: node uclaw.mjs <action.id> [--key value ...] [--json] [--yes] [--dry-run]\n');
    log('可用动作:');
    for (const a of ACTIONS) log(`  ${a.id.padEnd(24)} ${a.title}`);
    log('\n其他: list | manifest | --version | --help');
    return cmd ? EXIT_OK : EXIT_USAGE;
  }

  if (cmd === 'list') {
    process.stdout.write(JSON.stringify(ACTIONS.map((a) => ({ id: a.id, title: a.title })), null, 2) + '\n');
    return EXIT_OK;
  }

  // §6.1：以非交互 CLI 命令作为清单发现机制
  if (cmd === 'manifest') {
    process.stdout.write(JSON.stringify({ spec_version: '0.3.0', actions: describeActions() }, null, 2) + '\n');
    return EXIT_OK;
  }

  const action = getAction(cmd);
  if (!action) {
    log(`${C.red}未知动作: ${cmd}${C.off}`);
    log(`可用: ${ACTIONS.map((a) => a.id).join(', ')}`);
    return EXIT_USAGE;
  }

  let input;
  try {
    input = coerceInput(action, flags);
  } catch (err) {
    log(`${C.red}${err.message}${C.off}`);
    return EXIT_USAGE;
  }

  const result = await execute(action, input, {
    paths: resolvePaths(),
    surface: 'cli',
    confirmed: flags.yes === true || flags.yes === 'true',
    dryRun: flags.dry_run === true || flags.dry_run === 'true',
    noInput: flags.no_input === true,
    // 进度走 stderr，且非 TTY / --quiet 时闭嘴（§9）
    onProgress: (e) => {
      if (flags.quiet || !isTTY) return;
      log(`${C.dim}[${e.pct}%] ${e.message}${C.off}`);
    },
  });

  if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (!flags.quiet) printHuman(action, result);

  return result.ok ? EXIT_OK : EXIT_FAIL;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // 兜底：任何没被 runtime 接住的异常都不能让 CLI 以 0 退出
    process.stderr.write(`uclaw 内部错误: ${err?.stack || err}\n`);
    process.exit(EXIT_FAIL);
  });
