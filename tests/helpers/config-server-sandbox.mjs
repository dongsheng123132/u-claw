import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const portableRoot = fileURLToPath(new URL('../../portable/', import.meta.url));
async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

// 所有服务端代码和状态都复制到 temp；绝不让穿越测试接近工作区或真实凭据。
export function createServerSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-config-http-'));
  const serverDir = join(root, 'portable', 'config-server');
  const libDir = join(root, 'portable', 'lib');
  const stateDir = join(root, 'state');
  mkdirSync(join(serverDir, 'public'), { recursive: true });
  mkdirSync(libDir, { recursive: true });
  mkdirSync(stateDir);
  const serverJs = join(serverDir, 'server.js');
  copyFileSync(join(portableRoot, 'config-server', 'server.js'), serverJs);
  for (const name of ['merge-config.mjs', 'wallet-client.mjs', 'uclaw-cloud-endpoints.mjs',
    'official-provider-guard.mjs', 'strip-provider-env.mjs', 'portable-instance-lock.mjs', 'loading.html']) {
    copyFileSync(join(portableRoot, 'lib', name), join(libDir, name));
  }
  writeFileSync(join(serverDir, 'public', 'index.html'), '<html>fixture config center</html>');
  return {
    root, serverDir, libDir, stateDir, serverJs,
    configPath: join(stateDir, 'openclaw.json'),
    cleanup() { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

export async function withSandboxServer(fixture, fn, { preload } = {}) {
  const wantedPort = await availablePort();
  const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), fixture.serverJs], {
    cwd: fixture.root,
    env: {
      ...process.env,
      OPENCLAW_HOME: fixture.stateDir,
      OPENCLAW_STATE_DIR: fixture.stateDir,
      OPENCLAW_CONFIG_PATH: fixture.configPath,
      UCLAW_CONFIG_PORT: String(wantedPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port && child.exitCode === null; i++) {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) port = Number(match[1]);
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(port, `config-server did not report port ${wantedPort}; stdout:\n${stdout}\nstderr:\n${stderr}`);
    await fn(port);
  } finally {
    child.kill();
    let timer;
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
  }
}

// request.path 原样发出，fetch / URL 会提前规范化 ..，无法复现原始 request target。
export function rawRequest(port, target, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method, agent: false,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('sandbox HTTP request timed out')));
    req.end(body);
  });
}
