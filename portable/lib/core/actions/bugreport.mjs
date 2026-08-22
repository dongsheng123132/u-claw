// bugreport.mjs —— bug 报告收集器
//
// 目标：用户遇到问题时，一条命令（或配置中心一个按钮）生成一份**可以直接贴到
// 公开 GitHub issue** 的报告，省掉运维来回问"你什么系统、什么版本、日志呢"。
//
// 三条硬约束：
//   1. **绝不自动上传。** README 承诺"不绑定设备、不打指纹、不向 api.u-claw.org
//      上传任何数据"。所以本动作只写本地文件 + 生成一个预填的 issue 链接，
//      提交与否、提交什么，全由用户自己决定。
//   2. **强制脱敏。** 报告是拿去贴公开 issue 的，API Key / token 泄漏一次就是
//      真金白银。除了 runtime 出口的统一脱敏，这里对日志正文再做一遍正则清洗。
//   3. **不采集用户内容。** 只收技术事实（版本、路径、端口、错误行），
//      不碰 memory/、不碰对话记录。
//
// 规范 §11.4（凭据不得进入诊断输出）+ 宪法 #11。

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform, release, arch, totalmem, tmpdir } from 'node:os';
import { defineAction, execute } from '../runtime.mjs';
import { doctorDiagnose } from './doctor.mjs';
import { readRecentLogs } from '../logger.mjs';

const ISSUE_BASE = 'https://github.com/dongsheng123132/u-claw/issues/new';
const MAX_LOG_LINES = 40;

// 日志正文里的密钥形态。runtime 的 redact() 只认对象的键名，日志是自由文本，
// 得按值的形状再洗一遍。
//
// 顺序有讲究：Bearer / Basic 必须排在通用 `key: value` 规则**之前**。否则通用规则
// 会先匹配 `Authorization: Bearer <token>`，把 "Bearer" 当成值吃掉，真 token 留在
// 外面原样输出——这个洞在自测里真出现过，别调换顺序。
const REDACTED = '***REDACTED***';
const SECRET_PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, `sk-${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, `gh*_${REDACTED}`],
  [
    /("?(?:api[_-]?key|apikey|token|secret|password|passwd|credential|authorization)"?\s*[:=]\s*"?)([^"\s,}\r\n]{6,})/gi,
    // 值已经是认证方案关键字或已被上面打过码时原样返回，避免二次替换糊成一片
    (match, prefix, value) => (/^(bearer|basic)$/i.test(value) || value.includes(REDACTED) ? match : `${prefix}${REDACTED}`),
  ],
];

function scrub(text) {
  let out = String(text ?? '');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** 找最近修改的日志文件，抓其中的错误行。不读全文——日志可能上百 MB。 */
function collectLogTail(logsDir) {
  const candidates = [];
  for (const dir of [logsDir, join(tmpdir(), 'openclaw')]) {
    try {
      for (const name of readdirSync(dir)) {
        if (!/\.(log|txt)$/i.test(name)) continue;
        const full = join(dir, name);
        try { candidates.push({ full, mtime: statSync(full).mtimeMs }); } catch { /* 跳过 */ }
      }
    } catch { /* 目录不存在 */ }
  }
  if (!candidates.length) return { file: null, lines: [] };

  candidates.sort((a, b) => b.mtime - a.mtime);
  const newest = candidates[0];
  try {
    const all = readFileSync(newest.full, 'utf8').split(/\r?\n/);
    const interesting = all.filter((l) => /\b(ERROR|FATAL|WARN|Cannot find module|EADDRINUSE|already running|refused|failed)\b/i.test(l));
    const picked = (interesting.length ? interesting : all).slice(-MAX_LOG_LINES);
    return { file: newest.full, lines: picked.map(scrub) };
  } catch {
    return { file: newest.full, lines: [] };
  }
}

function renderMarkdown({ appVersion, openclawVersion, diagnose, logs, actionLog, userNote }) {
  const L = [];
  L.push('## 环境', '');
  L.push('| 项 | 值 |', '|---|---|');
  L.push(`| U-Claw 版本 | ${appVersion ?? '未知'} |`);
  L.push(`| OpenClaw 版本 | ${openclawVersion ?? '未知'} |`);
  L.push(`| 平台 | ${platform()} ${release()} ${arch()} |`);
  L.push(`| Node | ${process.version} |`);
  L.push(`| 内存 | ${Math.round(totalmem() / 1024 / 1024 / 1024)} GB |`);
  L.push('');

  if (userNote) {
    L.push('## 问题描述', '', scrub(userNote), '');
  }

  L.push('## 诊断结果', '');
  if (diagnose?.ok) {
    const d = diagnose.data;
    L.push(`健康：${d.healthy ? '✅ 是' : '❌ 否'}　错误 ${d.summary.error}　警告 ${d.summary.warn}`, '');
    L.push('| 级别 | 项 | 详情 |', '|---|---|---|');
    for (const f of d.findings) {
      if (f.level === 'info' || f.level === 'ok') continue; // 报告只留有问题的，全量在 JSON 附件里
      L.push(`| ${f.level} | ${f.id} | ${scrub(f.detail)}${f.hint ? `<br>建议：${scrub(f.hint)}` : ''} |`);
    }
    if (d.summary.error === 0 && d.summary.warn === 0) L.push('| ok | — | 未发现异常 |');
  } else {
    L.push('诊断动作本身失败：', '```', JSON.stringify(diagnose?.error ?? null), '```');
  }
  L.push('');

  L.push('## 动作执行轨迹', '');
  if (actionLog && actionLog.length) {
    L.push('最近 ' + actionLog.length + ' 条（写入时已脱敏）：', '', '```jsonl');
    for (const e of actionLog) L.push(JSON.stringify(e));
    L.push('```');
  } else {
    L.push('暂无记录。');
  }
  L.push('');

  L.push('## 日志片段', '');
  if (logs.file && logs.lines.length) {
    L.push(`来源：\`${logs.file}\``, '', '```', ...logs.lines, '```');
  } else {
    L.push('未找到日志文件。');
  }
  L.push('');
  L.push('---', '', '> 本报告由 `uclaw bug.collect` 生成，密钥字段已自动脱敏。提交前请自行再看一眼。');
  return L.join('\n');
}

