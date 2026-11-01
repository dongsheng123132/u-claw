import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Path traversal regression: GET /../../data/.openclaw/openclaw.json used to be served
// by `path.join(__dirname, 'public', req.url)` with no boundary check, leaking the
// customer's model API keys. These tests hit the real config-server.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverJs = join(repoRoot, 'portable', 'config-server', 'server.js');
const publicRoot = join(repoRoot, 'portable', 'config-server', 'public');

// 独立端口段：避开产品段 18778-18798 与其它测试用的 18901/18910。
let nextTestPort = 18920;

async function withServer(stateDir, fn) {
  const TEST_PORT = nextTestPort++;
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: stateDir, UCLAW_CONFIG_PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      if (stdout.includes(`http://127.0.0.1:${TEST_PORT}`)) ready = true;
      else await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, `config-server did not report port ${TEST_PORT}; stdout:\n${stdout}`);
    await fn(TEST_PORT);
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

function fixtureWithSecretConfig() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-traversal-'));
  const stateDir = join(root, 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  // Simulates data/.openclaw/openclaw.json sitting next to config-server/, with a live key.
  const secretPath = join(root, 'data', '.openclaw', 'openclaw.json');
  writeFileSync(secretPath, JSON.stringify({
    models: { providers: { evil: { apiKey: 'sk-LEAK-ME-DO-NOT-SERVE' } } },
  }), 'utf8');
  return { root, stateDir, secretPath };
}

test('traversal to openclaw.json is rejected (API key must never be served)', async () => {
  const { root, stateDir, secretPath } = fixtureWithSecretConfig();
  try {
    assert.ok(existsSync(secretPath), 'fixture secret must exist so a real leak would be visible');
    await withServer(stateDir, async (testPort) => {
      for (const attack of [
        '/../../data/.openclaw/openclaw.json',
        '/../data/.openclaw/openclaw.json',
        '/..%2f..%2fdata/.openclaw/openclaw.json',
        '/%2e%2e/%2e%2e/data/.openclaw/openclaw.json',
        '/....//....//data/.openclaw/openclaw.json',
      ]) {
        const res = await fetch(`http://127.0.0.1:${testPort}${attack}`);
        const body = await res.text();
        assert.equal(res.status, 404, `${attack} must 404, got ${res.status}`);
        assert.ok(!body.includes('sk-LEAK-ME-DO-NOT-SERVE'), `${attack} leaked the API key`);
        assert.ok(!body.includes('apiKey'), `${attack} leaked provider config fields`);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legitimate static files under public/ still serve', async () => {
  const { root, stateDir } = fixtureWithSecretConfig();
  try {
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/index.html`);
      assert.equal(res.status, 200, 'index.html must still be served');
      const body = await res.text();
      assert.ok(body.length > 0, 'index.html must not be empty');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source pins the public-root boundary check', () => {
  const server = readFileSync(serverJs, 'utf8');
  assert.match(server, /path\.resolve\(__dirname,\s*'public'\)/, 'must resolve the public root');
  assert.match(server, /withinPublic/, 'must gate serving on a within-public check');
  assert.doesNotMatch(server, /path\.join\(__dirname,\s*'public',\s*req\.url\)/,
    'the unbounded path.join(__dirname, public, req.url) must be gone');
});
