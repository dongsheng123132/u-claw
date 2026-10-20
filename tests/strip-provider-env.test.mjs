// 守卫测试：启动器必须剥离宿主机 provider 凭证环境变量（ClawX exFAT 交接单坑 #2）。
//
// 事故：宿主机有 DASHSCOPE_API_KEY 时，OpenClaw 认为该 provider 已配置 → 启动迁移装
// 插件 → 要在 U 盘建 node_modules junction → exFAT 建不了 → gateway 永远不 ready。
// 同一份盘「插 A 电脑能用、插 B 电脑打不开」。ClawX 在 buildGatewayRuntimeEnv 里剥了
// 27 个变量；本仓的等价物是 strip-provider-env.mjs + 两个启动脚本消费它的输出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');

test('strip-provider-env.mjs 清单与 2026.9.1 官方 catalog 的 42 个变量一致', async () => {
  const src = read('portable/lib/strip-provider-env.mjs');
  const names = [...src.matchAll(/^  '([A-Z][A-Z0-9_]+)',$/gm)].map((m) => m[1]);
  assert.equal(names.length, 42, `清单应是 42 个字面量，实际 ${names.length}: ${names.join(',')}`);
  assert.ok(names.includes('DASHSCOPE_API_KEY'), '必须含 DASHSCOPE_API_KEY（本次事故主角）');
  assert.ok(names.includes('DEEPSEEK_API_KEY') && names.includes('GROQ_API_KEY'));
});

test('strip-provider-env.mjs：宿主机有凭证时输出名单；没有时不输出', () => {
  const script = join(repoRoot, 'portable', 'lib', 'strip-provider-env.mjs');

  const out1 = execFileSync(process.execPath, [script], {
    env: { ...process.env, DASHSCOPE_API_KEY: 'sk-host-secret', GROQ_API_KEY: 'gq-x' },
    encoding: 'utf8',
  });
  assert.match(out1, /UCLAW_STRIP_ENV=DASHSCOPE_API_KEY,GROQ_API_KEY/);
  // 只报名字不报值——值是第三方凭证，不能进命令行/日志
  assert.doesNotMatch(out1, /sk-host-secret/);

  const out2 = execFileSync(process.execPath, [script], {
    env: { PATH: process.env.PATH || '' },
    encoding: 'utf8',
  });
  assert.equal(out2.trim(), '', '干净环境不该有任何输出');
});

test('Windows-Start.bat 在起 gateway 前消费 UCLAW_STRIP_ENV 并逐个清除', () => {
  const bat = read('portable/Windows-Start.bat');
  const stripPos = bat.indexOf('strip-provider-env.mjs');
  const gwPos = bat.indexOf('gateway run');
  assert.ok(stripPos > 0, 'Windows-Start.bat 必须调用 strip-provider-env.mjs');
  assert.ok(gwPos > stripPos, '剥离必须发生在 gateway run 之前');
  assert.match(bat, /for %%v in \(%UCLAW_STRIP_ENV%\) do set "%%v="/, '逐个 set "VAR=" 清除');
});

test('Mac-Start.command 在起 gateway 前消费 UCLAW_STRIP_ENV 并 unset', () => {
  const sh = read('portable/Mac-Start.command');
  const stripPos = sh.indexOf('strip-provider-env.mjs');
  const gwPos = sh.indexOf('gateway run');
  assert.ok(stripPos > 0, 'Mac-Start.command 必须调用 strip-provider-env.mjs');
  assert.ok(gwPos > stripPos, '剥离必须发生在 gateway run 之前');
  assert.match(sh, /unset "\$_v"/, '逐个 unset');
  assert.match(sh, /\$\{_UCLAW_STRIP_ENV\/\/,\/ \}/, '逗号清单必须先转换为空格，才能逐个 unset');
});
