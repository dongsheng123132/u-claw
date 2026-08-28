import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const server = readFileSync(join(repoRoot, 'portable', 'config-server', 'server.js'), 'utf8');
const configUi = readFileSync(join(repoRoot, 'portable', 'config-server', 'public', 'index.html'), 'utf8');

// The ilink QR API (StatusResponse in openclaw-weixin/src/auth/login-qr.ts) can return
// status "scaned_but_redirect" with a redirect_host: after the user scans, polling must
// move to a new IDC host or "confirmed" never arrives and the QR screen hangs forever.
// The config-server must mirror the plugin's redirect handling.

test('config-server follows the WeChat scaned_but_redirect IDC redirect', () => {
  // Status polling uses a redirect-aware host, not the fixed apiBaseUrl directly.
  assert.match(
    server,
    /pollWeChatQrStatus\(\s*login\.pollBaseUrl\s*\|\|\s*login\.apiBaseUrl/,
    'status polling must use login.pollBaseUrl (falls back to apiBaseUrl)',
  );

  // On scaned_but_redirect, switch the poll host to redirect_host.
  assert.match(
    server,
    /scaned_but_redirect[\s\S]{0,200}login\.pollBaseUrl\s*=\s*['"]https:\/\/['"]\s*\+\s*result\.redirect_host/,
    'must set login.pollBaseUrl to https://<redirect_host> on scaned_but_redirect',
  );

  // The redirect case is reported to the client as "scaned" so it keeps polling.
  assert.match(
    server,
    /scaned_but_redirect[\s\S]{0,260}return\s*\{\s*status:\s*['"]scaned['"]\s*\}/,
    'scaned_but_redirect should surface as status "scaned" to the client',
  );
});

test('config-server writes the Telegram bot token under the field OpenClaw reads (botToken)', () => {
  // OpenClaw's top-level telegram channel schema only reads `botToken` (the legacy
  // `token` alias is honored only inside accounts.<id>). Writing flat `token` silently
  // disables Telegram, so the Config Center must write `botToken`.
  assert.match(
    configUi,
    /channels\.telegram\s*=\s*\{[^}]*botToken:\s*tgToken/,
    'telegram channel must be saved with botToken',
  );
  assert.doesNotMatch(
    configUi,
    /channels\.telegram\s*=\s*\{[^}]*\btoken:\s*tgToken/,
    'telegram channel must not use the flat `token` field (ignored by OpenClaw)',
  );
});

test('config-server resets the poll host when the QR is refreshed', () => {
  // A refreshed QR comes from the original host, so the redirected poll host must reset,
  // otherwise the new QR would be polled against a stale redirect host.
  assert.match(
    server,
    /status:\s*'refreshed'[\s\S]{0,400}/,
    'refresh branch should exist',
  );
  assert.match(
    server,
    /login\.pollBaseUrl\s*=\s*null;[\s\S]{0,200}status:\s*'refreshed'/,
    'QR refresh must reset login.pollBaseUrl before returning refreshed',
  );
});

// ⚠️ 微信接入降级开关一致性（2026-08-27 专家会审定）：上游 ESM 加载竞态未修，入口降级。
// 铁律：前端 index.html 与后端 server.js 的 WECHAT_ENABLED 必须同值——恢复时改其中一处
// 漏改另一处 = 前端提示可扫、后端 503（或反之），用户陷入矛盾提示。
test('WeChat downgrade switch is consistent across frontend and backend', () => {
  const mServer = server.match(/const\s+WECHAT_ENABLED\s*=\s*(true|false);/);
  const mUi = configUi.match(/var\s+WECHAT_ENABLED\s*=\s*(true|false);/);
  assert.ok(mServer, 'server.js must declare WECHAT_ENABLED');
  assert.ok(mUi, 'index.html must declare WECHAT_ENABLED');
  assert.equal(mServer[1], mUi[1], 'frontend/backend switch values must stay in sync');
  // 钉死「当前处于降级期」：上游 ESM 加载竞态修复前，两处开关必须都是 false。
  // 上游修复恢复接入时，把两处改回 true 并同步改掉本断言。
  assert.equal(mServer[1], 'false', 'downgrade must be active right now');
  assert.equal(mUi[1], 'false', 'downgrade must be active right now');
});

test('WeChat start API really returns 503 while downgraded', async () => {
  // 真实启服打真路由（非仅正则）：降级期 POST /api/wechat/start 必须 503 + 明确 JSON。
  // 用临时 OPENCLAW_STATE_DIR 隔离，不碰真实 ~/.openclaw；CONFIG_PATH 相对 __dirname，
  // 503 短路径在写任何文件之前返回，无副作用。
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const serverJs = join(repoRoot, 'portable', 'config-server', 'server.js');
  const stateDir = mkdtempSync(join(tmpdir(), 'uclaw-wechat-downgrade-'));
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  try {
    // 从启动日志解析实际监听端口（18788 被占时 server 会 fallback 到 18789+）
    let port = null;
    for (let i = 0; i < 60 && port === null; i++) {
      const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) port = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(port, `config-server did not report a port; stdout:\n${stdout}`);

    let res;
    for (let i = 0; i < 40; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/api/wechat/start`, { method: 'POST' });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    assert.ok(res, `server never answered on port ${port}`);
    assert.equal(res.status, 503, 'start must 503 while downgraded');
    assert.equal(res.headers.get('content-type'), 'application/json', 'must return JSON, not HTML/text');
    const payload = await res.json();
    assert.equal(
      payload.error,
      '微信插件存在上游兼容问题，暂时无法接入，修复后会随更新自动恢复。',
      '503 body must carry the stable error field with the clear reason',
    );
    assert.equal(payload.qrcodeUrl, undefined, 'must not leak a QR payload while downgraded');
    assert.equal(payload.sessionKey, undefined, 'must not start a login session while downgraded');
  } finally {
    child.kill();
    // Windows 下 kill 后立即删目录可能撞清理竞态：等进程真正退出再删（sol R3 建议）。
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('config-server start API rejects WeChat login while downgraded', () => {
  // 降级期必须后端兜底 503：防浏览器缓存旧页 / 客户端绕过前端直调 API。
  // 恢复时（WECHAT_ENABLED=true）此 guard 随开关自然关闭，无需删测试。
  assert.match(
    server,
    /if\s*\(!WECHAT_ENABLED\)\s*\{[\s\S]{0,200}writeHead\(503/,
    'start API must 503 while downgraded',
  );
});
