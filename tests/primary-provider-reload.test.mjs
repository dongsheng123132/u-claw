import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

// Issue #69: when the saved config has several providers (e.g. the wallet code adds
// `uclaw-cloud` next to the user's own provider), the Config UIs used to take
// Object.keys(providers)[0] as the provider but the model ID from
// agents.defaults.model.primary ("<providerName>/<modelId>"). The two could disagree, so the
// form showed one provider + key with another provider's model, and saving wrote a
// mismatched primary. loadConfig must pick the provider named by primary instead.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const targets = [
  ['index.html', join(repoRoot, 'portable', 'config-server', 'public', 'index.html')],
  ['Config.html', join(repoRoot, 'portable', 'Config.html')],
];

// Returns the source text of `function <name>(` / `async function <name>(` including its
// body, found by brace matching (string, template and comment aware). Fails loudly if the
// function is missing or the braces never balance.
function extractFunction(source, name) {
  const re = new RegExp('(?:\\basync\\s+)?\\bfunction\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  assert.ok(m, `function ${name} not found`);
  const start = m.index;
  let i = source.indexOf('{', m.index + m[0].length);
  assert.ok(i >= 0, `function ${name} has no body`);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      assert.ok(end >= 0, `unterminated block comment inside ${name}`);
      i = end + 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < source.length && source[i] !== ch; i++) {
        if (source[i] === '\\') i++;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces while extracting ${name}`);
}

// Objects created inside a vm context have a different Object.prototype, so deepEqual
// would reject them; normalise through JSON first.
const plain = (x) => JSON.parse(JSON.stringify(x));

function hasFunction(source, name) {
  return new RegExp('\\bfunction\\s+' + name + '\\s*\\(').test(source);
}

// ---------------------------------------------------------------------------
// Part A: the pure helper, in both pages
// ---------------------------------------------------------------------------

for (const [label, path] of targets) {
  const source = readFileSync(path, 'utf8');

  // Extract lazily, inside each test: a missing helper then fails only the Part A tests
  // (loudly) instead of throwing at import time and hiding the Part B results.
  const pick = (cfg) => {
    const ctx = vm.createContext({});
    vm.runInContext(extractFunction(source, 'pickSavedProvider'), ctx);
    return plain(ctx.pickSavedProvider(cfg));
  };

  const cfgOf = (providerNames, primary) => {
    const providers = {};
    for (const n of providerNames) providers[n] = { baseUrl: `https://${n}.example/v1`, apiKey: `sk-${n}` };
    const cfg = { models: { providers } };
    if (primary !== undefined) cfg.agents = { defaults: { model: { primary } } };
    return cfg;
  };

  test(`${label}: pickSavedProvider follows primary when the wallet adds uclaw-cloud after the user's provider`, () => {
    assert.deepEqual(
      pick(cfgOf(['deepseek', 'uclaw-cloud'], 'uclaw-cloud/deepseek-v4-flash')),
      { providerName: 'uclaw-cloud', modelId: 'deepseek-v4-flash' },
    );
  });

  test(`${label}: pickSavedProvider follows primary for the issue #69 example (providerB/modelB)`, () => {
    assert.deepEqual(
      pick(cfgOf(['providerA', 'providerB'], 'providerB/modelB')),
      { providerName: 'providerB', modelId: 'modelB' },
    );
  });

  test(`${label}: pickSavedProvider keeps the only provider when it matches primary`, () => {
    assert.deepEqual(
      pick(cfgOf(['deepseek'], 'deepseek/deepseek-v4-flash')),
      { providerName: 'deepseek', modelId: 'deepseek-v4-flash' },
    );
  });

  test(`${label}: pickSavedProvider falls back to the first provider when primary points at a missing provider`, () => {
    assert.deepEqual(
      pick(cfgOf(['deepseek', 'kimi'], 'gone/m')),
      { providerName: 'deepseek', modelId: 'm' },
    );
  });

  test(`${label}: pickSavedProvider without agents/primary returns the first provider and an empty modelId`, () => {
    assert.deepEqual(
      pick(cfgOf(['deepseek', 'kimi'])),
      { providerName: 'deepseek', modelId: '' },
    );
    // agents present but no primary string
    const noPrimary = cfgOf(['deepseek', 'kimi']);
    noPrimary.agents = { defaults: { model: {} } };
    assert.deepEqual(pick(noPrimary), { providerName: 'deepseek', modelId: '' });
  });

  test(`${label}: pickSavedProvider splits primary at the first slash only (modelId may contain slashes)`, () => {
    assert.deepEqual(
      pick(cfgOf(['x', 'openrouter'], 'openrouter/meta-llama/llama-3')),
      { providerName: 'openrouter', modelId: 'meta-llama/llama-3' },
    );
  });

  test(`${label}: pickSavedProvider keeps the -api suffix of the provider name (mapping happens later)`, () => {
    assert.deepEqual(
      pick(cfgOf(['deepseek', 'zai-api'], 'zai-api/glm-5')),
      { providerName: 'zai-api', modelId: 'glm-5' },
    );
  });

  test(`${label}: pickSavedProvider returns null without providers`, () => {
    assert.equal(pick({}), null);
    assert.equal(pick({ models: {} }), null);
    assert.equal(pick({ models: { providers: {} } }), null);
    assert.equal(pick({ models: { providers: {} }, agents: { defaults: { model: { primary: 'a/b' } } } }), null);
    assert.equal(pick(undefined), null);
  });
}

