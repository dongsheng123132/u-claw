import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServerSandbox, withSandboxServer } from './helpers/config-server-sandbox.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyKey, CLOUD_PROVIDER_ID, DEFAULT_MODEL_ID } from '../portable/lib/wallet-client.mjs';

// 回归：领取虾盘云钱包后，再到配置中心保存别家模型（如 DeepSeek），uclaw-cloud 不能消失。
//
// 钱包 applyKey() 把明文 apiKey 的 uclaw-cloud provider 写进 openclaw.json；配置中心
// buildConfig() + saveConfig() 却只 POST 选中的那一个 provider，而 merge-config.mjs 对 models
// 是整体替换——旧行为下 providers 从 ['uclaw-cloud'] 变成 ['deepseek-api']，已付费额度从配置里
// 不可达。修法是 server.js 的 POST /api/config 传 keepProviders: [CLOUD_PROVIDER_ID]。
// 这里打真实的 config-server（隔离状态目录 + 专用端口），不 mock 合并逻辑。
//
// deepseek 的 apiKey 直接给 SecretRef 对象：server.js 对 SecretRef 原样放行，保存不依赖
// OpenClaw secrets CLI（运行时不在仓库里，CI 上没有）。

const WALLET_KEY = 'sk-wallet-original-0123456789';
const DEEPSEEK_REF = { source: 'store', provider: 'default', id: 'UCLAW_MODEL_deepseek' };
const CLOUD_NEW_REF = { source: 'store', provider: 'default', id: 'UCLAW_MODEL_UCLAW_CLOUD' };

// 镜像 config-server/public/index.html 的 buildConfig('deepseek', base, model, apiKey)
// + buildModelDefinition()：配置中心提交的就是这个形状（只带选中的 provider）。
function buildConfigCenterBody(apiKey) {
  const model = 'deepseek-v4-flash';
  return {
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' }, remote: { token: 'uclaw' } },
    commands: { native: 'auto', nativeSkills: 'auto', restart: true },
    models: {
      mode: 'merge',
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey,
          api: 'openai-completions',
          models: [{
            id: model,
            name: model,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          }],
        },
      },
    },
    agents: { defaults: { model: { primary: 'deepseek/' + model } } },
  };
}

async function postConfig(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// 用钱包自己的写入方 applyKey() 造种子：领取成功后的真实形状（含主模型 uclaw-cloud/...）。
function seedWalletConfig(dir) {
  const configPath = join(dir, 'openclaw.json');
  writeFileSync(configPath, JSON.stringify({
    gateway: { mode: 'local', auth: { mode: 'token', token: 'uclaw' } },
    plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
  }));
  applyKey(configPath, WALLET_KEY);
  const seeded = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(seeded.models.providers[CLOUD_PROVIDER_ID].apiKey, WALLET_KEY, '种子必须带钱包明文 key');
  assert.equal(seeded.agents.defaults.model.primary, `${CLOUD_PROVIDER_ID}/${DEFAULT_MODEL_ID}`);
  return { configPath, seeded };
}

// server 的官方 provider 守卫可能把 deepseek 改名成 deepseek-api（取决于 app/core 里有没有
// 对应插件），所以按磁盘上实际存在的那个 id 断言，不写死改名结果。
function findDeepseekId(providers) {
  return ['deepseek', 'deepseek-api'].find((id) => Object.prototype.hasOwnProperty.call(providers, id));
}

test('钱包领取后在配置中心保存 DeepSeek：uclaw-cloud 仍在，原 key 不变，DeepSeek 与主模型生效', async () => {
  const fixture = createServerSandbox();
  const dir = fixture.stateDir;
  try {
    const { configPath, seeded } = seedWalletConfig(dir);
    await withSandboxServer(fixture, async (port) => {
      const res = await postConfig(port, buildConfigCenterBody(DEEPSEEK_REF));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true, JSON.stringify(res.body));

      const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
      const providers = onDisk.models.providers;

      assert.deepEqual(
        providers[CLOUD_PROVIDER_ID],
        seeded.models.providers[CLOUD_PROVIDER_ID],
        '钱包写的 uclaw-cloud 必须原样保留（含原 apiKey）——旧行为下它在这里消失'
      );
      assert.equal(providers[CLOUD_PROVIDER_ID].apiKey, WALLET_KEY);

      const deepseekId = findDeepseekId(providers);
      assert.ok(deepseekId, `磁盘上应有 deepseek 或 deepseek-api，实际 providers: ${Object.keys(providers).join(',')}`);
      assert.deepEqual(providers[deepseekId].apiKey, DEEPSEEK_REF);
      assert.deepEqual(Object.keys(providers).sort(), [deepseekId, CLOUD_PROVIDER_ID].sort(), '不应多出别的 provider');

      assert.equal(
        onDisk.agents.defaults.model.primary,
        `${deepseekId}/deepseek-v4-flash`,
        '主模型以配置中心本次选择为准，不被 keep 逻辑改回 uclaw-cloud'
      );
      assert.deepEqual(onDisk.plugins, seeded.plugins, '无关字段照常保留');
    });
  } finally {
    fixture.cleanup();
  }
});