export const bugCollect = defineAction({
  id: 'bug.collect',
  title: '收集 bug 报告',
  description:
    '收集版本、环境、诊断结果和脱敏后的日志片段，生成一份可直接贴到 GitHub issue 的 Markdown 报告。' +
    '只写本地文件，不上传任何数据。',
  tags: ['diagnostics', 'support'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      note: { type: 'string', description: '用户对问题的描述，会原样（脱敏后）写进报告' },
      out: { type: 'string', description: '报告输出路径；默认写到 data/logs/bug-report-<时间戳>.md' },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      report_path: { type: 'string' },
      json_path: { type: 'string' },
      markdown: { type: 'string' },
      issue_url: { type: 'string' },
      healthy: { type: 'boolean' },
    },
    required: ['report_path', 'markdown', 'issue_url', 'healthy'],
  },
  effects: { class: 'write', risk: 'low', reversible: true, confirmation: 'never', audit_required: true },
  execution: { headless: true, idempotent: false, cancellable: true, timeout_ms: 90000, progress_events: true, headless_evidence: 'tests/action-core.test.mjs' },
  async run(input, ctx) {
    const p = ctx.paths;

    ctx.progress?.(20, '运行健康诊断');
    // 复用 doctor.diagnose 而不是重抄一遍检查逻辑 —— 宪法 #12。
    const diagnose = await execute(doctorDiagnose, {}, { ...ctx, onProgress: undefined });

    ctx.progress?.(60, '收集日志');
    const logs = collectLogTail(p.logsDir);
    // 我们自己的动作轨迹 —— 比 OpenClaw 的日志更直接说明"用户/运维做了什么"
    const actionLog = readRecentLogs(p.logsDir, 30);

    const appVersion = existsSync(p.versionFile) ? readFileSync(p.versionFile, 'utf8').trim() : null;
    let openclawVersion = null;
    try {
      openclawVersion = JSON.parse(readFileSync(join(p.coreDir, 'node_modules', 'openclaw', 'package.json'), 'utf8')).version;
    } catch { /* 未安装 */ }

    ctx.progress?.(80, '生成报告');
    const markdown = renderMarkdown({ appVersion, openclawVersion, diagnose, logs, actionLog, userNote: input.note });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = input.out || join(p.logsDir, `bug-report-${stamp}.md`);
    const jsonPath = reportPath.replace(/\.md$/, '.json');

    if (!ctx.dryRun) {
      mkdirSync(p.logsDir, { recursive: true });
      writeFileSync(reportPath, markdown, 'utf8');
      // JSON 附件给机器读（运维 / AI 直接解析，不用 parse markdown）
      writeFileSync(jsonPath, JSON.stringify({ appVersion, openclawVersion, platform: platform(), release: release(), arch: arch(), node: process.version, diagnose, logs, actionLog }, null, 2), 'utf8');
    }

    // 预填 issue 链接：用户点开是 GitHub 的新建 issue 页，内容已填好，
    // 由他自己按提交。我们不替他提交，也不往任何服务器发东西。
    const title = `[bug] ${diagnose?.data?.healthy === false ? '诊断发现问题' : '问题反馈'} — U-Claw ${appVersion ?? ''}`.trim();
    const issueUrl = `${ISSUE_BASE}?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(markdown.slice(0, 6000))}`;

    return {
      report_path: reportPath,
      json_path: jsonPath,
      markdown,
      issue_url: issueUrl,
      healthy: diagnose?.data?.healthy ?? false,
    };
  },
});

export default [bugCollect];
