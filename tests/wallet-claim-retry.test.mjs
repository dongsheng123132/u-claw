// #66: wallet state can be durable while the separate config write fails.
// Exercise real file writes with a stub bind endpoint; never touch user data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimWallet, createFileWalletStore, CLOUD_PROVIDER_ID, DEFAULT_MODEL_ID,
} from '../portable/lib/wallet-client.mjs';

const apiKey = 'sk-claim-retry-test-only';
const walletId = 'wallet-claim-retry-test-only';
const walletState = { apiKey, walletId, pendingKey: '', pendingKind: '', pendingFrom: '' };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-claim-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'uclaw-device.json');
  const configDir = join(dir, 'config');
  const configPath = join(configDir, 'openclaw.json');
  const calls = [];
  const deps = {
    store: createFileWalletStore(storePath), configPath, apiBase: 'https://wallet.invalid',
    fetch: async (url) => {
      calls.push(new URL(url).pathname);
      assert.equal(new URL(url).pathname, '/device/bind');
      return { status: 200, json: async () => ({ apiKey, walletId }) };
    },
  };
  return { storePath, configDir, configPath, calls, deps };
}

function existingConfig() {
  return {
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
    models: { mode: 'merge', providers: { deepseek: { apiKey: 'test-provider-key', models: [{ id: 'custom' }] } } },
    agents: { defaults: { model: { primary: 'deepseek/custom' }, workspace: '/keep/workspace' } },
    plugins: { entries: { weixin: { enabled: true } } },
    channels: { qqbot: { enabled: true, appId: 'test-app' } },
  };
}

function saveConfig(f, config) {
  mkdirSync(f.configDir, { recursive: true });
  writeFileSync(f.configPath, JSON.stringify(config, null, 2));
}

test('claim retry repairs config after bind persisted but the config write failed', async (t) => {
  const f = fixture(t);
  // A file where the config directory should be reliably fails on Windows and Linux.
  writeFileSync(f.configDir, 'simulate an unavailable config directory');
  const first = await claimWallet(f.deps);
  assert.equal(first.ok, false);
  assert.ok(first.error);
  assert.deepEqual(await f.deps.store.get(), walletState);

  rmSync(f.configDir);
  const before = existingConfig();
  saveConfig(f, before);
  // Reopen the persisted state, as after restarting the config server.
  f.deps.store = createFileWalletStore(f.storePath);
  const retry = await claimWallet(f.deps);
  assert.deepEqual(retry, { ok: true, apiKey, walletId, alreadyClaimed: true });
  const saved = JSON.parse(readFileSync(f.configPath, 'utf8'));
  assert.equal(saved.models.providers[CLOUD_PROVIDER_ID]?.apiKey, apiKey);
  assert.deepEqual(saved.models.providers.deepseek, before.models.providers.deepseek);
  for (const key of ['gateway', 'agents', 'channels', 'plugins']) {
    assert.deepEqual(saved[key], before[key], `${key} must survive reconciliation`);
  }
  assert.deepEqual(JSON.parse(readFileSync(f.configPath + '.bak', 'utf8')), before);
  assert.deepEqual(await f.deps.store.get(), walletState);
  assert.deepEqual(f.calls, ['/device/bind'], 'retry must not allocate another wallet');
});

test('claim retry reports repeated config write failures while preserving the saved wallet', async (t) => {
  const f = fixture(t);
  writeFileSync(f.configDir, 'blocked');
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await claimWallet(f.deps);
    assert.equal(result.ok, false, `attempt ${attempt} must not report success`);
    assert.ok(result.error);
    assert.deepEqual(await f.deps.store.get(), walletState);
    assert.equal(readFileSync(f.configDir, 'utf8'), 'blocked');
  }
  assert.deepEqual(f.calls, ['/device/bind']);
});

for (const scenario of ['missing file', 'missing provider', 'stale key']) {
  test(`already-claimed wallet repairs ${scenario} without network access`, async (t) => {
    const f = fixture(t);
    await f.deps.store.set(walletState);
    if (scenario !== 'missing file') {
      const config = existingConfig();
      if (scenario === 'stale key') config.models.providers[CLOUD_PROVIDER_ID] = { apiKey: 'sk-stale-test-only' };
      saveConfig(f, config);
    }
    const result = await claimWallet(f.deps);
    assert.deepEqual(result, { ok: true, apiKey, walletId, alreadyClaimed: true });
    const saved = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(saved.models.providers[CLOUD_PROVIDER_ID]?.apiKey, apiKey);
    assert.equal(saved.agents.defaults.model.primary,
      scenario === 'missing file' ? `${CLOUD_PROVIDER_ID}/${DEFAULT_MODEL_ID}` : 'deepseek/custom');
    assert.deepEqual(f.calls, []);
  });
}

