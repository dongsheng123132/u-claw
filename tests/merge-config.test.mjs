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
    plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
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
    { entries: { 'openclaw-weixin': { enabled: true } } },
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

  assert.deepEqual(merged.gateway, { mode: 'local' }, 'gateway.extraKnob 应随整体替换一起消失');
});

test('mergeConfig: 旧版废弃键 agent（单数）始终被清除', () => {
  const merged = mergeConfig({ agent: { legacy: true } }, {});
  assert.ok(!('agent' in merged));
});

test('mergeConfig: 非对象输入不崩，按空对象处理', () => {
  assert.deepEqual(mergeConfig(null, { models: {} }), { models: {} });
  assert.deepEqual(mergeConfig({ plugins: { a: 1 } }, null), { plugins: { a: 1 } });
  assert.deepEqual(mergeConfig(undefined, undefined), {});
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
      plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
    }));

    const incoming = {
      gateway: { mode: 'local' },
      models: { providers: { minimax: {} } },
      agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
    };
    saveConfigMerged(p, incoming);

    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(onDisk.plugins, { entries: { 'openclaw-weixin': { enabled: true } } });
    assert.deepEqual(onDisk.models, incoming.models);
  });
});

test('MANAGED_TOP_LEVEL_KEYS 与 Config.html 里前端双保险的清单保持一致', () => {
  // 这条测试是"防漂移"——Config.html 的 saveConfig() 里手写了一份同样的白名单
  // (MANAGED_CONFIG_KEYS) 用于前端双保险，两边分叉会导致文档说的策略跟实际代码不一致。
  const html = readFileSync(new URL('../portable/Config.html', import.meta.url), 'utf8');
  const m = html.match(/MANAGED_CONFIG_KEYS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'Config.html 里应有 MANAGED_CONFIG_KEYS 常量');
  const frontendKeys = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(new Set(frontendKeys), new Set(MANAGED_TOP_LEVEL_KEYS));
});
