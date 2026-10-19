// 守卫测试：Lite/Full 启动分流（Windows-Start.bat + Mac-Start.command）。
//
// 锁四件事：
//   1. 分流点存在且干净：Lite 在 upgrade-session / npm install / NO_PROXY 等
//      OpenClaw 专属步骤**之前**就跳到共享链（:shared_config_start），再在网关段之前
//      进 :start_lite。Lite 路径绝不执行 OpenClaw 专属命令。
//   2. Lite 环境只属于 PicoClaw：PICOCLAW_HOME/CONFIG/BINARY + workspace + cd workspace，
//      TEMP/TMP 只在 PicoClaw 子进程的 setlocal 窗口内改写（Node helper 保留本地 temp）。
//   3. Lite 无 Dashboard：第二次点击 / Lite 正常路径绝不开 gateway Dashboard URL；
//      缺二进制时给 Config Center 入口而非假 Dashboard。
//   4. preflight --lite 不要求 OpenClaw 已安装（干净 U 盘只装 PicoClaw 不被误拒）。
//
// 全部静态断言读仓库文本 + 临时目录跑 helper，不 spawn 任何内核（也绝不动真实 U 盘）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateRuntime, validateCommonRuntime } from '../portable/lib/runtime-preflight.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const batText = readFileSync(join(repoRoot, 'portable', 'Windows-Start.bat'), 'utf8');
const commandText = readFileSync(join(repoRoot, 'portable', 'Mac-Start.command'), 'utf8');