test('already-synced claim preserves custom cloud models, primary and config bytes', async (t) => {
  const f = fixture(t);
  await f.deps.store.set(walletState);
  const config = existingConfig();
  config.models.providers[CLOUD_PROVIDER_ID] = {
    apiKey, baseUrl: 'https://custom.invalid/v1', models: [{ id: 'chosen-model', maxTokens: 1234 }],
  };
  config.agents.defaults.model.primary = `${CLOUD_PROVIDER_ID}/chosen-model`;
  saveConfig(f, config);
  // 两核都已同步：Lite 侧也写入同一把 key（否则 claim 会正确地触发 Lite 修复重写）。
  const picoHome = join(f.configDir, 'picoclaw');
  const { writePicoclawWalletConfig } = await import('../portable/lib/picoclaw-config.mjs');
  writePicoclawWalletConfig({ picoHome, apiKey });
  const picoSecBefore = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  const before = readFileSync(f.configPath, 'utf8');
  const result = await claimWallet(f.deps);
  assert.deepEqual(result, { ok: true, apiKey, walletId, alreadyClaimed: true });
  assert.equal(readFileSync(f.configPath, 'utf8'), before);
  assert.equal(readFileSync(join(picoHome, '.security.yml'), 'utf8'), picoSecBefore, 'Lite 侧字节也不变');
  assert.equal(existsSync(f.configPath + '.bak'), false, 'no redundant write or backup');
  assert.deepEqual(f.calls, []);
});

test('already-synced claim with matching key but stale Lite copy repairs via re-apply (both cores)', async (t) => {
  // 两核双写判定：OpenClaw provider key 一致但 PicoClaw .security.yml 缺失/旧 key 时，
  // claim 修复按计划走「发现不一致 → 重新 applyKey（双写）」。用户主模型归属
  // （deepseek/custom）不能被抢——「空位才占」语义在修复路径同样生效。
  const f = fixture(t);
  await f.deps.store.set(walletState);
  const config = existingConfig();
  config.models.providers[CLOUD_PROVIDER_ID] = { apiKey, baseUrl: 'https://custom.invalid/v1' };
  config.agents.defaults.model.primary = 'deepseek/custom';
  saveConfig(f, config);

  const result = await claimWallet(f.deps);
  assert.deepEqual(result, { ok: true, apiKey, walletId, alreadyClaimed: true });

  const saved = JSON.parse(readFileSync(f.configPath, 'utf8'));
  assert.equal(saved.models.providers[CLOUD_PROVIDER_ID]?.apiKey, apiKey);
  assert.equal(saved.agents.defaults.model.primary, 'deepseek/custom', '修复不得抢用户主模型');
  for (const key of ['gateway', 'agents', 'channels', 'plugins']) {
    assert.deepEqual(saved[key], existingConfig()[key], `${key} must survive repair`);
  }

  const picoHome = join(f.configDir, 'picoclaw');
  const sec = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  assert.match(sec, /^model_list:\n/m, 'Lite 侧应补写真实 schema');
  assert.ok(sec.includes(apiKey), 'Lite 侧应有同一把 key');
  const cfg = JSON.parse(readFileSync(join(picoHome, 'config.json'), 'utf8'));
  assert.equal(cfg.model_list[0].model_name, 'xiapan-v4-flash');
  assert.equal(cfg.model_list[0].provider, 'deepseek');
  assert.ok(!JSON.stringify(cfg).includes(apiKey), 'config.json 不含明文 key');
  assert.deepEqual(f.calls, [], '修复不需要网络');
});

for (const pendingKind of ['future-operation', 'rotate']) {
  test(`claim does not alter unresolved ${pendingKind} state or config`, async (t) => {
    const f = fixture(t);
    const state = { ...walletState, pendingKey: 'sk-pending-test-only', pendingKind, pendingFrom: apiKey };
    await f.deps.store.set(state);
    saveConfig(f, existingConfig());
    const before = readFileSync(f.configPath, 'utf8');
    const result = await claimWallet({ ...f.deps, verifyReadOnly: async () => false });
    assert.equal(result.ok, true); // Preserve the pre-existing pending-claim behavior.
    assert.deepEqual(await f.deps.store.get(), state);
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
    assert.deepEqual(f.calls, []);
  });
}
