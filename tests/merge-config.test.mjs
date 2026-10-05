// 回归测试：issue #58（微信扫码成功但 clawbot 不响应）。
//
// 根因是 config-server 的 POST /api/config 曾经整体覆盖写盘，UI 保存模型配置时不带 plugins
// 字段，把微信登录写入的 config.plugins.entries 冲没了。lib/merge-config.mjs 把它改成
// "合并写入 + 原子落盘"：受管字段（models/agents/env/gateway/commands/meta）整体替换、
// 支持删除；其余字段（plugins、未知顶层字段）原样保留磁盘版本。
//
// issue #67（渠道配置保存假成功）补充：channels 不是受管字段，之前渠道页 POST 的 channels 被
// mergeConfig 静默丢弃而服务端仍回 {ok:true}。现在 channels 属于「请求带了才整体替换」一类。

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
// 命名空间导入：REPLACE_IF_PRESENT_KEYS 在旧代码上不存在，用命名导入会让整个测试文件加载失败，
// 而不是只让相关用例失败。
import * as mergeConfigModule from '../portable/lib/merge-config.mjs';

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

// ── issue #67：channels（请求带了才整体替换，没带保留磁盘版本）─────────────

test('REPLACE_IF_PRESENT_KEYS: 只含 channels，且不与受管字段重叠（否则保存模型会清空渠道）', () => {
  const replaceIfPresent = mergeConfigModule.REPLACE_IF_PRESENT_KEYS;
  assert.deepEqual([...replaceIfPresent], ['channels']);
  for (const key of replaceIfPresent) {
    assert.ok(!MANAGED_TOP_LEVEL_KEYS.includes(key), `${key} 不能进 MANAGED_TOP_LEVEL_KEYS`);
  }
});

test('mergeConfig: 请求带 channels 时整体替换磁盘 channels（新增写入、请求里删掉的渠道消失）——issue #67 回归', () => {
  const existing = {
    channels: {
      qqbot: { enabled: true, appId: 'old-app', clientSecret: 'old-secret' },
      feishu: { enabled: true, appId: 'fs-app', appSecret: 'fs-secret' },
    },
  };
  // 渠道页 GET → 改 → POST：新增 telegram、去掉 feishu。
  const incoming = {
    channels: {
      qqbot: { enabled: true, appId: 'old-app', clientSecret: 'old-secret' },
      telegram: { enabled: true, botToken: 'tg-token', dmPolicy: 'pairing' },
    },
  };

  const merged = mergeConfig(existing, incoming);

  assert.deepEqual(merged.channels, incoming.channels, 'channels 应以本次请求为准整体替换');
  assert.ok('telegram' in merged.channels, '新增的 telegram 必须写进去');
  assert.ok(!('feishu' in merged.channels), '请求里删掉的 feishu 不能被合并救回');
});

test('mergeConfig: 磁盘没有 channels、请求带 channels 时也会写入', () => {
  const incoming = { channels: { telegram: { enabled: true, botToken: 'tg-token' } } };
  const merged = mergeConfig({ models: { providers: {} } }, incoming);
  assert.deepEqual(merged.channels, incoming.channels);
});

test('mergeConfig: 请求不带 channels（保存模型）时，磁盘 channels 原样保留', () => {
  const existing = {
    channels: { telegram: { enabled: true, botToken: 'tg-token', dmPolicy: 'pairing' } },
    models: { providers: { old: {} } },
  };
  const incoming = {
    models: { providers: { minimax: {} } },
    agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
  };

  const merged = mergeConfig(existing, incoming);

  assert.deepEqual(merged.channels, existing.channels, '模型页不带 channels，不能把渠道冲掉');
  assert.deepEqual(merged.models, incoming.models);
});

