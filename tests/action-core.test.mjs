// 动作契约测试（ActionParity §13.1）
//
// 这些测试直接调动作核心断言业务行为——毫秒级、确定性、不起 GUI、不碰真实用户状态。
// 改造前这类行为根本没法测：逻辑锁在 .bat 和 .html 里，tests/ 只能断言脚本的**文本**
// （"这一行有没有转义括号"），断不了"存模型会不会冲掉渠道"。
//
// 每个用例都在独立临时目录里跑（§11.3 沙箱要求 + 宪法 #10 不碰用户真实状态）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execute, getAction, ACTIONS } from '../portable/lib/core/index.mjs';
import { redact, validateSchema } from '../portable/lib/core/runtime.mjs';

/** 造一个隔离沙箱，返回 ctx.paths 形状的对象。 */
function sandbox(configObject) {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-test-'));
  const home = join(root, 'data');
  const stateDir = join(home, '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(stateDir, 'openclaw.json');
  if (configObject !== undefined) writeFileSync(configPath, JSON.stringify(configObject, null, 2));
  return {
    root,
    paths: {
      root, home, stateDir, configPath,
      backupsDir: join(home, 'backups'),
      logsDir: join(home, 'logs'),
      extensionsDir: join(stateDir, 'extensions'),
      coreDir: join(root, 'app', 'core'),
      runtimeDir: join(root, 'app', 'runtime'),
      bundledExtensionsDir: join(root, 'app', 'extensions'),
      versionFile: join(root, 'OPENCLAW_VERSION'),
      runtimeJson: join(stateDir, 'runtime.json'),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const run = (id, input, ctx) => execute(getAction(id), input, ctx);

// ── 结果契约 ────────────────────────────────────────────────────────────────

test('每个动作都声明了 §7.4 要求的执行语义', () => {
  for (const a of ACTIONS) {
    assert.ok(a.id.includes('.'), `${a.id} 应使用 resource.verb 命名`);
    assert.equal(typeof a.effects.risk, 'string', `${a.id} 缺 risk`);
    assert.ok(['read', 'write', 'external', 'financial', 'destructive'].includes(a.effects.class), `${a.id} 的 effects.class 非法`);
    assert.ok(['never', 'conditional', 'always'].includes(a.effects.confirmation), `${a.id} 的 confirmation 非法`);
    assert.equal(a.execution.headless, true, `${a.id} 必须能无界面执行`);
    assert.ok(Number.isFinite(a.execution.timeout_ms) && a.execution.timeout_ms > 0, `${a.id} 必须有有限超时`);
  }
});

test('结果永远是 §7.5 的结构化信封，失败也不抛异常', async () => {
  const sb = sandbox({});
  try {
    // 故意传非法输入
    const r = await run('config.set', { patch: 'not-an-object' }, { paths: sb.paths });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INVALID_INPUT');
    assert.ok(r.execution_id.startsWith('exec_'));
    assert.equal(typeof r.meta.duration_ms, 'number');
    assert.equal(r.data, null);
  } finally { sb.cleanup(); }
});

// ── 核心回归：存模型不能冲掉渠道 ─────────────────────────────────────────────

test('config.set 默认深合并，不会冲掉调用方没提到的字段', async () => {
  const sb = sandbox({
    gateway: { auth: { token: 'uclaw' } },
    channels: { telegram: { botToken: '123:ABC' } },
    plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
  });
  try {
    const r = await run('config.set', {
      patch: { agents: { defaults: { model: { primary: 'deepseek/deepseek-chat' } } } },
    }, { paths: sb.paths });

    assert.equal(r.ok, true, JSON.stringify(r.error));
    const saved = JSON.parse(readFileSync(sb.paths.configPath, 'utf8'));
    // 这三条就是那个 bug 的回归断言：接完微信再改模型，渠道不能掉
    assert.deepEqual(saved.channels, { telegram: { botToken: '123:ABC' } });
    assert.deepEqual(saved.plugins.entries['openclaw-weixin'], { enabled: true });
    assert.equal(saved.gateway.auth.token, 'uclaw');
    assert.equal(saved.agents.defaults.model.primary, 'deepseek/deepseek-chat');
  } finally { sb.cleanup(); }
});

test('config.set 写前留底', async () => {
  const sb = sandbox({ a: 1 });
  try {
    const r = await run('config.set', { patch: { b: 2 } }, { paths: sb.paths });
    assert.equal(r.ok, true);
    assert.ok(r.data.backup, '应返回备份路径');
    assert.deepEqual(JSON.parse(readFileSync(r.data.backup, 'utf8')), { a: 1 });
  } finally { sb.cleanup(); }
});

test('config.set 的 replace 模式在会丢字段时必须拦住', async () => {
  const sb = sandbox({ gateway: { x: 1 }, channels: { y: 2 } });
  try {
    const r = await run('config.set', { patch: { models: {} }, mode: 'replace' }, { paths: sb.paths });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'DESTRUCTIVE_REPLACE');
    assert.deepEqual(r.error.details.fields ?? r.error.details.lost, ['gateway', 'channels']);
    // 文件不能被动过
    assert.deepEqual(JSON.parse(readFileSync(sb.paths.configPath, 'utf8')), { gateway: { x: 1 }, channels: { y: 2 } });
  } finally { sb.cleanup(); }
});

test('config.set 拒绝写入脱敏占位值（防止 GUI 读回来又存回去毁掉真 Key）', async () => {
  const sb = sandbox({ models: { providers: { ds: { apiKey: 'sk-REAL-KEY-123456' } } } });
  try {
    const r = await run('config.set', {
      patch: { models: { providers: { ds: { apiKey: 'sk-R…3456' } } } },
    }, { paths: sb.paths });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'REDACTED_VALUE_WRITE');
    // 真 Key 必须原封不动
    const saved = JSON.parse(readFileSync(sb.paths.configPath, 'utf8'));
    assert.equal(saved.models.providers.ds.apiKey, 'sk-REAL-KEY-123456');
  } finally { sb.cleanup(); }
});

test('config.set 的 unset 能显式删除键', async () => {
  const sb = sandbox({ agent: { legacy: true }, keep: 1 });
  try {
    const r = await run('config.set', { patch: {}, unset: ['agent'] }, { paths: sb.paths });
    assert.equal(r.ok, true);
    const saved = JSON.parse(readFileSync(sb.paths.configPath, 'utf8'));
    assert.equal('agent' in saved, false);
    assert.equal(saved.keep, 1);
  } finally { sb.cleanup(); }
});

test('config.set 原子落盘：损坏的配置不会被静默覆盖', async () => {
  const sb = sandbox();
  writeFileSync(sb.paths.configPath, '{ 这不是合法 JSON');
  try {
    const r = await run('config.set', { patch: { a: 1 } }, { paths: sb.paths });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'CONFIG_CORRUPT');
    // 原文件保留，等用户自己救
    assert.equal(readFileSync(sb.paths.configPath, 'utf8'), '{ 这不是合法 JSON');
  } finally { sb.cleanup(); }
});

// ── 密钥不外泄 ──────────────────────────────────────────────────────────────

test('config.get 出口一律脱敏，明文密钥不出现在结果里', async () => {
  const secret = 'sk-SECRET-CUSTOMER-KEY-12345';
  const sb = sandbox({ gateway: { auth: { token: 'uclaw' } }, models: { providers: { ds: { apiKey: secret } } } });
  try {
    const r = await run('config.get', {}, { paths: sb.paths });
    assert.equal(r.ok, true);
    assert.equal(JSON.stringify(r).includes(secret), false, '明文密钥泄漏到结果里了');
    assert.notEqual(r.data.config.models.providers.ds.apiKey, secret);
  } finally { sb.cleanup(); }
});

test('redact 覆盖常见密钥键名，且能扛住循环引用', () => {
  const node = { apiKey: 'sk-aaaaaaaaaaaa', nested: { authorization: 'Bearer xyz123456' }, safe: 'keep-me' };
  node.self = node;
  const out = redact(node);
  assert.equal(out.safe, 'keep-me');
  assert.notEqual(out.apiKey, 'sk-aaaaaaaaaaaa');
  assert.notEqual(out.nested.authorization, 'Bearer xyz123456');
  assert.equal(out.self, '[Circular]');
});

// ── 确认策略在表现层之下强制（§11.2）────────────────────────────────────────

test('confirmation:always 的动作，没拿到 confirmed 一律拒绝', async () => {
  const sb = sandbox({});
  try {
    const r = await run('gateway.stop', {}, { paths: sb.paths });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'CONFIRMATION_REQUIRED');
  } finally { sb.cleanup(); }
});

