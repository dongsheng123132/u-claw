import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardOfficialProviders, guardOfficialProvidersInMemory } from '../portable/lib/official-provider-guard.mjs';

const gateway = { mode: 'local', auth: { mode: 'token', token: 'uclaw' } };
const deepseek = { baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', apiKey: 'secret' };
// 测试隔离：开发机 portable/app/core 里真实装着 @openclaw/deepseek-provider，
// guard 的 pluginInstalled 一看插件已预装就放过改名。每个 T1 类用例必须传一个
// 空 coreDir，否则同一份测试在本机和 CI 跑出两种结果（本机 7 挂、CI 全绿）。
function emptyCoreDir() {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-guard-nocore-'));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  return dir;
}
const ISOLATED = () => ({ catalogPath: false, coreDir: emptyCoreDir() });

test('T1: official provider is renamed and primary follows it', () => {
  const config = { gateway, models: { providers: { deepseek: { ...deepseek } } }, agents: { defaults: { model: { primary: 'deepseek/deepseek-v3' } } } };
  const result = guardOfficialProvidersInMemory(config, { ...ISOLATED() });
  assert.equal(result.changed, true);
  assert.equal(config.models.providers.deepseek, undefined);
  assert.deepEqual(config.models.providers['deepseek-api'], deepseek);
  assert.equal(config.agents.defaults.model.primary, 'deepseek-api/deepseek-v3');
});

test('T1: an installed official plugin is left untouched', () => {
  const coreDir = mkdtempSync(join(tmpdir(), 'uclaw-provider-core-'));
  const packageDir = join(coreDir, 'node_modules', '@openclaw', 'deepseek-provider');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), '{}');
  const config = { gateway, models: { providers: { deepseek: { ...deepseek } } } };
  const result = guardOfficialProvidersInMemory(config, { coreDir, catalogPath: false });
  assert.equal(result.changed, false);
  assert.ok(config.models.providers.deepseek);
  assert.equal(config.models.providers['deepseek-api'], undefined);
});

test('T2: flat ZAI SecretRef becomes zai-api and primary follows it', () => {
  const secretRef = { source: 'store', provider: 'default', id: 'UCLAW_MODEL_ZAI_API_KEY' };
  const config = { gateway, env: { ZAI_API_KEY: secretRef }, agents: { defaults: { model: { primary: 'zai/glm-5.3-flash' } } } };
  const result = guardOfficialProvidersInMemory(config, { ...ISOLATED() });
  assert.equal(result.changed, true);
  assert.equal(config.env.ZAI_API_KEY, undefined);
  assert.equal(config.models.providers['zai-api'].apiKey, secretRef);
  assert.equal(config.models.providers['zai-api'].baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(config.agents.defaults.model.primary, 'zai-api/glm-5.3-flash');
  assert.ok(result.actions.includes('zai env -> zai-api provider'));
});

test('T2: env.vars is handled and non-inferable official credentials are quarantined', () => {
  const nestedSecret = { source: 'store', provider: 'default', id: 'UCLAW_MODEL_Z_AI_API_KEY' };
  const dashscopeSecret = { source: 'store', provider: 'default', id: 'UCLAW_MODEL_DASHSCOPE_API_KEY' };
  const legacySecret = { source: 'store', provider: 'default', id: 'UCLAW_MODEL_OLD_KEY' };
  const config = { gateway, meta: { uclawQuarantinedEnv: { OLD_KEY: legacySecret } }, env: { vars: { Z_AI_API_KEY: nestedSecret, DASHSCOPE_API_KEY: dashscopeSecret } }, agents: { defaults: { model: { primary: 'zai/glm-5' } } } };
  const stateDir = mkdtempSync(join(tmpdir(), 'uclaw-provider-state-'));
  const quarantinePath = join(stateDir, 'uclaw-provider-guard-quarantine.json');
  guardOfficialProvidersInMemory(config, { ...ISOLATED(), quarantinePath });
  assert.equal(config.env.vars.Z_AI_API_KEY, undefined);
  assert.equal(config.env.vars.DASHSCOPE_API_KEY, undefined);
  assert.equal(config.models.providers['zai-api'].apiKey, nestedSecret);
  assert.equal(config.meta?.uclawQuarantinedEnv, undefined);
  assert.deepEqual(JSON.parse(readFileSync(quarantinePath, 'utf8')).env.DASHSCOPE_API_KEY, dashscopeSecret);
  assert.deepEqual(JSON.parse(readFileSync(quarantinePath, 'utf8')).env.OLD_KEY, legacySecret);
  assert.equal(config.agents.defaults.model.primary, 'zai-api/glm-5');
});

test('T1 conflict: official provider is quarantined when its -api provider already exists', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uclaw-provider-conflict-'));
  const quarantinePath = join(stateDir, 'uclaw-provider-guard-quarantine.json');
  const official = { ...deepseek, apiKey: 'official-secret' };
  const api = { ...deepseek, apiKey: 'portable-secret' };
  const config = { gateway, models: { providers: { deepseek: official, 'deepseek-api': api } }, agents: { defaults: { model: { primary: 'deepseek/v3' } } } };
  const result = guardOfficialProvidersInMemory(config, { ...ISOLATED(), quarantinePath });
  assert.equal(config.models.providers.deepseek, undefined);
  assert.deepEqual(config.models.providers['deepseek-api'], api);
  assert.deepEqual(JSON.parse(readFileSync(quarantinePath, 'utf8')).providers.deepseek, official);
  assert.equal(config.agents.defaults.model.primary, 'deepseek-api/v3');
  assert.ok(result.actions.includes('quarantined official provider deepseek (conflict)'));
});

