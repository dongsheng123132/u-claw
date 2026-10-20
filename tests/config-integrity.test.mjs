import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from '../portable/lib/merge-config.mjs';
import { guardOfficialProviders } from '../portable/lib/official-provider-guard.mjs';

const catalogPath = new URL(
  '../portable/app/core/node_modules/openclaw/scripts/lib/official-external-provider-catalog.json',
  import.meta.url,
);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-config-integrity-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 空 coreDir（无任何预装插件）——测试不依赖开发机/发版包的真实安装状态（opus 审码要求）。
const NO_CORE = { coreDir: join(tmpdir(), 'uclaw-no-such-core') };

test('gateway: incoming 不带 gateway 时保留磁盘配置', () => {
  const gateway = { mode: 'local', auth: { mode: 'token', token: 'uclaw' } };
  const merged = mergeConfig({ gateway }, { models: { providers: {} } });
  assert.deepEqual(merged.gateway, gateway);
});

test('gateway: 缺失时自动补全本地 token 配置', () => {
  assert.deepEqual(mergeConfig({}, {}).gateway, {
    mode: 'local', auth: { mode: 'token', token: 'uclaw' },
  });
});

test('gateway: 残缺 auth / 缺失 token / 空 token 都能自愈且不覆盖已有值', () => {
  const missingAuth = mergeConfig({ gateway: { mode: 'remote' } }, {});
  assert.deepEqual(missingAuth.gateway, {
    mode: 'remote', auth: { mode: 'token', token: 'uclaw' },
  });
  const missingToken = mergeConfig({ gateway: { mode: 'local', auth: { mode: 'token' } } }, {});
  assert.equal(missingToken.gateway.auth.token, 'uclaw', 'auth 存在但 token 缺失也要补（opus 2.1）');
  const nullToken = mergeConfig({ gateway: { mode: 'local', auth: { mode: 'token', token: null } } }, {});
  assert.equal(nullToken.gateway.auth.token, 'uclaw');
  const emptyToken = mergeConfig({ gateway: { mode: 'local', auth: { mode: 'token', token: '' } } }, {});
  assert.equal(emptyToken.gateway.auth.token, 'uclaw');
  const custom = mergeConfig({ gateway: { mode: 'local', auth: { mode: 'token', token: 'mytok' } } }, {});
  assert.equal(custom.gateway.auth.token, 'mytok', '已有 token 不覆盖');
  const bearer = mergeConfig({ gateway: { mode: 'local', auth: { mode: 'bearer' } } }, {});
  assert.equal(bearer.gateway.auth.token, undefined, '非 token 模式不注入');
});

test('official provider guard: 改名 provider key 并同步默认模型引用', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      models: { providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions' } } },
      agents: { defaults: { model: { primary: 'deepseek/deepseek-chat' } } },
    }));

    const actions = guardOfficialProviders(configPath, catalogPath, NO_CORE);
    assert.ok(actions.some((a) => a.includes('renamed deepseek→deepseek-api')), String(actions));
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(saved.models.providers['deepseek-api']);
    assert.ok(!saved.models.providers.deepseek);
    assert.equal(saved.agents.defaults.model.primary, 'deepseek-api/deepseek-chat');
    assert.ok(
      readdirSync(dir).some((name) => name.startsWith('openclaw.json.provider-guard-bak-')),
      '实际改名时必须尽力留下改名前的备份',
    );
  });
});

test('official provider guard: 官方插件已预装时保留原名（v2.1.28+ 新包体验）', () => {
  withTempDir((dir) => {
    const coreDir = join(dir, 'core');
    const pluginPkg = join(coreDir, 'node_modules', '@openclaw', 'deepseek-provider', 'package.json');
    mkdirSync(dirname(pluginPkg), { recursive: true });
    writeFileSync(pluginPkg, JSON.stringify({ name: '@openclaw/deepseek-provider', version: '2026.8.1' }));
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
      models: { providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions' } } },
      agents: { defaults: { model: { primary: 'deepseek/deepseek-chat' } } },
    }));

    assert.deepEqual(guardOfficialProviders(configPath, catalogPath, { coreDir }), []);
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(saved.models.providers.deepseek, '插件已装时 provider key 应保留原名');
    assert.equal(saved.agents.defaults.model.primary, 'deepseek/deepseek-chat');
  });
});