test('confirmation:conditional 的动作在安全路径上不该被拦（否则启动器会卡住）', async () => {
  const sb = sandbox({});
  try {
    const r = await run('lock.clean', {}, { paths: sb.paths });
    assert.equal(r.ok, true, '启动流程会内部调用 lock.clean，不能要求交互确认');
  } finally { sb.cleanup(); }
});

// ── 诊断 ────────────────────────────────────────────────────────────────────

test('doctor.diagnose 无界面可跑，返回结构化 findings', async () => {
  const sb = sandbox({ agents: { defaults: { model: { primary: 'deepseek/x' } } } });
  try {
    const r = await run('doctor.diagnose', { scope: ['config'] }, { paths: sb.paths });
    assert.equal(r.ok, true);
    assert.equal(typeof r.data.healthy, 'boolean');
    assert.ok(Array.isArray(r.data.findings));
    for (const f of r.data.findings) {
      assert.ok(['ok', 'info', 'warn', 'error'].includes(f.level), `未知级别 ${f.level}`);
      assert.equal(typeof f.id, 'string');
    }
    assert.ok(r.data.findings.some((f) => f.id === 'config.model'), '应报告主模型状态');
  } finally { sb.cleanup(); }
});

test('doctor.diagnose 的 scope 能限定检查范围', async () => {
  const sb = sandbox({});
  try {
    const r = await run('doctor.diagnose', { scope: ['config'] }, { paths: sb.paths });
    assert.equal(r.data.findings.some((f) => f.id.startsWith('gateway.')), false, 'scope 未生效');
  } finally { sb.cleanup(); }
});

