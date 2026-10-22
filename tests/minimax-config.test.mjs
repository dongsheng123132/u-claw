import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const source = read('portable/config-server/public/index.html');
const catalog = JSON.parse(read('portable/config-server/public/models-catalog.json'));
const models = ['MiniMax-M3.1-Flash', 'MiniMax-M3'];
const china = 'https://api.minimaxi.com/v1';
const global = 'https://api.minimax.io/v1';

function browser(saved = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', style: {}, disabled: false });
    return elements.get(id);
  };
  const requests = [];
  const context = vm.createContext({
    selectedProvider: null, selectedBase: '', selectedModel: '',
    savedProviderApiKey: null, savedProviderId: null, savedMiniMaxProvider: null,
    SECRET_REF_INPUT_VALUE: '(saved)', dynamicModels: {},
    escAttr: (value) => String(value), escHtml: (value) => String(value),
    showToast() {}, goStep() {},
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      querySelector: (selector) => {
        const id = selector.match(/data-provider="([^"]+)"/)?.[1];
        if (!id) return null;
        return { click() {
          context.selectedProvider = id;
          context.selectedBase = china;
          context.selectedModel = models[0];
        } };
      },
    },
    fetch: async (url, options) => {
      if (!options) return { json: async () => url === '/api/config' ? saved : {} };
      requests.push({ url, ...options, json: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, pendingRestart: true }) };
    },
  });
  for (const name of ['buildModelDefinition', 'buildConfig', 'refreshModelSelect', 'saveConfig',
    'isSecretRefValue', 'pickSavedProvider', 'fillApiKeyFromSaved', 'loadConfig']) {
    const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n}'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return { context, element, requests };
}

function options(html) {
  return [...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
}

test('direct catalog is Flash-first while the verified relay retains M3', () => {
  const direct = catalog.providers.find((p) => p.id === 'minimax');
  assert.equal(direct.recommended, models[0]);
  assert.equal(direct.base, china);
  assert.deepEqual(direct.models, models);
  assert.deepEqual(catalog.providers.find((p) => p.id === 'uclaw-cloud').models.filter((m) => /^MiniMax-/.test(m)), ['MiniMax-M3']);
});

test('live choices exclude obsolete MiniMax IDs and retain explicit saved selections', () => {
  const { context, element } = browser();
  context.selectedProvider = 'minimax';
  context.selectedModel = models[0];
  context.refreshModelSelect(['MiniMax-M2.7', 'MiniMax-Text-01', 'abab6.5s-chat', ...models, 'speech-02-hd']);
  assert.deepEqual(options(element('modelSelect').innerHTML), [...models, 'speech-02-hd']);
  context.selectedModel = 'MiniMax-M2.7';
  context.refreshModelSelect(models);
  assert.deepEqual(options(element('modelSelect').innerHTML), ['MiniMax-M2.7', ...models]);
  context.selectedProvider = 'uclaw-cloud';
  context.selectedModel = 'unrelated-model';
  context.refreshModelSelect(['unrelated-model', 'MiniMax-M2.7', ...models]);
  assert.deepEqual(options(element('modelSelect').innerHTML), ['unrelated-model', 'MiniMax-M3']);
  context.selectedProvider = 'custom';
  context.selectedModel = '';
  context.refreshModelSelect(['MiniMax-M2.7', 'speech-02-hd', 'custom-model']);
  assert.deepEqual(options(element('modelSelect').innerHTML), ['MiniMax-M2.7', 'speech-02-hd', 'custom-model']);
});

for (const model of models) {
  test(`saveConfig serializes the selected direct ${model} at its HTTP boundary`, async () => {
    const { context, element, requests } = browser();
    context.selectedProvider = 'minimax';
    context.selectedBase = china;
    context.selectedModel = model;
    element('apiKey').value = 'fixture-key';
    await context.saveConfig();
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.url, '/api/config');
    assert.equal(request.method, 'POST');
    const provider = request.json.models.providers.minimax;
    assert.equal(provider.baseUrl, china);
    assert.equal(provider.api, 'openai-completions');
    assert.equal(provider.models[0].id, model);
    assert.equal(provider.models[0].reasoning, true);
    assert.deepEqual(provider.models[0].input, ['text', 'image', 'video']);
    assert.equal(provider.models[0].contextWindow, 1000000);
    if (model === models[0]) assert.equal(provider.models[0].maxTokens, 524288);
    assert.equal(request.json.agents.defaults.model.primary, `minimax/${model}`);
    assert.doesNotMatch(request.body, /service_tier|reasoning_split|"thinking"|"reasoning_effort"/);
  });
}

for (const providerId of ['minimax', 'custom']) {
  for (const base of [china, global, 'https://saved.example/v1']) {
    for (const model of [...models, 'MiniMax-M2.7', 'MiniMax-custom']) {
      test(`saved ${providerId}/${model} at ${base} survives load and HTTP save`, async () => {
        const provider = {
          baseUrl: base, apiKey: { source: 'store', provider: 'fixture', id: 'saved' },
          api: 'openai-completions', headers: { 'X-Custom': 'fixture' },
          models: [{ id: model, reasoning: true, input: ['text', 'image', 'video'], maxTokens: 4321 },
            { id: 'speech-02-hd', input: ['audio'], maxTokens: 100 }],
        };
        const saved = { models: { providers: { [providerId]: provider } },
          agents: { defaults: { model: { primary: `${providerId}/${model}` } } } };
        const { context, requests } = browser(saved);
        await context.loadConfig();
        await context.saveConfig();
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].json.models.providers[providerId], provider);
        assert.equal(requests[0].json.agents.defaults.model.primary, `${providerId}/${model}`);
      });
    }
  }
}

for (const choice of ['', '2']) {
  test(`shell installer emits a valid ${choice === '2' ? 'M3' : 'default Flash'} config`, () => {
    const shell = read('install/install.sh');
    const selection = shell.slice(shell.indexOf('            5)\n'), shell.indexOf('            6)\n'));
    const definition = shell.slice(shell.indexOf('        MODEL_DEFINITION='), shell.indexOf('        # 写配置文件'));
    const template = shell.match(/cat > "\$CONFIG_PATH" << CFGEOF\n([^]*?)\nCFGEOF/)[1];
    const script = `MODEL_CHOICE=5\ncase 5 in\n${selection}\nesac\n${definition}\nAPI_KEY_JSON=fixture-key\ncat << CFGEOF\n${template}\nCFGEOF\n`;
    const run = spawnSync('bash', ['-c', script], { input: `${choice}\n`, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const config = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    const model = choice === '2' ? models[1] : models[0];
    assert.equal(config.agents.defaults.model.primary, `custom/${model}`);
    assert.equal(config.models.providers.custom.baseUrl, china);
    assert.equal(config.models.providers.custom.models[0].reasoning, true);
    assert.deepEqual(config.models.providers.custom.models[0].input, ['text', 'image', 'video']);
  });
}

test('PowerShell keeps the same Flash default and explicit M3 choice', () => {
  const shell = read('install/install.ps1');
  assert.match(shell, /"5"\s*= @\{ model="MiniMax-M3\.1-Flash"/);
  assert.match(shell, /\$minimaxModelChoice -eq "2"[^\n]+\.model = "MiniMax-M3"/);
  assert.match(shell, /"models": \[\$modelDefinitionJson\]/);
  assert.match(shell, /reasoning = \$true; input = @\("text", "image", "video"\)/);
});