test('official provider guard: 非官方名不改（gateway 完整时无任何动作）', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
      models: { providers: { myProvider: {} } },
    }));
    assert.deepEqual(guardOfficialProviders(configPath, catalogPath, NO_CORE), []);
    assert.ok(JSON.parse(readFileSync(configPath, 'utf8')).models.providers.myProvider);
  });
});

test('official provider guard: 与 <id>-api 同名共存时官方条目进隔离仓（T1 必须解除）', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      models: {
        providers: {
          deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions' },
          'deepseek-api': { baseUrl: 'https://api.example.com', api: 'openai-completions' },
        },
      },
    }));
    const actions = guardOfficialProviders(configPath, catalogPath, NO_CORE);
    assert.ok(actions.some((a) => a.includes('deepseek')), String(actions));
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    // R2 修复（sol 审码 F3）：共存 skip 会把致命 T1 留在配置里——官方条目必须离场
    assert.equal(saved.models.providers.deepseek, undefined, '官方 deepseek 条目必须被隔离移除');
    assert.ok(saved.models.providers['deepseek-api'], '用户手建条目保留');
    // 隔离仓 sidecar 落盘且内容可恢复
    const sidecar = JSON.parse(readFileSync(join(dir, 'uclaw-provider-guard-quarantine.json'), 'utf8'));
    assert.ok(sidecar.providers.deepseek, '官方条目进 sidecar.providers');
    assert.equal(sidecar.providers.deepseek.baseUrl, 'https://api.deepseek.com');
  });
});

test('official provider guard: 缺 baseUrl/api 的裸条目不改名（改了也调不通）', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ models: { providers: { deepseek: {} } } }));
    const actions = guardOfficialProviders(configPath, catalogPath, NO_CORE);
    assert.ok(actions.some((a) => a.startsWith('skip deepseek')), String(actions));
    assert.ok(JSON.parse(readFileSync(configPath, 'utf8')).models.providers.deepseek);
  });
});

test('official provider guard: 启动侧 gateway 自愈（无 gateway 段的存量盘）', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      models: { providers: { myProvider: {} } },
    }));
    const actions = guardOfficialProviders(configPath, catalogPath, NO_CORE);
    assert.ok(actions.some((a) => a.startsWith('gateway')), String(actions));
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.gateway.auth.token, 'uclaw');
    assert.equal(saved.gateway.mode, 'local');
  });
});

test('official provider guard: catalog 缺失时退回快照仍能护住 deepseek', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      models: { providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions' } } },
      agents: { defaults: { model: { primary: 'deepseek/deepseek-chat' } } },
    }));

    const actions = guardOfficialProviders(configPath, join(dir, 'missing.json'), NO_CORE);
    assert.ok(actions.some((a) => a.includes('deepseek→deepseek-api')), String(actions));
    assert.ok(JSON.parse(readFileSync(configPath, 'utf8')).models.providers['deepseek-api']);
  });
});

test('official provider guard: catalog 与快照都不可用时 fail-open，不抛也不改文件', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'openclaw.json');
    const raw = JSON.stringify({ models: { providers: { deepseek: {} } } });
    writeFileSync(configPath, raw);
    assert.doesNotThrow(() =>
      guardOfficialProviders(configPath, join(dir, 'missing-catalog.json'), { snapshot: [] }));
    assert.equal(readFileSync(configPath, 'utf8'), raw);
  });
});

test('config page restores saved baseUrl and primary model after selecting a card', () => {
  const page = readFileSync(join(repoRoot, 'portable', 'config-server', 'public', 'index.html'), 'utf8');
  assert.match(page, /selectedBase = p\.baseUrl \|\| selectedBase/);
  assert.match(page, /primary.*cfg\.agents|cfg\.agents.*primary/s);
  assert.match(page, /if \(modelId\) selectedModel = modelId/);
});