// ── bug 报告 ────────────────────────────────────────────────────────────────

test('bug.collect 生成报告，且日志里的密钥被脱敏', async () => {
  const sb = sandbox({ models: { providers: { ds: { apiKey: 'sk-INSIDE-CONFIG-999' } } } });
  mkdirSync(sb.paths.logsDir, { recursive: true });
  writeFileSync(join(sb.paths.logsDir, 'openclaw-test.log'), [
    'ERROR Cannot find module \'zod\'',
    'INFO  loaded apiKey: sk-LEAKED-FROM-LOG-777',
    'WARN  Authorization: Bearer eyJhbGciOi.SUPERSECRETVALUE',
  ].join('\n'));
  try {
    const r = await run('bug.collect', { note: '我的 key 是 sk-INNOTE-555555555' }, { paths: sb.paths });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(existsSync(r.data.report_path));

    const report = readFileSync(r.data.report_path, 'utf8');
    for (const leak of ['sk-LEAKED-FROM-LOG-777', 'SUPERSECRETVALUE', 'sk-INNOTE-555555555']) {
      assert.equal(report.includes(leak), false, `报告里泄漏了 ${leak}`);
    }
    // 但诊断信息必须还在，否则报告没用
    assert.ok(report.includes("Cannot find module 'zod'"), '有用的错误行被误删了');
    // 不自动上传：只给一个预填链接，提交与否由用户决定
    assert.ok(r.data.issue_url.startsWith('https://github.com/'));
  } finally { sb.cleanup(); }
});