test('.env official keys are removed, backed up, and ZAI becomes zai-api', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uclaw-provider-dotenv-'));
  const envPath = join(stateDir, '.env');
  writeFileSync(envPath, 'KEEP=yes\nDEEPSEEK_API_KEY=deepseek-secret\nZAI_API_KEY=zai-secret\n');
  const quarantinePath = join(stateDir, 'uclaw-provider-guard-quarantine.json');
  const config = { gateway, agents: { defaults: { model: { primary: 'zai/glm-5.3-flash' } } } };
  guardOfficialProvidersInMemory(config, { ...ISOLATED(), stateDir, quarantinePath });
  assert.equal(readFileSync(envPath, 'utf8').includes('DEEPSEEK_API_KEY'), false);
  assert.equal(readFileSync(envPath, 'utf8').includes('ZAI_API_KEY'), false);
  assert.ok(readdirSync(stateDir).some((name) => /^\.env\.provider-guard-bak-\d{6}$/.test(name)));
  assert.equal(config.models.providers['zai-api'].apiKey, 'zai-secret');
  assert.equal(JSON.parse(readFileSync(quarantinePath, 'utf8')).env.DEEPSEEK_API_KEY, 'deepseek-secret');
});

test('.env dotenv decoding strips BOM, paired quotes, and trailing comments; ZAI-only is backed up', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uclaw-provider-dotenv-decode-'));
  const envPath = join(stateDir, '.env');
  writeFileSync(envPath, '\uFEFFexport ZAI_API_KEY="za#i key" # trailing\nDEEPSEEK_API_KEY=deep-key # trailing\nKEEP=value # comment\n');
  const config = { gateway, agents: { defaults: { model: { primary: 'zai/glm-5' } } } };
  guardOfficialProvidersInMemory(config, { ...ISOLATED(), stateDir, quarantinePath: join(stateDir, 'sidecar.json') });
  assert.equal(config.models.providers['zai-api'].apiKey, 'za#i key');
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'sidecar.json'), 'utf8')).env.DEEPSEEK_API_KEY, 'deep-key');
  assert.equal(readFileSync(envPath, 'utf8').includes('ZAI_API_KEY'), false);
  assert.ok(readdirSync(stateDir).some((name) => /^\.env\.provider-guard-bak-\d{6}$/.test(name)), 'ZAI-only removal must also leave a backup');
});