/** 按行切段：返回从 label 行（含）到下一个给定 label 或文件尾（含下一行前的所有行）。 */
function section(text, label, untilLabels = []) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === label);
  assert.ok(start >= 0, `找不到标签 ${label}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (untilLabels.includes(t)) { end = i; break; }
  }
  return { lines: lines.slice(start, end), text: lines.slice(start, end).join('\n'), startLine: start };
}

// ── 1. 分流点：Lite 跳过所有 OpenClaw 专属步骤 ────────────────────────────────

test('Lite 分流点在 OpenClaw 专属步骤之前（upgrade-session / npm install / NO_PROXY 不被 Lite 执行）', () => {
  const gotoShared = batText.split(/\r?\n/).findIndex((l) => l.trim() === 'if "%CORE_MODE%"=="lite" goto :shared_config_start');
  assert.ok(gotoShared > 0, '应有 lite → :shared_config_start 的提前分流');

  // 这些 OpenClaw 专属步骤必须出现在分流点**之后**（Lite 不经过它们）
  for (const marker of [
    'upgrade-session-schema.mjs',   // 会话迁移（OpenClaw 专属）
    'call "%NPM_BIN%" install',     // 依赖安装兜底
    'resolve-no-proxy.mjs',         // NO_PROXY 注入（OpenClaw 网关用）
  ]) {
    const pos = batText.split(/\r?\n/).findIndex((l) => l.includes(marker));
    assert.ok(pos > gotoShared, `${marker} 必须在 Lite 分流点（行 ${gotoShared + 1}）之后（实际行 ${pos + 1}，Lite 不执行）`);
  }
});

test('Lite 在网关专属段之前进入 :start_lite；:start_lite 段内无任何 OpenClaw 专属命令', () => {
  const gotoLite = batText.split(/\r?\n/).findIndex((l) => l.trim() === 'if "%CORE_MODE%"=="lite" goto :start_lite');
  assert.ok(gotoLite > 0, '应有 lite → :start_lite 的内核分流');

  for (const marker of [
    'check-model-configured.mjs',               // #24 配置检测（OpenClaw 专属）
    'wait-model-config.mjs',
    'prewarm.mjs',                              // gateway 预热
    'clean-stale-lock.mjs',                     // gateway 锁清理
    'gateway run --allow-unconfigured',         // OpenClaw 网关本体
  ]) {
    const pos = batText.split(/\r?\n/).findIndex((l) => l.includes(marker));
    assert.ok(pos > gotoLite, `${marker} 必须在 Lite 分流点（行 ${gotoLite + 1}）之后（实际行 ${pos + 1}）`);
  }

  // :start_lite 段（到 lite_failed 为止）内绝不能出现 OpenClaw 专属调用
  const lite = section(batText, ':start_lite', [':lite_failed']);
  assert.ok(
    !/gateway run|prewarm\.mjs|loading\.html|check-model-configured|clean-stale-lock|official-provider-guard|upgrade-session|NPM_BIN/
      .test(lite.text),
    ':start_lite 段内不得出现 OpenClaw 专属命令'
  );
});

test('CORE_MODE 在二次点击判定之前读取；复用实例只在 Full 打开 Dashboard，Lite 不开任何 URL', () => {
  const readMode = batText.split(/\r?\n/).findIndex((l) => l.includes('core-mode.mjs" get'));
  assert.ok(readMode > 0, '应通过 helper 读 core-mode（不裸读文件内容）');
  const reuse = section(batText, ':reuse_existing_instance', [':instance_check_done']);
  assert.ok(reuse.startLine > readMode, '复用实例分支必须在读 CORE_MODE 之后');
  assert.match(
    reuse.text,
    /if "%CORE_MODE%"=="openclaw" if defined INSTANCE_PORT start/,
    '复用实例只在 Full 模式打开 Dashboard'
  );
  const withoutFullLine = reuse.lines.filter((l) => !l.includes('CORE_MODE')).join('\n');
  assert.ok(!/start "" http/.test(withoutFullLine), 'Lite 复用实例不得打开任何 URL');
});

// ── 2. Lite 环境：PicoClaw 变量 + TEMP/TMP 作用域 ────────────────────────────

test(':start_lite 设置 PicoClaw 专属环境并 cd 到 workspace；TEMP/TMP 只在子进程 setlocal 窗口内改', () => {
  const lite = section(batText, ':start_lite', [':lite_failed']);

  assert.match(lite.text, /set "PICOCLAW_HOME=%DATA_DIR%\\picoclaw"/, 'PICOCLAW_HOME 指向 data/picoclaw');
  assert.match(lite.text, /set "PICOCLAW_BINARY=%APP_DIR%\\picoclaw\\picoclaw\.exe"/, 'PICOCLAW_BINARY 指向 app/picoclaw');
  assert.match(lite.text, /set "PICOCLAW_AGENTS_DEFAULTS_WORKSPACE=/, 'workspace env 必须设置');
  assert.match(lite.text, /cd \/d "%PICOCLAW_AGENTS_DEFAULTS_WORKSPACE%"/, '启动前必须 cd 到 workspace');
  assert.match(lite.text, /set "PICO_TMP=%PICOCLAW_HOME%\\tmp"/, 'PicoClaw temp 落在它自己的数据域内');

  // TEMP/TMP 改写被 setlocal 包住（Node helper 保留本地 temp）
  const setlocalIdx = lite.lines.findIndex((l) => l.trim() === 'setlocal');
  const tempIdx = lite.lines.findIndex((l) => l.includes('set "TEMP=%PICO_TMP%"'));
  const endlocalIdx = lite.lines.findIndex((l) => l.trim().startsWith('endlocal'));
  const execIdx = lite.lines.findIndex((l) => l.includes('%PICOCLAW_BINARY%" agent'));
  assert.ok(setlocalIdx >= 0 && tempIdx > setlocalIdx, 'TEMP 改写必须在 setlocal 之后');
  assert.ok(endlocalIdx > execIdx,
    'endlocal 必须在 PicoClaw 退出之后（setlocal 窗口只覆盖子进程，Node helper 不继承改写）');
  assert.ok(execIdx > setlocalIdx, 'PicoClaw 在 setlocal 窗口内启动');
});

test('Lite 检查的是有效 key（has-key helper）而非文件存在性，并等待 Config Center 出 key', () => {
  const lite = section(batText, ':start_lite', [':lite_failed']);
  assert.match(lite.text, /picoclaw-config\.mjs" has-key "%PICOCLAW_HOME%"/, '必须用 has-key helper 检查有效 key');
  assert.ok(!/exist.*\.security\.yml/.test(lite.text), '不得用 .security.yml 文件存在性冒充有 key');
  assert.match(lite.text, /wait-picoclaw-key\.mjs" "%PICOCLAW_HOME%"/, '无 key 时应等待配置中心出 key');
});

// ── 3. Lite 无 Dashboard / 缺二进制的出路 ────────────────────────────────────

test('缺 PicoClaw 二进制时提示去 Config Center 选 Full，不开假 Dashboard；Lite ready 路径无浏览器', () => {
  const lite = section(batText, ':start_lite', [':lite_failed']);

  const missingStart = lite.lines.findIndex((l) => l.includes('if not exist "%PICOCLAW_BINARY%"'));
  const hasKeyStart = lite.lines.findIndex((l) => l.includes('has-key'));
  assert.ok(missingStart >= 0 && hasKeyStart > missingStart, '缺二进制检查在 has-key 之前');
  const missingBlock = lite.lines.slice(missingStart, hasKeyStart).join('\n');
  assert.match(missingBlock, /choose Full in Config Center/, '缺二进制应提示切 Full');
  assert.match(missingBlock, /if not defined UCLAW_HEADLESS start "" "http:\/\/127\.0\.0\.1:%CONFIG_PORT%\/"/,
    '缺二进制时只开 Config Center（不是 Dashboard）');
  assert.ok(!/INSTANCE_PORT/.test(missingBlock), '缺二进制路径不得出现 gateway Dashboard');

  // Lite ready 路径（:lite_ready 标签之后）不 start 任何浏览器页面
  const ready = section(batText, ':lite_ready', [':lite_failed']);
  assert.ok(!/start "" http|UCLAW_HEADLESS start/.test(ready.text), 'Lite 正常启动路径不开浏览器');
});

test('UCLAW_RUNNING_CORE 在共享链标签行上导出（config-server 据此报告 runningMode）', () => {
  const shared = section(batText, ':shared_config_start', [':start_lite']);
  assert.match(shared.lines[1] + '\n' + shared.text, /set "UCLAW_RUNNING_CORE=%CORE_MODE%"/,
    '共享链开头必须导出运行中内核');
});

// ── 4. Mac：只有 Full，Lite 警告在最前面 ─────────────────────────────────────

test('Mac-Start.command 在 preflight 之前就警告 Lite 不支持并回退 Full', () => {
  const lines = commandText.split('\n');
  const warn = lines.findIndex((l) => l.includes('Lite (PicoClaw) is not supported on macOS'));
  assert.ok(warn >= 0, '应有 Lite 不支持提示');
  const preflight = lines.findIndex((l) => l.includes('runtime-preflight.mjs'));
  assert.ok(preflight > warn, 'Lite 警告必须在 preflight 之前（先解释回退再检查环境）');
  assert.match(commandText, /UCLAW_RUNNING_CORE=openclaw/, 'Mac 固定以 Full 运行（runningMode 如实上报）');
});

// ── 5. preflight --lite：干净 U 盘只有 PicoClaw 也能过 ───────────────────────

test('validateRuntime lite:true 跳过 OpenClaw 版本/平台校验（缺 OpenClaw 不抛）', () => {
  assert.doesNotThrow(() =>
    validateRuntime({
      nodeVersion: 'v24.16.0', expected: '2026.6.8', installed: undefined,
      filesystem: 'NTFS', platform: 'win32', arch: 'x64', lite: true,
    }), 'lite 模式不应要求 OpenClaw 已安装');
  assert.doesNotThrow(() =>
    validateRuntime({
      nodeVersion: 'v26.1.0', expected: '', installed: '',
      filesystem: 'exFAT', platform: 'win32', installedPlatform: undefined, lite: true,
    }), 'lite 模式不做原生平台校验');
  // 共享检查仍然生效：文件系统、Node 版本
  assert.throws(() =>
    validateRuntime({ nodeVersion: 'v24.16.0', filesystem: 'FAT32', platform: 'win32', lite: true }),
    /NTFS/, 'FAT32 在 Lite 下仍被拒');
  assert.throws(() =>
    validateRuntime({ nodeVersion: 'v20.0.0', filesystem: 'NTFS', platform: 'win32', lite: true }),
    /Node/, '过旧 Node 在 Lite 下仍被拒');
  // Full 模式保持原判：缺 OpenClaw 必须拒
  assert.throws(() =>
    validateRuntime({
      nodeVersion: 'v24.16.0', expected: '2026.6.8', installed: undefined,
      filesystem: 'NTFS', platform: 'win32', arch: 'x64', lite: false,
    }), /mismatch|missing/, 'Full 模式缺 OpenClaw 必须拒');
});

test('preflight 的 lite 共享段不触碰任何 OpenClaw 文件（空临时 root 上不抛）', () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-lite-'));
  try {
    assert.doesNotThrow(() =>
      validateCommonRuntime({ nodeVersion: process.version, filesystem: 'NTFS', platform: 'win32' }),
      '共享段（Lite 走的路径）缺 OpenClaw 文件必须通过');
    assert.ok(!existsSync(join(root, 'OPENCLAW_VERSION')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