// ── 微信插件 ────────────────────────────────────────────────────────────────

test('plugin.wechat.install 没有内置插件时安静跳过，不阻断启动', async () => {
  const sb = sandbox({});
  try {
    const r = await run('plugin.wechat.install', {}, { paths: sb.paths });
    assert.equal(r.ok, true);
    assert.equal(r.data.action, 'skipped-no-source');
  } finally { sb.cleanup(); }
});

test('plugin.wechat.install 会铺设、补 zod、并在版本变化时升级', async () => {
  const sb = sandbox({});
  const src = join(sb.paths.bundledExtensionsDir, 'openclaw-weixin');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-weixin', version: '2.1.1' }));
  mkdirSync(join(sb.paths.coreDir, 'node_modules', 'zod'), { recursive: true });
  writeFileSync(join(sb.paths.coreDir, 'node_modules', 'zod', 'index.js'), '// zod');

  try {
    // 首次：铺设 + 带上 zod
    let r = await run('plugin.wechat.install', {}, { paths: sb.paths });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.action, 'installed');
    const dst = join(sb.paths.extensionsDir, 'openclaw-weixin');
    assert.ok(existsSync(join(dst, 'node_modules', 'zod')), 'zod 没补上，微信渠道会整个加载失败');

    // 再跑一次：幂等，什么都不做
    r = await run('plugin.wechat.install', {}, { paths: sb.paths });
    assert.equal(r.data.action, 'none');

    // 源版本升到 2.2.0 → 必须重铺（改造前这里永远不会升级）
    writeFileSync(join(src, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-weixin', version: '2.2.0' }));
    r = await run('plugin.wechat.install', {}, { paths: sb.paths });
    assert.equal(r.data.action, 'upgraded');
    assert.equal(r.data.installed_version, '2.2.0');
  } finally { sb.cleanup(); }
});

test('plugin.wechat.install 能自愈"已铺好但缺 zod"的旧盘', async () => {
  const sb = sandbox({});
  const src = join(sb.paths.bundledExtensionsDir, 'openclaw-weixin');
  const dst = join(sb.paths.extensionsDir, 'openclaw-weixin');
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  const manifest = JSON.stringify({ id: 'openclaw-weixin', version: '2.1.1' });
  writeFileSync(join(src, 'openclaw.plugin.json'), manifest);
  writeFileSync(join(dst, 'openclaw.plugin.json'), manifest); // 已铺好，同版本
  mkdirSync(join(sb.paths.coreDir, 'node_modules', 'zod'), { recursive: true });
  writeFileSync(join(sb.paths.coreDir, 'node_modules', 'zod', 'index.js'), '// zod');

  try {
    const r = await run('plugin.wechat.install', {}, { paths: sb.paths });
    assert.equal(r.ok, true);
    assert.equal(r.data.action, 'zod-repaired');
    assert.ok(existsSync(join(dst, 'node_modules', 'zod')));
  } finally { sb.cleanup(); }
});

// ── schema 校验器自身 ───────────────────────────────────────────────────────

test('validateSchema 覆盖 required / 类型 / enum / additionalProperties', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string' }, mode: { enum: ['a', 'b'] }, n: { type: 'number' } },
  };
  assert.equal(validateSchema(schema, { name: 'x' }).length, 0);
  assert.ok(validateSchema(schema, {}).some((e) => e.includes('name')));
  assert.ok(validateSchema(schema, { name: 1 }).some((e) => e.includes('字符串')));
  assert.ok(validateSchema(schema, { name: 'x', mode: 'c' }).length > 0);
  assert.ok(validateSchema(schema, { name: 'x', extra: 1 }).some((e) => e.includes('extra')));
});
