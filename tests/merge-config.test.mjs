// 回归测试：issue #58（微信扫码成功但 clawbot 不响应）。
//
// 根因是 config-server 的 POST /api/config 曾经整体覆盖写盘，UI 保存模型配置时不带 plugins
// 字段，把微信登录写入的 config.plugins.entries 冲没了。lib/merge-config.mjs 把它改成
// "合并写入 + 原子落盘"：受管字段（models/agents/env/gateway/commands/meta）整体替换、
// 支持删除；其余字段（plugins、未知顶层字段）原样保留磁盘版本。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeConfig,
  readConfigSafe,
  writeConfigAtomic,
  saveConfigMerged,
  MANAGED_TOP_LEVEL_KEYS,
} from '../portable/lib/merge-config.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-merge-config-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── mergeConfig：纯函数行为 ──────────────────────────────────────────────

test('mergeConfig: 保存模型配置时，plugins 必须存活（issue #58 回归测试）', () => {
  const existing = {
    plugins: { entries: { 'local-tools': { enabled: true } } },
    models: { mode: 'merge', providers: { oldProvider: { baseUrl: 'https://old' } } },
  };
  const incoming = {
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
    commands: { native: 'auto' },
    meta: { lastTouchedVersion: '2026.3.13' },
    models: { mode: 'merge', providers: { minimax: { baseUrl: 'https://minimax' } } },
    agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
  };

  const merged = mergeConfig(existing, incoming);

  assert.deepEqual(
    merged.plugins,
    { entries: { 'local-tools': { enabled: true } } },
    '磁盘上已有的 plugins 字段必须原样保留'
  );
  // 受管字段以本次请求为准
  assert.deepEqual(merged.models, incoming.models);
  assert.deepEqual(merged.agents, incoming.agents);
});

test('mergeConfig: 用户删掉一个 provider，删除必须生效，不能被合并救回', () => {
  const existing = {
    models: {
      mode: 'merge',
      providers: {
        keepMe: { baseUrl: 'https://keep' },
        deleteMe: { baseUrl: 'https://delete' },
      },
    },
  };
  // 前端本次提交的 models.providers 里已经不含 deleteMe —— 模拟用户在 UI 里删掉了这个 provider。
  const incoming = {
    models: {
      mode: 'merge',
      providers: { keepMe: { baseUrl: 'https://keep' } },
    },
  };

  const merged = mergeConfig(existing, incoming);

  assert.ok(!('deleteMe' in merged.models.providers), 'deleteMe 不应该被合并救回');
  assert.ok('keepMe' in merged.models.providers);
});

test('mergeConfig: 未知顶层字段必须保留', () => {
  const existing = { someFutureField: { hello: 'world' }, models: { providers: {} } };
  const incoming = { models: { providers: { a: {} } } };

  const merged = mergeConfig(existing, incoming);

  assert.deepEqual(merged.someFutureField, { hello: 'world' });
});

test('mergeConfig: 受管字段整体替换，不做深合并（避免"删不掉"的另一个 bug）', () => {
  const existing = { gateway: { mode: 'local', extraKnob: true } };
  const incoming = { gateway: { mode: 'local' } };

  const merged = mergeConfig(existing, incoming);

  // gateway 仍按整体替换：incoming 带了就以它为准（extraKnob 消失），
  // 但保存侧会兜底补全缺失的 auth 子对象（2026-09-01 起，防 runtime token 漂移）。
  assert.deepEqual(merged.gateway, {
    mode: 'local',
    auth: { mode: 'token', token: 'uclaw' },
  }, 'gateway 整体替换后 auth 缺失应被兜底补全');
});

test('mergeConfig: 旧版废弃键 agent（单数）始终被清除', () => {
  const merged = mergeConfig({ agent: { legacy: true } }, {});
  assert.ok(!('agent' in merged));
});

test('mergeConfig: 非对象输入不崩，按空对象处理（gateway 兜底仍生效）', () => {
  assert.deepEqual(mergeConfig(null, { models: {} }), {
    models: {},
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
  });
  assert.deepEqual(mergeConfig({ plugins: { a: 1 } }, null), {
    plugins: { a: 1 },
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
  });
  assert.deepEqual(mergeConfig(undefined, undefined), {
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
  });
});

