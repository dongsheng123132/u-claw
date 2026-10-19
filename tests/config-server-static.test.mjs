import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSandbox, withSandboxServer, rawRequest } from './helpers/config-server-sandbox.mjs';

const FAKE_KEY = 'sk-FAKE-SANDBOX-ONLY-0123456789';
const attacks = [
  'uclaw://host/..\\fixture-key.txt',
  'uclaw:../fixture-key.txt',
  'uclaw:/..\\fixture-key.txt',
  '/../fixture-key.txt',
  '/%2e%2e/fixture-key.txt',
  '/..%2ffixture-key.txt',
  '/..%5cfixture-key.txt',
  '/%2e%2e%5cfixture-key.txt',
  '/../public-private/fixture-key.txt',
  '/..%5cpublic-private%5cfixture-key.txt',
];

function seedKeys(fixture) {
  // public 的真实父目录：旧解析器的 opaque URL ../ 确实到达这里。
  writeFileSync(join(fixture.serverDir, 'fixture-key.txt'), FAKE_KEY);
  mkdirSync(join(fixture.serverDir, 'public-private'));
  writeFileSync(join(fixture.serverDir, 'public-private', 'fixture-key.txt'), FAKE_KEY);
}

// cc9f0c2 的原静态路由，放回复制的 server 中作为真实 HTTP 对照，不读取任何真密钥。
const oldStaticRoute = `  // Serve static files
  const requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
  const filePath = requestPath === '/startup'
    ? path.join(__dirname, '../lib/loading.html')
    : requestPath === '/'
      ? path.join(__dirname, 'public/index.html')
      : path.join(__dirname, 'public', requestPath);

`;

test('旧静态路由对照：原始 request target 能经 HTTP 读到沙箱 public 外的假密钥', { skip: process.platform !== 'win32' && '旧漏洞依赖 Windows 反斜杠路径语义' }, async (t) => {
  const fixture = createServerSandbox();
  try {
    seedKeys(fixture);
    const source = readFileSync(fixture.serverJs, 'utf8');
    const begin = source.indexOf('  // Serve static files');
    const end = source.indexOf('  if (fs.existsSync(filePath)', begin);
    assert.ok(begin >= 0 && end > begin);
    writeFileSync(fixture.serverJs, source.slice(0, begin) + oldStaticRoute + source.slice(end));
    await withSandboxServer(fixture, async (port) => {
      const res = await rawRequest(port, attacks[0]);
      assert.equal(res.status, 200);
      assert.equal(res.body, FAKE_KEY);
      t.diagnostic(`old route: ${attacks[0]} -> HTTP ${res.status}, fixture fake key matched`);
    });
  } finally { fixture.cleanup(); }
});

test('静态路由：拒绝穿越、反斜杠和 public 同名前缀目录；只解码一次', async (t) => {
  const fixture = createServerSandbox();
  try {
    seedKeys(fixture);
    writeFileSync(join(fixture.serverDir, 'public', '%2e%2e.txt'), 'decoded once');
    await withSandboxServer(fixture, async (port) => {
      for (const target of attacks) {
        const res = await rawRequest(port, target);
        assert.ok([400, 403].includes(res.status), `${target}: HTTP ${res.status}`);
        assert.ok(!res.body.includes(FAKE_KEY), target);
      }
      const once = await rawRequest(port, '/%252e%252e.txt');
      assert.equal(once.status, 200);
      assert.equal(once.body, 'decoded once');
      t.diagnostic(`fixed route: ${attacks.length}/${attacks.length} raw traversal targets rejected`);
    });
  } finally { fixture.cleanup(); }
});

test('静态路由：畸形 URL/百分号返回 400，之后根页、index、startup 和 query 仍正常', async () => {
  const fixture = createServerSandbox();
  try {
    const index = readFileSync(join(fixture.serverDir, 'public', 'index.html'), 'utf8');
    const loading = readFileSync(join(fixture.libDir, 'loading.html'), 'utf8');
    await withSandboxServer(fixture, async (port) => {
      for (const target of ['http://[broken', '//[broken', '/%', '/%2', '/%GG', '/%E0%A4%A', '/%00', '/index.html?bad=%']) {
        const res = await rawRequest(port, target);
        assert.equal(res.status, 400, target);
      }
      // gateway-check 的 URL 解析已有 try/catch；非法百分号 port 不得触发联网或崩溃。
      for (const target of ['/api/gateway-check?port=%', '/api/gateway-check?port=%GG', '/api/gateway-check%']) {
        const res = await rawRequest(port, target);
        assert.equal(res.status, 400, target);
        assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad port' });
      }
      for (const target of ['/', '/index.html', '/?ignored=1', '/index.html?ignored=1', '/%69ndex.html?ignored=1']) {
        const res = await rawRequest(port, target);
        assert.equal(res.status, 200, target);
        assert.equal(res.body, index, target);
      }
      for (const target of ['/startup', '/startup?port=18789']) {
        const res = await rawRequest(port, target);
        assert.equal(res.status, 200, target);
        assert.equal(res.body, loading, target);
      }
      assert.equal((await rawRequest(port, '/lib/loading.html')).status, 404);
      assert.equal((await rawRequest(port, '/missing')).status, 404);
    });
  } finally { fixture.cleanup(); }
});
