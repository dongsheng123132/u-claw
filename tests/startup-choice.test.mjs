import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// The startup page (portable/lib/loading.html) is the ONLY place a normal
// double-click shows the 「配置 / 改模型」 entry (DeepSeek / Xiapan Cloud keys,
// recharge, channels). v2.3.8 broke it twice over: the page auto-replaced itself
// with the dashboard as soon as /ready answered, and the WebView2 shell skipped
// the page entirely. These tests pin the entry back in place.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(...parts) {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

test('startup page keeps the model-config entry instead of jumping into the dashboard', () => {
  const page = readRepoFile('portable', 'lib', 'loading.html');
  assert.doesNotMatch(page, /location\.replace\(dashboard\)/, 'must not auto-redirect away from the choice page');
  assert.match(page, /document\.body\.classList\.add\('ready'\)/, 'ready state must reveal the choice page');
  assert.match(page, /id="goConfig"[\s\S]*?配置 \/ 改模型/, 'config entry must be visible by name');
  assert.match(page, /id="goDash"/, 'dashboard entry must stay available');
});

test('startup page wires both entries to loopback URLs from the launcher', () => {
  const page = readRepoFile('portable', 'lib', 'loading.html');
  assert.match(page, /getElementById\('goDash'\)\.href = dashboard/, 'dashboard href comes from the gateway port');
  assert.match(page, /getElementById\('goConfig'\)\.href = configCenter/, 'config entry comes from the Config Center port');
  assert.match(page, /getElementById\('manual'\)\.href = configCenter/, 'slow-start fallback also reaches the Config Center');
  assert.match(page, /params\.get\('configPort'\)/, 'config port is never guessed when the launcher passes it');
});

test('both launchers open the startup page with the gateway and config ports', () => {
  const bat = readRepoFile('portable', 'Windows-Start.bat');
  assert.match(bat, /LOADING_URL=file:\/\/\/.*\?port=%PORT%&token=uclaw&configPort=%CONFIG_PORT%/, 'Windows splash URL carries both ports');
  const mac = readRepoFile('portable', 'Mac-Start.command');
  assert.match(mac, /lib\/loading\.html\?port=\$PORT&token=uclaw&configPort=\$CONFIG_PORT/, 'macOS splash URL carries both ports');
});

test('the Config Center still exposes the model key pickers the entry points at', () => {
  const page = readRepoFile('portable', 'config-server', 'public', 'index.html');
  assert.match(page, /选模型/, 'provider picker present');
  assert.match(page, /填写 API Key/, 'key form present');
  assert.match(page, /虾盘云/, 'Xiapan Cloud wallet shortcut present');
});