// ── readConfigSafe：磁盘上损坏 JSON / 文件不存在 ─────────────────────────

test('readConfigSafe: 文件不存在时返回空对象，不抛出', () => {
  withTempDir((dir) => {
    const p = join(dir, 'does-not-exist.json');
    assert.deepEqual(readConfigSafe(p), {});
  });
});

test('readConfigSafe: 磁盘上是损坏 JSON 时返回空对象，不抛出、不崩', () => {
  withTempDir((dir) => {
    const p = join(dir, 'openclaw.json');
    writeFileSync(p, '{ this is not valid json ');
    assert.deepEqual(readConfigSafe(p), {});
  });
});

test('readConfigSafe: 磁盘上是数组/非对象 JSON 时也当作空对象', () => {
  withTempDir((dir) => {
    const p = join(dir, 'openclaw.json');
    writeFileSync(p, '[1,2,3]');
    assert.deepEqual(readConfigSafe(p), {});
  });
});

// ── writeConfigAtomic / saveConfigMerged：落盘行为 ───────────────────────

test('writeConfigAtomic: 写完之后文件内容正确，且不留临时文件', () => {
  withTempDir((dir) => {
    const p = join(dir, 'nested', 'openclaw.json');
    writeConfigAtomic(p, { hello: 'world' });
    assert.ok(existsSync(p));
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { hello: 'world' });

    const leftovers = readdirSync(join(dir, 'nested')).filter((f) => f.includes('.tmp-'));
    assert.equal(leftovers.length, 0, '写盘完成后不应残留 .tmp- 临时文件');
  });
});

test('writeConfigAtomic: 覆盖已有文件时会留一份 .bak', () => {
  withTempDir((dir) => {
    const p = join(dir, 'openclaw.json');
    writeConfigAtomic(p, { version: 1 });
    writeConfigAtomic(p, { version: 2 });

    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { version: 2 });
    assert.ok(existsSync(p + '.bak'));
    assert.deepEqual(JSON.parse(readFileSync(p + '.bak', 'utf8')), { version: 1 });
  });
});

test('saveConfigMerged: 端到端——磁盘损坏 JSON 时保存模型配置不崩、不把整个配置清零成异常', () => {
  withTempDir((dir) => {
    const p = join(dir, 'openclaw.json');
    writeFileSync(p, '{ broken json');

    const incoming = { models: { providers: { minimax: {} } } };
    const result = saveConfigMerged(p, incoming);

    assert.deepEqual(result.models, incoming.models);
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), result);
  });
});

test('saveConfigMerged: 端到端——已有 plugins 时保存模型配置，plugins 存活（issue #58）', () => {
  withTempDir((dir) => {
    const p = join(dir, 'openclaw.json');
    writeFileSync(p, JSON.stringify({
      plugins: { entries: { 'local-tools': { enabled: true } } },
    }));

    const incoming = {
      gateway: { mode: 'local' },
      models: { providers: { minimax: {} } },
      agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
    };
    saveConfigMerged(p, incoming);

    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(onDisk.plugins, { entries: { 'local-tools': { enabled: true } } });
    assert.deepEqual(onDisk.models, incoming.models);
  });
});

test('模型保存主动移除旧渠道并保留非渠道插件和未知配置', () => {
  const old = { channels: { telegram: { botToken: 'test-only-secret' } }, bindings: [{ match: { channel: 'telegram' }, agentId: 'main' }],
    plugins: { entries: { 'openclaw-weixin': { enabled: true }, 'local-tools': { enabled: true } }, allow: ['telegram', 'uclaw-wallet'], load: { paths: ['C:/portable/extensions/openclaw-weixin', 'C:/portable/extensions/uclaw-wallet'] } }, unknown: { retained: true } };
  const merged = mergeConfig(old, { models: { providers: {} } });
  assert.equal(merged.channels, undefined);
  assert.equal(merged.bindings, undefined);
  assert.deepEqual(merged.plugins.entries, { 'local-tools': { enabled: true } });
  assert.deepEqual(merged.plugins.allow, ['uclaw-wallet']);
  assert.deepEqual(merged.plugins.load.paths, ['C:/portable/extensions/uclaw-wallet']);
  assert.deepEqual(merged.unknown, { retained: true });
  assert.ok(old.channels.telegram);
});