test('mergeConfig: 请求里的 plugins 仍然被无视（只有 channels 享受新规则）', () => {
  const existing = {
    plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
    channels: { qqbot: { enabled: true } },
  };
  const incoming = {
    plugins: { entries: { hacked: { enabled: true } } },
    someFutureField: { x: 1 },
    channels: { telegram: { enabled: true } },
  };

  const merged = mergeConfig(existing, incoming);

  assert.deepEqual(merged.plugins, existing.plugins, '请求里的 plugins 必须被无视，磁盘版本胜出');
  assert.ok(!('someFutureField' in merged), '请求里其它未知顶层字段仍被无视');
  assert.deepEqual(merged.channels, incoming.channels);
});

test('mergeConfig: 请求里的 channels 不是对象（null / 字符串 / 数组）时，保留磁盘 channels', () => {
  const existing = { channels: { telegram: { enabled: true, botToken: 'tg-token' } } };
  for (const bad of [null, 'x', ['telegram'], 42, true]) {
    const merged = mergeConfig(existing, { channels: bad });
    assert.deepEqual(
      merged.channels,
      existing.channels,
      `incoming.channels=${JSON.stringify(bad)} 时应保留磁盘版本`
    );
  }
});

test('mergeConfig: 替换 channels 不改动入参，且 gateway 保底 / agent 清除照常生效', () => {
  const existing = { channels: { a: { enabled: true } }, agent: { legacy: true } };
  const incoming = { channels: { b: { enabled: true } } };
  const existingSnapshot = JSON.parse(JSON.stringify(existing));

  const merged = mergeConfig(existing, incoming);

  assert.deepEqual(existing, existingSnapshot, 'existing 不应被改动');
  assert.deepEqual(merged.channels, { b: { enabled: true } });
  assert.ok(!('agent' in merged));
  assert.deepEqual(merged.gateway, { mode: 'local', auth: { mode: 'token', token: 'uclaw' } });
});

test('saveConfigMerged: 端到端——渠道页 GET→加 channels→POST，channels 落盘且 plugins / models 完好（issue #67）', () => {
  withTempDir((dir) => {
    const p = join(dir, 'openclaw.json');
    const disk = {
      gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
      models: { mode: 'merge', providers: { minimax: { baseUrl: 'https://minimax' } } },
      agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
      plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
    };
    writeFileSync(p, JSON.stringify(disk));

    // 模拟渠道页：GET 整份配置，加上 channels 再 POST 回来。
    const incoming = JSON.parse(readFileSync(p, 'utf8'));
    incoming.channels = {
      telegram: { enabled: true, botToken: 'tg-token', dmPolicy: 'pairing' },
    };
    saveConfigMerged(p, incoming);

    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(onDisk.channels, incoming.channels, 'channels 必须真的落盘');
    assert.deepEqual(onDisk.plugins, disk.plugins, 'plugins 必须完好');
    assert.deepEqual(onDisk.models, disk.models, 'models 必须完好');
    assert.deepEqual(onDisk.agents, disk.agents, 'agents 必须完好');

    // 随后保存一次模型（不带 channels）：渠道不能被冲掉。
    saveConfigMerged(p, {
      gateway: disk.gateway,
      models: { mode: 'merge', providers: { other: {} } },
      agents: disk.agents,
    });
    const afterModelSave = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(afterModelSave.channels, incoming.channels, '保存模型后 channels 仍在');
    assert.deepEqual(afterModelSave.plugins, disk.plugins);
  });
});

// ── keepProviders：别的写入方（虾盘云钱包的 uclaw-cloud）活过配置中心保存 ─────────
//
// 配置中心 buildConfig() 一次只提交选中的那个 provider，而 models 是受管字段、整体替换：
// 领取钱包后再存一次 DeepSeek，磁盘上的 uclaw-cloud 就被冲掉，已付费额度从配置里不可达。
// server.js 的 POST /api/config 传 { keepProviders: ['uclaw-cloud'] } 把它补回来；
// 不传该选项的调用方（钱包 removeKey()）行为不变，仍可删掉它。

