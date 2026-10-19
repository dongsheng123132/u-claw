import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSandbox, withSandboxServer, rawRequest } from './helpers/config-server-sandbox.mjs';

const retired = {
  available: false,
  supported: false,
  releasePageUrl: 'https://github.com/dongsheng123132/u-claw/releases',
};

test('更新兼容接口固定返回退役状态，不读 stale 清单、不导入检查器、不联网', async (t) => {
  const fixture = createServerSandbox();
  try {
    const stalePath = join(fixture.stateDir, 'update-available.json');
    const stale = JSON.stringify({ available: true, remoteVersion: '9999.1.1', downloadUrl: 'https://invalid.example/stale.zip' });
    writeFileSync(stalePath, stale);
    // 即使旧实现尝试导入检查器，也只碰沙箱并立即失败，绝不会触及 OSS。
    writeFileSync(join(fixture.libDir, 'check-update.mjs'), 'throw new Error("retired checker must not be imported");');
    const preload = join(fixture.root, 'deny-update-io.cjs');
    writeFileSync(preload, `const fs = require('node:fs');
const originalRead = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file).endsWith('update-available.json')) throw new Error('stale manifest read forbidden');
  return originalRead.call(this, file, ...args);
};
globalThis.fetch = async () => { throw new Error('network forbidden'); };
for (const protocol of ['node:http', 'node:https']) {
  const mod = require(protocol);
  mod.request = function(...args) { throw new Error('outbound request forbidden'); };
  mod.get = function(...args) { throw new Error('outbound get forbidden'); };
}
`);
    await withSandboxServer(fixture, async (port) => {
      for (const [method, target] of [['GET', '/api/update-status'], ['POST', '/api/update-check']]) {
        const res = await rawRequest(port, target, method);
        assert.equal(res.status, 200, target);
        assert.deepEqual(JSON.parse(res.body), retired, target);
      }
      assert.equal(readFileSync(stalePath, 'utf8'), stale, '旧清单不应改写');
      t.diagnostic('GET /api/update-status and POST /api/update-check -> HTTP 200, fixed retired payload with stale-read/network traps enabled');
    }, { preload });
  } finally { fixture.cleanup(); }
});
