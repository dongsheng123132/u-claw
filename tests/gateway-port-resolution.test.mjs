import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPort } from '../portable/lib/runtime-ports.mjs';

// gatewayPortFromRuntime() (config-server/server.js) is the v2.2.1 fix for the "填了
// DeepSeek Key 还是没法用" bug: it used to GUESS the gateway port as configServerPort + 1,
// which silently pointed secrets-reload at the wrong process whenever the customer's
// machine had a real port conflict. These tests hit the real server (same isolation
// pattern as tests/wechat-login-redirect.test.mjs's 503 test) and assert the 3-level
// fallback chain through the actual /api/runtime endpoint, never a mock.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverJs = join(repoRoot, 'portable', 'config-server', 'server.js');

// 独立端口段：避开真机可能占用的 18778-18798 产品段，和 wechat-login-redirect.test.mjs
// 用的 18901 也分开，避免并行跑测试时撞车。
let nextTestPort = 18910;

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

function fixtureStateDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateDir = join(root, 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

test('gatewayPortFromRuntime reads runtime.json gatewayPort first (level 1, the fix)', async () => {
  const stateDir = fixtureStateDir('uclaw-gwport-l1-');
  try {
    publishPort(stateDir, 'gateway', 18790); // simulates the launcher publishing after a fallback
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/runtime`);
      const body = await res.json();
      assert.equal(body.gatewayPort, 18790, 'must report the real published port, not a guess');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('gatewayPortFromRuntime never falls back to configServerPort + 1 (v2.2.0 bug)', async () => {
  const stateDir = fixtureStateDir('uclaw-gwport-noguess-');
  try {
    // Only configServerPort is known (as if only the old guess-based logic ever ran).
    // gatewayPort was never published -- e.g. the launcher hasn't gotten that far yet,
    // or a foreign writer only touched configServerPort.
    publishPort(stateDir, 'configServer', 18788);
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/runtime`);
      const body = await res.json();
      assert.notEqual(body.gatewayPort, 18789, 'must not guess configServerPort + 1');
      assert.equal(body.gatewayPort, null, 'with no gatewayPort and no owner.json, must return null');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('gatewayPortFromRuntime falls back to launcher-instance.lock/owner.json (level 2)', async () => {
  const stateDir = fixtureStateDir('uclaw-gwport-l2-');
  try {
    // No runtime.json at all -- only the launcher's owner.json exists (second-hand evidence).
    const lockDir = join(stateDir, 'launcher-instance.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 12345, stateDir, port: 18793, startedAt: new Date().toISOString() }),
    );
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/runtime`);
      const body = await res.json();
      assert.equal(body.gatewayPort, 18793, 'must fall back to owner.json port when runtime.json has none');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('gatewayPortFromRuntime prefers runtime.json over owner.json when both exist', async () => {
  const stateDir = fixtureStateDir('uclaw-gwport-priority-');
  try {
    publishPort(stateDir, 'gateway', 18790);
    const lockDir = join(stateDir, 'launcher-instance.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 12345, stateDir, port: 18799, startedAt: new Date().toISOString() }),
    );
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/runtime`);
      const body = await res.json();
      assert.equal(body.gatewayPort, 18790, 'runtime.json (level 1) must win over owner.json (level 2)');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('gatewayPortFromRuntime returns null when nothing is published (level 3, no guessing)', async () => {
  const stateDir = fixtureStateDir('uclaw-gwport-l3-');
  try {
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/runtime`);
      const body = await res.json();
      assert.equal(body.gatewayPort, null, 'no runtime.json, no owner.json -> null, not a guess');
      assert.equal(body.configServerPort, testPort, 'configServerPort should still reflect the real bound port');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('gatewayPortFromRuntime ignores a corrupt runtime.json and still falls back to owner.json', async () => {
  const stateDir = fixtureStateDir('uclaw-gwport-corrupt-');
  try {
    writeFileSync(join(stateDir, 'runtime.json'), '{ not json at all');
    const lockDir = join(stateDir, 'launcher-instance.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 1, stateDir, port: 18795, startedAt: new Date().toISOString() }),
    );
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/runtime`);
      const body = await res.json();
      assert.equal(body.gatewayPort, 18795, 'corrupt runtime.json must not crash resolution, falls to level 2');
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// /api/gateway-check backs the front-end's identity-verified confirmation step
// (config-server/public/index.html isOurGateway()) -- it must never claim a port is "ours"
// just because *something* answered; a squatter that isn't our gateway must read as false.
test('/api/gateway-check returns ok:false for a port nothing is listening on', async () => {
  const stateDir = fixtureStateDir('uclaw-gwcheck-nothing-');
  try {
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/gateway-check?port=18989`);
      const body = await res.json();
      assert.equal(body.ok, false);
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('/api/gateway-check returns ok:false for a squatter that answers but is not our gateway', async () => {
  const stateDir = fixtureStateDir('uclaw-gwcheck-squat-');
  const { createServer } = await import('node:http');
  const squatter = createServer((req, res) => { res.writeHead(200); res.end('not openclaw'); });
  await new Promise((resolve) => squatter.listen(18990, '127.0.0.1', resolve));
  try {
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/gateway-check?port=18990`);
      const body = await res.json();
      assert.equal(body.ok, false, 'a listener that is not our /ready must not be trusted (v2.2.0 blind-scan bug)');
    });
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('/api/gateway-check rejects a bad port parameter instead of throwing', async () => {
  const stateDir = fixtureStateDir('uclaw-gwcheck-badport-');
  try {
    await withServer(stateDir, async (testPort) => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/gateway-check?port=not-a-number`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});


test('startup documents accept launcher query strings', async () => {
  const stateDir = fixtureStateDir('uclaw-startup-route-');
  try {
    await withServer(stateDir, async port => {
      for (const route of ['/startup?port=18789&configured=0', '/?gatewayPort=18789']) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
      }
    });
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('gateway-check distinguishes an identifiable gateway from a ready gateway', async () => {
  const stateDir = fixtureStateDir('uclaw-ready-');
  const { createServer } = await import('node:http');
  let status = 200, body;
  const fixture = createServer((req, res) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  try {
    await withServer(stateDir, async port => {
      for (const [responseStatus, ready, failing, expected] of [
        [200, false, [], false], [200, true, ['initializing'], false],
        [503, true, [], false], [200, true, [], true],
      ]) {
        status = responseStatus; body = {ready, failing, uptimeMs:1234, eventLoop:{degraded:false}};
        const response = await fetch(`http://127.0.0.1:${port}/api/gateway-check?port=${fixture.address().port}`);
        assert.equal((await response.json()).ready, expected);
      }
    });
  } finally {
    await new Promise(resolve => fixture.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