test('请求自己点名 uclaw-cloud（换了 SecretRef）时以请求为准，不被磁盘旧条目覆盖', async () => {
  const fixture = createServerSandbox();
  const dir = fixture.stateDir;
  try {
    const { configPath } = seedWalletConfig(dir);
    await withSandboxServer(fixture, async (port) => {
      const body = buildConfigCenterBody(DEEPSEEK_REF);
      body.models.providers[CLOUD_PROVIDER_ID] = {
        baseUrl: 'https://api.u-claw.org/v1',
        apiKey: CLOUD_NEW_REF,
        api: 'openai-completions',
        models: [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_ID }],
      };
      const res = await postConfig(port, body);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true, JSON.stringify(res.body));

      const providers = JSON.parse(readFileSync(configPath, 'utf8')).models.providers;
      assert.deepEqual(providers[CLOUD_PROVIDER_ID].apiKey, CLOUD_NEW_REF, '请求里的新 key 必须胜出');
      assert.notEqual(providers[CLOUD_PROVIDER_ID].apiKey, WALLET_KEY);
      assert.ok(findDeepseekId(providers), 'deepseek 也要在');
    });
  } finally {
    fixture.cleanup();
  }
});

test('真实服务保存：高级 agents/gateway/commands/channels/plugins/cron/browser 保留，primary 更新且钱包仍在，输入不被改动', async () => {
  const fixture = createServerSandbox();
  const dir = fixture.stateDir;
  try {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        mode: 'local',
        auth: { mode: 'token', token: 'uclaw', advancedAuthFlag: 'keep-me' },
        remote: { token: 'uclaw', remoteKeep: 42 },
        customGatewayKey: 'keep-me-too',
      },
      commands: { native: 'auto', nativeSkills: 'auto', restart: true, myCustomCommand: { id: 'x' } },
      meta: { ui: { theme: 'dark' } },
      env: { MY_ENV: 'keep' },
      plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
      channels: { telegram: { enabled: true } },
      cron: { jobs: [{ id: 'j1' }] },
      browser: { profiles: { openclaw: { userDataDir: 'D:/keep' } } },
    }));
    applyKey(configPath, WALLET_KEY); // 钱包领取后的形状
    // 再叠加原生高级 Agent 设置（模拟用户用过 openclaw configure 等原生入口）
    const seeded = JSON.parse(readFileSync(configPath, 'utf8'));
    seeded.agents.list = [{ id: 'agent-a', name: 'A' }];
    seeded.agents.defaults.workspace = { cwd: '/keep/workspace' };
    seeded.agents.defaults.tools = { allow: ['read', 'write'] };
    seeded.agents.defaults.model.fallbacks = [`${CLOUD_PROVIDER_ID}/other`];
    writeFileSync(configPath, JSON.stringify(seeded));
    const before = JSON.parse(readFileSync(configPath, 'utf8'));

    const body = buildConfigCenterBody(DEEPSEEK_REF);
    const bodySnapshot = JSON.parse(JSON.stringify(body));
    await withSandboxServer(fixture, async (port) => {
      const res = await postConfig(port, body);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true, JSON.stringify(res.body));
    });
    assert.deepEqual(body, bodySnapshot, '请求对象不得被改动');

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    const deepseekId = findDeepseekId(onDisk.models.providers);
    assert.ok(deepseekId, `providers: ${Object.keys(onDisk.models.providers).join(',')}`);
    assert.equal(onDisk.agents.defaults.model.primary, `${deepseekId}/deepseek-v4-flash`, '主模型生效（含守卫改名）');
    assert.deepEqual(onDisk.agents.defaults.model.fallbacks, before.agents.defaults.model.fallbacks);
    assert.deepEqual(onDisk.agents.list, before.agents.list);
    assert.deepEqual(onDisk.agents.defaults.workspace, before.agents.defaults.workspace);
    assert.deepEqual(onDisk.agents.defaults.tools, before.agents.defaults.tools);

    assert.equal(onDisk.gateway.auth.advancedAuthFlag, 'keep-me');
    assert.equal(onDisk.gateway.remote.remoteKeep, 42);
    assert.equal(onDisk.gateway.customGatewayKey, 'keep-me-too');
    assert.deepEqual(onDisk.commands.myCustomCommand, { id: 'x' });
    assert.deepEqual(onDisk.meta, before.meta);
    assert.deepEqual(onDisk.env, before.env);
    assert.deepEqual(onDisk.plugins, before.plugins);
    assert.deepEqual(onDisk.channels, before.channels);
    assert.deepEqual(onDisk.cron, before.cron);
    assert.deepEqual(onDisk.browser, before.browser);

    const providers = onDisk.models.providers;
    assert.equal(providers[CLOUD_PROVIDER_ID].apiKey, WALLET_KEY, '钱包仍在且原 key 不变');
    assert.deepEqual(Object.keys(providers).sort(), [deepseekId, CLOUD_PROVIDER_ID].sort());
  } finally {
    fixture.cleanup();
  }
});
