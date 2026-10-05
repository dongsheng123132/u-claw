import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const placeholder = '（已加密保存，无需重填）';
const targets = ['portable/config-server/public/index.html'];

function harness(file, nextProvider, nextBase, local = false) {
  const source = readFileSync(join(root, file), 'utf8');
  const input = { value: 'sk-original-provider-only' };
  const next = {};
  const card = {
    dataset: { provider: nextProvider, base: nextBase, model: 'new-model' },
    classList: { add() {}, remove() {} },
    querySelector() { return null; },
    addEventListener(type, handler) { if (type === 'click') this.click = handler; },
  };
  const saved = { source: 'store', provider: 'default', id: 'ORIGINAL_ONLY' };
  const ctx = vm.createContext({
    selectedProvider: 'uclaw-cloud', selectedBase: 'https://cloud.example/v1', selectedModel: 'old-model', selectedLocal: false,
    savedProviderApiKey: saved, savedProviderId: 'uclaw-cloud', SECRET_REF_INPUT_VALUE: placeholder,
    card, p: { id: nextProvider, provider: nextProvider, base: nextBase, models: ['new-model'] }, modelId: 'new-model',
    document: {
      querySelectorAll() { return [card]; },
      getElementById(id) { return id === 'apiKey' ? input : { ...next, addEventListener() {} }; },
    },
  });
  if (local) {
    const localSource = source.slice(source.indexOf('async function discoverLocalModels'));
    const match = localSource.match(/card\.addEventListener\('click', ([\s\S]*?)\);\s*grid\.appendChild\(card\)/);
    assert.ok(match, 'local card handler must be present');
    vm.runInContext(`globalThis.invoke = ${match[1]}`, ctx);
  } else {
    vm.runInContext(source.slice(source.indexOf('function selectCloudCard'), source.indexOf('async function loadCatalog')), ctx);
    ctx.invoke = () => ctx.selectCloudCard(card, ctx.p);
  }
  return { ctx, input, saved, click: () => ctx.invoke() };
}

for (const file of targets) {
  test(`${file}: switching providers clears the previous provider's key and saved reference`, () => {
    for (const value of ['sk-original-provider-only', placeholder]) {
      const h = harness(file, 'deepseek', 'https://deepseek.example/v1');
      h.input.value = value;
      h.click();
      assert.equal(h.input.value, '');
      assert.equal(h.ctx.savedProviderApiKey, null);
      assert.equal(h.ctx.savedProviderId, null);
      assert.equal(h.ctx.selectedProvider, 'deepseek');
    }
  });
  test(`${file}: changing only the model preserves an entered key`, () => {
    const h = harness(file, 'uclaw-cloud', 'https://cloud.example/v1');
    h.click();
    assert.equal(h.input.value, 'sk-original-provider-only');
    assert.equal(h.ctx.selectedModel, 'new-model');
  });
  test(`${file}: changing only the model preserves its saved SecretRef`, () => {
    const h = harness(file, 'uclaw-cloud', 'https://cloud.example/v1');
    h.input.value = placeholder;
    h.click();
    assert.equal(h.input.value, placeholder);
    assert.equal(h.ctx.savedProviderApiKey, h.saved);
    assert.equal(h.ctx.savedProviderId, 'uclaw-cloud');
  });
  test(`${file}: a different API address cannot inherit the previous key`, () => {
    const h = harness(file, 'uclaw-cloud', 'https://other.example/v1');
    h.click();
    assert.equal(h.input.value, '');
    assert.equal(h.ctx.savedProviderApiKey, null);
  });
  // config-server/public/index.html no longer has local-model cards; only the legacy
  // portable/Config.html still carries discoverLocalModels(), so only it is covered here.
  if (file === 'portable/Config.html') {
    test(`${file}: selecting a local model clears the cloud key`, () => {
      const h = harness(file, 'ollama', 'http://127.0.0.1:11434/v1', true);
      h.click();
      assert.equal(h.input.value, '');
      assert.equal(h.ctx.savedProviderApiKey, null);
      assert.equal(h.ctx.savedProviderId, null);
      assert.equal(h.ctx.selectedLocal, true);
    });
  }
}