test('pickSavedProvider source is identical in index.html and Config.html (drift guard)', () => {
  const texts = targets.map(([, path]) =>
    extractFunction(readFileSync(path, 'utf8'), 'pickSavedProvider').replace(/\r\n/g, '\n'),
  );
  assert.equal(texts[0], texts[1]);
});

// ---------------------------------------------------------------------------
// Part B: the real loadConfig of each page, run against fake DOM / fetch
// ---------------------------------------------------------------------------

async function runLoadConfig(source, cfg) {
  const fetched = [];
  const clicked = [];
  const filled = [];
  const sandbox = {
    selectedProvider: null,
    selectedBase: '',
    selectedModel: '',
    savedProviderId: null,
    savedProviderApiKey: null,
    fillApiKeyFromSaved(v) { filled.push(v); },
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, json: async () => cfg };
    },
  };
  // Like the page: clicking a card selects its catalog defaults.
  const makeCard = (provider, base, model) => ({
    dataset: { provider, base, model },
    click() {
      clicked.push(this);
      sandbox.selectedProvider = this.dataset.provider;
      sandbox.selectedBase = this.dataset.base;
      sandbox.selectedModel = this.dataset.model;
    },
  });
  const cards = [
    makeCard('deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-flash'),
    makeCard('uclaw-cloud', 'https://api.u-claw.org/v1', 'deepseek-v4-flash'),
  ];
  sandbox.document = {
    querySelectorAll: () => cards,
    querySelector: (selector) => {
      const m = /data-provider="([^"]*)"/.exec(selector);
      return (m && cards.find((c) => c.dataset.provider === m[1])) || null;
    },
  };

  // pickSavedProvider is optional here so this harness can also run against the
  // pre-fix pages (where only loadConfig exists) and observe the bug.
  const code = (hasFunction(source, 'pickSavedProvider') ? extractFunction(source, 'pickSavedProvider') + '\n' : '')
    + extractFunction(source, 'loadConfig');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  await sandbox.loadConfig();
  return { sandbox, fetched, clicked, filled, cards };
}

for (const [label, path] of targets) {
  const source = readFileSync(path, 'utf8');

  test(`${label}: loadConfig refills the provider named by primary, not the first provider (issue #69)`, async () => {
    const cfg = {
      models: {
        providers: {
          deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek' },
          'uclaw-cloud': { baseUrl: 'https://api.u-claw.org/v1', apiKey: 'sk-cloud' },
        },
      },
      agents: { defaults: { model: { primary: 'uclaw-cloud/deepseek-v4-flash' } } },
    };
    const { sandbox, fetched, clicked, filled, cards } = await runLoadConfig(source, cfg);

    assert.deepEqual(fetched, ['/api/config']);
    assert.deepEqual(clicked.map((c) => c.dataset.provider), ['uclaw-cloud'], 'only the uclaw-cloud card may be clicked');
    assert.equal(clicked[0], cards[1]);
    assert.equal(sandbox.savedProviderId, 'uclaw-cloud');
    assert.equal(sandbox.savedProviderApiKey, 'sk-cloud');
    assert.deepEqual(filled, ['sk-cloud']);
    assert.equal(sandbox.selectedBase, 'https://api.u-claw.org/v1');
    assert.equal(sandbox.selectedModel, 'deepseek-v4-flash');
  });

  test(`${label}: loadConfig still refills the single configured provider (normal path)`, async () => {
    const cfg = {
      models: {
        providers: {
          deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek' },
        },
      },
      agents: { defaults: { model: { primary: 'deepseek/deepseek-v4-flash' } } },
    };
    const { sandbox, fetched, clicked, filled, cards } = await runLoadConfig(source, cfg);

    assert.deepEqual(fetched, ['/api/config']);
    assert.deepEqual(clicked.map((c) => c.dataset.provider), ['deepseek']);
    assert.equal(clicked[0], cards[0]);
    assert.equal(sandbox.savedProviderId, 'deepseek');
    assert.equal(sandbox.savedProviderApiKey, 'sk-deepseek');
    assert.deepEqual(filled, ['sk-deepseek']);
    assert.equal(sandbox.selectedBase, 'https://api.deepseek.com/v1');
    assert.equal(sandbox.selectedModel, 'deepseek-v4-flash');
  });
}
