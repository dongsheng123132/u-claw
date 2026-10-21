import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { copyDirSync } from '../portable/lib/copy-dir.mjs';
import { createWalletHandlers } from '../portable/extensions/uclaw-wallet/runtime.js';
import browserPlugin from '../portable/extensions/uclaw-wallet/dist/control-ui/browser.js';
import { contract } from '../portable/extensions/uclaw-wallet/contract.js';
import { prepareWallet } from '../portable/lib/prepare-wallet.mjs';
import { simplifyPortableConfig } from '../portable/lib/merge-config.mjs';
import { createFileWalletStore, getStatus } from '../portable/lib/wallet-client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const officialManifestModule = process.env.OPENCLAW_MANIFEST_MODULE || join(root,
  '.download-cache/smoke-windows/app/core/node_modules/openclaw/dist/manifest-BXjFCp0F.mjs');
const officialRegistryModule = join(dirname(officialManifestModule), 'registry-854ZO8XT.mjs');
test('真实 OpenClaw 2026.10.2 manifest parser 接受钱包 dist 资产并拒绝旧根目录布局',
  { skip: !existsSync(officialManifestModule) && 'official runtime is not installed in this source checkout' }, async () => {
    const { r: loadPluginManifest } = await import(pathToFileURL(officialManifestModule).href);
    const source = join(root, 'portable/extensions/uclaw-wallet');
    const result = loadPluginManifest(source);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.manifest.controlUi.entry, 'dist/control-ui/browser.js');
    assert.deepEqual(result.manifest.controlUi.styles, ['dist/control-ui/browser.css']);
    for (const asset of [result.manifest.controlUi.entry, ...result.manifest.controlUi.styles]) {
      assert.ok(existsSync(join(source, asset)), 'shipped asset missing: ' + asset);
    }
    const temp = mkdtempSync(join(tmpdir(), 'uclaw-wallet-manifest-'));
    try {
      copyDirSync(source, temp);
      const manifestPath = join(temp, 'openclaw.plugin.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.controlUi.entry = 'browser.js';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.match(loadPluginManifest(temp).error, /dedicated dist subdirectory/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

test('真实 SDK 与 registry 接受完整第三方钱包注册，拒绝 bundled 专用 route placement',
  { skip: !existsSync(officialRegistryModule) && 'official runtime is not installed in this source checkout' }, async () => {
    const { t: createPluginRegistry } = await import(pathToFileURL(officialRegistryModule).href);
    const pluginRoot = join(root, 'portable/extensions/uclaw-wallet');
    const record = { id: 'uclaw-wallet', name: 'Wallet', source: join(pluginRoot, 'index.js'), rootDir: pluginRoot,
      origin: 'config', uiCapabilities: ['page', 'navigation', 'accessory'] };
    let source = readFileSync(record.source, 'utf8');
    // 只重写测试加载路径，让工作区同一源码使用安装于隔离stage的真实SDK。
    for (const [specifier, target] of [
      ['openclaw/plugin-sdk/feature-plugin', join(dirname(officialRegistryModule), 'plugin-sdk/feature-plugin.js')],
      ['./contract.js', join(pluginRoot, 'contract.js')], ['./runtime.js', join(pluginRoot, 'runtime.js')],
    ]) {
      const from = "'" + specifier + "'";
      assert.equal(source.split(from).length - 1, 1);
      source = source.replace(from, () => JSON.stringify(pathToFileURL(target).href));
    }
    const plugin = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
    const noop = () => {};
    const params = { runtime: { config: { current: () => ({}) } }, logger: { info: noop, warn: noop, error: noop, debug: noop },
      coreGatewayMethodNames: [], activateGlobalSideEffects: false, allowProcessHomeSessionCatalogs: false };
    const builder = createPluginRegistry(params);
    const api = builder.createApi(record, { config: {}, pluginConfig: { portableRoot: join(root, 'portable'), stateDir: 'isolated-not-read-or-created' } });
    plugin.register(api);
    assert.deepEqual(builder.registry.diagnostics, []);
    assert.equal(builder.registry.controlUiDescriptors.length, 1);
    const registration = builder.registry.controlUiDescriptors[0];
    assert.equal(registration.pluginId, 'uclaw-wallet');
    assert.equal(registration.descriptor.id, 'wallet');
    assert.equal(registration.descriptor.placement, undefined);
    const rejected = createPluginRegistry(params);
    rejected.registerControlUiDescriptor(record, { ...registration.descriptor, placement: 'route:uclaw-wallet' });
    assert.equal(rejected.registry.controlUiDescriptors.length, 0);
    assert.match(rejected.registry.diagnostics[0].message, /must be owned by its bundled plugin/);
  });

test('两份后备配置页的全部内联脚本可编译，钱包操作定义没有重复', () => {
  for (const page of ['portable/Config.html', 'portable/config-server/public/index.html']) {
    const html = readFileSync(join(root, page), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length);
    for (const [i, match] of scripts.entries()) new Script(match[1], { filename: page + '#script' + i });
    for (const action of ['walletRefreshBalance', 'walletRecharge', 'walletCopyKey', 'walletResetLocal']) {
      assert.equal((html.match(new RegExp('function ' + action + '\\(', 'g')) || []).length, 1, page + ': ' + action);
    }
    assert.match(html.trimEnd(), /<\/html>$/);
    assert.match(html, /data\.remainingUsd/);
    assert.match(html, /data\.usedUsd/);
  }
});

test('原生钱包注册page/navigation/accessory，注册时不领取或充值', () => {
  const registered = [], disposed = [];
  let requests = 0;
  const host = { request() { requests++; }, ui: Object.fromEntries(['registerPage', 'registerNavigation', 'registerAccessory'].map((name) => [name, (definition) => { registered.push([name, definition]); return () => disposed.push(name); }])) };
  const dispose = browserPlugin.activate(host);
  assert.equal(registered.length, 3);
  assert.equal(registered[0][1].id, 'wallet');
  assert.equal(requests, 0);
  dispose();
  assert.equal(disposed.length, 3);
});

test('原生后端复用现有核心，状态只出掩码，复制和充值必须显式调用', async () => {
  const calls = [];
  const key = 'sk-test-only-wallet-key';
  const wallet = {
    createFileWalletStore: (path) => ({ path }),
    getStatus: async (deps) => { calls.push(['status', deps]); return { ok: true, hasWallet: true, apiKey: key }; },
    payBaseUrl: () => 'https://wallet.example.test',
    claimWallet: async (deps) => { calls.push(['claim', deps]); return { ok: true }; },
    adoptWallet: async (key, deps) => { calls.push(['adopt', key, deps]); return { ok: true }; },
    rotateWallet: async () => { calls.push(['rotate']); return { ok: true }; },
    resetLocalWallet: async () => { calls.push(['reset']); return { ok: true }; },
  };
  const handlers = createWalletHandlers({ portableRoot: 'C:/isolated', stateDir: 'C:/isolated/state' }, wallet);
  assert.equal(calls.length, 0);
  const status = await handlers.status({});
  assert.ok(!JSON.stringify(status).includes(key));
  assert.equal(status.hasWallet, true);
  assert.equal((await handlers['copy-key']({})).key, key);
  assert.equal((await handlers.recharge({})).url, 'https://wallet.example.test/recharge?key=' + encodeURIComponent(key));
  assert.equal((await handlers.rotate({ confirmed: false })).ok, false);
  assert.equal((await handlers.reset({ confirmed: false })).ok, false);
  assert.ok(!calls.some(([name]) => name === 'rotate' || name === 'reset'));
  await handlers.adopt({ key: 'sk-input-test' });
  assert.equal(calls.at(-1)[0], 'adopt');
  assert.ok(calls.at(-1)[2].configPath.endsWith('openclaw.json'));
  assert.equal(contract.operations.status.kind, 'query');
  assert.equal(contract.operations.claim.kind, 'action');
  assert.equal(contract.operations.recharge.kind, 'action');
  assert.equal(contract.operations['copy-key'].kind, 'action');
  assert.equal(contract.operations.rotate.input.properties.confirmed.const, true);
});

test('启动迁移更新可移动路径、保留钱包与非模型字段、先备份配置再收敛', () => {
  const temp = mkdtempSync(join(tmpdir(), 'uclaw-wallet-native-'));
  try {
    const portable = join(temp, 'portable'), stateDir = join(temp, 'state');
    mkdirSync(join(portable, 'extensions'), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    copyDirSync(join(root, 'portable/extensions/uclaw-wallet'), join(portable, 'extensions/uclaw-wallet'));
    const old = { gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } }, channels: { telegram: { enabled: true } },
      plugins: { entries: { telegram: { enabled: true } }, load: { paths: ['E:/old/wallet'] } },
      models: { providers: { old: { apiKey: 'test-only-old' }, 'uclaw-cloud': { apiKey: 'test-only-cloud' } } },
      agents: { defaults: { workspace: 'keep-workspace' } }, custom: { keep: true } };
    const configPath = join(stateDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify(old));
    writeFileSync(join(stateDir, 'uclaw-device.json'), '{"apiKey":"test-only-wallet"}');
    const result = prepareWallet(portable, stateDir);
    const next = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(JSON.parse(readFileSync(configPath + '.bak', 'utf8')), old);
    assert.equal(next.channels, undefined);
    // v2.3.2：启动迁移只收敛虾盘云这条 provider，用户自接的第三方 provider 保留。
    assert.deepEqual(Object.keys(next.models.providers).sort(), ['old', 'uclaw-cloud']);
    assert.deepEqual(next.models.providers['uclaw-cloud'].models.map((m) => m.id), ['deepseek-v4-flash']);
    assert.equal(next.models.providers['uclaw-cloud'].apiKey, 'test-only-cloud');
    assert.equal(next.agents.defaults.workspace, 'keep-workspace');
    assert.deepEqual(next.custom, { keep: true });
    assert.equal(next.gateway.controlUi.experimental.customPlugins, true);
    assert.deepEqual(next.plugins.allow, ['uclaw-wallet']);
    assert.deepEqual(next.plugins.load.paths, [result.pluginDir]);
    assert.ok(readFileSync(join(result.pluginDir, 'index.js'), 'utf8').includes('defineFeaturePlugin'));
    assert.equal(readFileSync(join(stateDir, 'uclaw-device.json'), 'utf8'), '{"apiKey":"test-only-wallet"}');
    assert.deepEqual(simplifyPortableConfig(next), next, 'model/channel policy should be idempotent');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('启动迁移接受 BOM，坏 JSON 在复制插件或写文件前拒绝', () => {
  const temp = mkdtempSync(join(tmpdir(), 'uclaw-wallet-strict-config-'));
  try {
    const portable = join(temp, 'portable'), stateDir = join(temp, 'state');
    mkdirSync(join(portable, 'extensions'), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    copyDirSync(join(root, 'portable/extensions/uclaw-wallet'), join(portable, 'extensions/uclaw-wallet'));
    const configPath = join(stateDir, 'openclaw.json');
    const raw = '\uFEFF' + JSON.stringify({ models: { providers: { 'uclaw-cloud': { apiKey: 'sk-test-only-bom-key' } } }, custom: { keep: true } });
    writeFileSync(configPath, raw);
    prepareWallet(portable, stateDir);
    assert.equal(readFileSync(configPath + '.bak', 'utf8'), raw);
    const next = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(next.models.providers['uclaw-cloud'].apiKey, 'sk-test-only-bom-key');
    assert.deepEqual(next.custom, { keep: true });
    rmSync(join(portable, 'app'), { recursive: true });
    rmSync(configPath + '.bak');
    for (const invalid of ['{broken json', '[]', 'null', '"a string"']) {
      writeFileSync(configPath, invalid);
      assert.throws(() => prepareWallet(portable, stateDir), /config is invalid/);
      assert.equal(readFileSync(configPath, 'utf8'), invalid);
      assert.equal(existsSync(configPath + '.bak'), false);
      assert.equal(existsSync(join(portable, 'app')), false);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('已有本地钱包在空配置或首次种子配置中恢复唯一模型，原文件只备份一次', async () => {
  for (const old of [null, {}]) {
    const temp = mkdtempSync(join(tmpdir(), 'uclaw-wallet-consumer-recovery-'));
    try {
      const portable = join(temp, 'portable'), stateDir = join(temp, 'state');
      mkdirSync(join(portable, 'extensions'), { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      copyDirSync(join(root, 'portable/extensions/uclaw-wallet'), join(portable, 'extensions/uclaw-wallet'));
      copyFileSync(join(root, 'portable/default-config.json'), join(portable, 'default-config.json'));
      const configPath = join(stateDir, 'openclaw.json'), walletPath = join(stateDir, 'uclaw-device.json');
      if (old) writeFileSync(configPath, JSON.stringify(old));
      const walletRaw = '\uFEFF' + JSON.stringify({ apiKey: 'sk-test-only-consumer-restore', walletId: 'same-wallet' });
      writeFileSync(walletPath, walletRaw);
      prepareWallet(portable, stateDir);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.deepEqual(Object.keys(config.models.providers), ['uclaw-cloud']);
      assert.equal(config.models.providers['uclaw-cloud'].apiKey, 'sk-test-only-consumer-restore');
      assert.equal(config.agents.defaults.model.primary, 'uclaw-cloud/deepseek-v4-flash');
      assert.equal(readFileSync(walletPath, 'utf8'), walletRaw);
      assert.equal((await getStatus({ store: createFileWalletStore(walletPath), configPath })).hasWallet, true);
      if (old) assert.equal(readFileSync(configPath + '.bak', 'utf8'), '{}');
      else assert.equal(existsSync(configPath + '.bak'), false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
});