test('a broken sidecar is rebuilt but source official entries are retained for this run', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uclaw-provider-broken-sidecar-'));
  const quarantinePath = join(stateDir, 'uclaw-provider-guard-quarantine.json');
  writeFileSync(quarantinePath, '{broken');
  const config = { gateway, models: { providers: { deepseek: { ...deepseek }, 'deepseek-api': { ...deepseek, apiKey: 'portable' } } } };
  const result = guardOfficialProvidersInMemory(config, { ...ISOLATED(), quarantinePath });
  assert.ok(config.models.providers.deepseek, 'an untrustworthy prior sidecar must not cause source deletion');
  assert.deepEqual(JSON.parse(readFileSync(quarantinePath, 'utf8')).providers.deepseek, deepseek);
  assert.ok(result.actions.includes('quarantine unavailable, kept official entries'));
});

test('an unavailable sidecar destination retains official entries and records a warning', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'uclaw-provider-readonly-sidecar-'));
  const blockedParent = join(stateDir, 'not-a-directory');
  writeFileSync(blockedParent, 'file');
  const config = { gateway, models: { providers: { deepseek: { ...deepseek }, 'deepseek-api': { ...deepseek, apiKey: 'portable' } } } };
  const result = guardOfficialProvidersInMemory(config, { ...ISOLATED(), quarantinePath: join(blockedParent, 'sidecar.json') });
  assert.ok(config.models.providers.deepseek);
  assert.ok(result.actions.includes('quarantine unavailable, kept official entries'));
});

test('without quarantinePath, a conflicting official provider is retained instead of deleted', () => {
  const config = { gateway, models: { providers: { deepseek: { ...deepseek }, 'deepseek-api': { ...deepseek, apiKey: 'portable' } } } };
  const result = guardOfficialProvidersInMemory(config, { ...ISOLATED() });
  assert.ok(config.models.providers.deepseek);
  assert.ok(result.actions.includes('conflict kept: pass quarantinePath to remove (deepseek)'));
});

test('all model references migrate with a renamed provider', () => {
  const config = {
    gateway,
    models: { providers: { deepseek: { ...deepseek } } },
    agents: {
      defaults: { model: { primary: 'deepseek/a', fallbacks: ['deepseek/b', 'other/c'] }, models: { 'deepseek/d': {}, 'other/e': {} } },
      entries: {
        one: { model: 'deepseek/f', fallbacks: ['deepseek/g'], models: { 'deepseek/h': {} } },
        two: { model: { primary: 'deepseek/i', fallbacks: ['deepseek/j'] } },
      },
    },
  };
  guardOfficialProvidersInMemory(config, { ...ISOLATED() });
  assert.deepEqual(config.agents.defaults.model.fallbacks, ['deepseek-api/b', 'other/c']);
  assert.ok(config.agents.defaults.models['deepseek-api/d']);
  assert.equal(config.agents.entries.one.model, 'deepseek-api/f');
  assert.deepEqual(config.agents.entries.one.fallbacks, ['deepseek-api/g']);
  assert.ok(config.agents.entries.one.models['deepseek-api/h']);
  assert.equal(config.agents.entries.two.model.primary, 'deepseek-api/i');
  assert.deepEqual(config.agents.entries.two.model.fallbacks, ['deepseek-api/j']);
});

test('model key migration never overwrites an existing target key', () => {
  const config = { gateway, models: { providers: { deepseek: { ...deepseek } } }, agents: { defaults: { models: { 'deepseek/a': { source: 'old' }, 'deepseek-api/a': { source: 'new' } } } } };
  const result = guardOfficialProvidersInMemory(config, { ...ISOLATED() });
  assert.deepEqual(config.agents.defaults.models['deepseek/a'], { source: 'old' });
  assert.deepEqual(config.agents.defaults.models['deepseek-api/a'], { source: 'new' });
  assert.ok(result.actions.includes('model key conflict kept: deepseek/a'));
});

test('disk guard is fail-open for malformed JSON and an unwritable directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-provider-guard-'));
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{not json');
  assert.doesNotThrow(() => guardOfficialProviders(broken, false));

  const protectedConfig = join(dir, 'openclaw.json');
  writeFileSync(protectedConfig, JSON.stringify({ models: { providers: { deepseek } } }));
  try {
    chmodSync(dir, 0o555);
    assert.doesNotThrow(() => guardOfficialProviders(protectedConfig, false));
  } finally {
    chmodSync(dir, 0o755);
  }
});