function walletProvider() {
  return {
    baseUrl: 'https://api.u-claw.org/v1',
    apiKey: 'sk-wallet-original',
    api: 'openai-completions',
    models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', reasoning: false }],
  };
}

function walletDisk() {
  return {
    models: {
      mode: 'merge',
      providers: { 'uclaw-cloud': walletProvider(), staleOne: { baseUrl: 'https://stale' } },
    },
    agents: { defaults: { model: { primary: 'uclaw-cloud/deepseek-v4-flash' } } },
  };
}

// 配置中心 buildConfig('deepseek', ...) 的形状：只带选中的 provider + 它自己的主模型。
function deepseekSave() {
  return {
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' }, remote: { token: 'uclaw' } },
    commands: { native: 'auto', nativeSkills: 'auto', restart: true },
    models: {
      mode: 'merge',
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: { source: 'store', provider: 'default', id: 'UCLAW_MODEL_DEEPSEEK' },
          api: 'openai-completions',
          models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }],
        },
      },
    },
    agents: { defaults: { model: { primary: 'deepseek/deepseek-v4-flash' } } },
  };
}

test('mergeConfig(keepProviders): 请求没点名 uclaw-cloud 时磁盘条目被补回，请求自己的 provider 与主模型照常生效', () => {
  const existing = walletDisk();
  const incoming = deepseekSave();

  const merged = mergeConfig(existing, incoming, { keepProviders: ['uclaw-cloud'] });

  assert.deepEqual(Object.keys(merged.models.providers).sort(), ['deepseek', 'uclaw-cloud']);
  assert.deepEqual(merged.models.providers['uclaw-cloud'], walletProvider(), '磁盘上的钱包 provider 必须原样补回（含原 apiKey）');
  assert.deepEqual(merged.models.providers.deepseek, incoming.models.providers.deepseek, '请求自己的 provider 以请求为准');
  assert.ok(!('staleOne' in merged.models.providers), '没被 keep 的磁盘 provider 仍按整体替换被删掉（#58 语义）');
  assert.equal(merged.models.mode, 'merge');
  assert.deepEqual(merged.agents, incoming.agents, '主模型以请求为准，不被 keepProviders 改写');
});

test('mergeConfig(keepProviders): 请求点名了 uclaw-cloud 时以请求为准，不用磁盘版本覆盖', () => {
  const existing = walletDisk();
  const incoming = deepseekSave();
  const ref = { source: 'store', provider: 'default', id: 'UCLAW_MODEL_UCLAW_CLOUD' };
  incoming.models.providers['uclaw-cloud'] = { baseUrl: 'https://api.u-claw.org/v1', apiKey: ref, api: 'openai-completions', models: [] };

  const merged = mergeConfig(existing, incoming, { keepProviders: ['uclaw-cloud'] });

  assert.deepEqual(merged.models.providers['uclaw-cloud'], incoming.models.providers['uclaw-cloud']);
  assert.deepEqual(merged.models.providers['uclaw-cloud'].apiKey, ref, '请求里的新 key 必须胜出');
});

test('mergeConfig: 不传 keepProviders 时行为不变——请求没带的 uclaw-cloud 照样被删（#58 删除语义守卫）', () => {
  const incoming = deepseekSave();
  for (const options of [undefined, {}, { keepProviders: [] }, { keepProviders: 'uclaw-cloud' }, null]) {
    const merged = mergeConfig(walletDisk(), incoming, options);
    assert.ok(!('uclaw-cloud' in merged.models.providers), `options=${JSON.stringify(options)} 时 uclaw-cloud 应被删除`);
    assert.deepEqual(merged.models, incoming.models);
  }
});

test('mergeConfig(keepProviders): 请求根本没带 models（或 models.providers 不是对象）时不复活任何东西', () => {
  const existing = walletDisk();
  const keep = { keepProviders: ['uclaw-cloud'] };

  const noModels = mergeConfig(existing, { agents: { defaults: { model: { primary: 'x/y' } } } }, keep);
  assert.ok(!('models' in noModels), '没带 models 仍按"未带视为清空"处理，不能借 keepProviders 救活整段 models');

  const noProviders = mergeConfig(existing, { models: { mode: 'merge' } }, keep);
  assert.deepEqual(noProviders.models, { mode: 'merge' });

  for (const bad of [null, 'x', ['uclaw-cloud'], 42]) {
    const merged = mergeConfig(existing, { models: { mode: 'merge', providers: bad } }, keep);
    assert.deepEqual(merged.models, { mode: 'merge', providers: bad }, `providers=${JSON.stringify(bad)} 时原样交给请求，不补回`);
  }

  const badModels = mergeConfig(existing, { models: 'oops' }, keep);
  assert.equal(badModels.models, 'oops');
});

test('mergeConfig(keepProviders): 磁盘上没有该条目 / 不是对象 / keepProviders 含脏值时，什么都不补', () => {
  const incoming = deepseekSave();
  const keep = { keepProviders: ['uclaw-cloud', 42, null, '__proto__', 'toString'] };

  const noDisk = mergeConfig({}, incoming, keep);
  assert.deepEqual(noDisk.models, incoming.models);

  const brokenDisk = mergeConfig({ models: { providers: { 'uclaw-cloud': 'sk-oops' } } }, incoming, keep);
  assert.deepEqual(brokenDisk.models, incoming.models, '磁盘条目不是对象不补回');

  const arrayDisk = mergeConfig({ models: { providers: ['uclaw-cloud'] } }, incoming, keep);
  assert.deepEqual(arrayDisk.models, incoming.models);
});

test('mergeConfig(keepProviders): 不改动入参，补回的条目是拷贝', () => {
  const existing = walletDisk();
  const incoming = deepseekSave();
  const options = { keepProviders: ['uclaw-cloud'] };
  const snapshots = [existing, incoming, options].map((v) => JSON.parse(JSON.stringify(v)));

  const merged = mergeConfig(existing, incoming, options);

  assert.deepEqual([existing, incoming, options], snapshots, 'existing / incoming / options 都不应被改动');
  assert.notEqual(merged.models.providers, incoming.models.providers, '必须新建 providers 对象，不能往请求的对象里塞');
  assert.ok(!('uclaw-cloud' in incoming.models.providers));
  assert.notEqual(merged.models.providers['uclaw-cloud'], existing.models.providers['uclaw-cloud'], '补回的是拷贝，不与磁盘对象共享引用');

  // 之后在 merged 上原地改（server.js 的 provider 守卫就会这么做）不能回写到 existing。
  merged.models.providers['uclaw-cloud'].apiKey = 'mutated';
  assert.equal(existing.models.providers['uclaw-cloud'].apiKey, 'sk-wallet-original');
});

test('saveConfigMerged: options.keepProviders 透传——uclaw-cloud 落盘保留；不传则被删（removeKey 仍可删）', () => {
  withTempDir((dir) => {
    const p = join(dir, 'openclaw.json');
    writeFileSync(p, JSON.stringify(walletDisk()));

    const kept = saveConfigMerged(p, deepseekSave(), { keepProviders: ['uclaw-cloud'] });
    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(onDisk, kept);
    assert.deepEqual(Object.keys(onDisk.models.providers).sort(), ['deepseek', 'uclaw-cloud']);
    assert.equal(onDisk.models.providers['uclaw-cloud'].apiKey, 'sk-wallet-original');
    assert.equal(onDisk.agents.defaults.model.primary, 'deepseek/deepseek-v4-flash');

    // 不带选项（wallet-client.removeKey() 走的路径）：请求里没有 uclaw-cloud，就是要删掉它。
    saveConfigMerged(p, deepseekSave());
    const afterRemove = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(Object.keys(afterRemove.models.providers), ['deepseek']);
  });
});
