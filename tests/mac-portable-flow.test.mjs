import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(repoRoot, file), 'utf8');

test('Mac reuses a running instance before upgrading core or changing wallet config', () => {
  const start = read('portable/Mac-Start.command');
  const reuse = start.indexOf('if [ "$INSTANCE_STATUS" = "existing" ]');
  const upgrade = start.lastIndexOf('lib/runtime-requirements.mjs');
  const prepare = start.indexOf('lib/prepare-wallet.mjs');
  assert.ok(reuse > 0 && upgrade > reuse && prepare > upgrade);
  assert.match(start, /if \[ ! -x "\$NODE_BIN" \]; then[\s\S]*?bash "\$UCLAW_DIR\/setup\.sh"/);
  assert.match(start, /trap release_startup_lock EXIT/);
  assert.ok(prepare < start.indexOf('"$OPENCLAW_MJS" gateway run'));
});

test('Mac starts the dashboard without opening a separate first-run model page', () => {
  const start = read('portable/Mac-Start.command');
  assert.match(start, /open "file:\/\/\$UCLAW_DIR\/lib\/loading\.html\?port=/);
  assert.doesNotMatch(start, /open "http:\/\/127\.0\.0\.1:\$CONFIG_PORT/);
  assert.doesNotMatch(start, /check-model-configured\.mjs|WECHAT_PLUGIN|openclaw-weixin/);
  assert.match(start, /cp "\$UCLAW_DIR\/default-config\.json" "\$CONFIG_FILE"/);
});

test('Mac menu uses the shared browser configuration and startup routes', () => {
  const menu = read('portable/Mac-Menu.command');
  assert.doesNotMatch(menu, /\bonboard\b|channels add|do_qq|do_platforms|do_plugins|Telegram|微信|飞书/);
  assert.match(menu, /runtime-ports\.mjs" read "\$STATE_DIR"/);
  assert.match(menu, /open "http:\/\/127\.0\.0\.1:\$CONFIG_PORT\//);
  assert.match(menu, /do_dashboard\(\) \{\s*bash "\$UCLAW_DIR\/Mac-Start\.command"/);
  assert.match(menu, /Mac-OpenClaw-CLI\.command/);
});

test('Mac installer preserves data and carries the complete wallet skeleton', (t) => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!existsSync(bash)) return t.skip('Bash is unavailable for the isolated installer fixture');
  const root = mkdtempSync(join(tmpdir(), 'uclaw-mac-install-fixture-'));
  const source = join(root, 'usb');
  const installed = join(root, 'local');
  const bin = join(root, 'bin');
  const put = (path, content, mode = 0o644) => {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content, { mode });
  };
  try {
    put(join(bin, 'uname'), '#!/bin/bash\necho arm64\n', 0o755);
    put(join(source, 'app/runtime/node-mac-arm64/bin/node'), '#!/bin/bash\necho UCLAW_SETUP_NEEDED=0\n', 0o755);
    put(join(source, 'app/core/new-core'), 'new program');
    put(join(source, 'setup.sh'), '#!/bin/bash\nexit 0\n', 0o755);
    put(join(source, 'OPENCLAW_VERSION'), read('OPENCLAW_VERSION'));
    put(join(source, 'models.json'), '{"models":["single-model"]}');
    put(join(source, 'extensions/uclaw-wallet/openclaw.plugin.json'), '{"id":"uclaw-wallet"}');
    put(join(source, 'config-server/server.js'), 'server fixture');
    put(join(source, 'lib/prepare-wallet.mjs'), 'wallet init fixture');
    put(join(source, 'lib/runtime-requirements.mjs'), 'runtime fixture');
    put(join(source, 'Mac-Start.command'), '#!/bin/bash\nexit 0\n', 0o755);
    put(join(source, 'data/.openclaw/openclaw.json'), '{"from":"usb"}');
    const userConfig = '{"from":"existing local data"}\n';
    put(join(installed, 'data/.openclaw/openclaw.json'), userConfig);
    put(join(installed, 'app/core/old-core'), 'old program');
    put(join(installed, 'start.command'), '#!/bin/bash\necho old\n', 0o755);
    const script = read('portable/Mac-Install.command').replace(
      'INSTALL_TARGET="$HOME/.uclaw"', `INSTALL_TARGET="${installed.replaceAll('\\', '/')}"`,
    );
    put(join(source, 'Mac-Install.command'), script, 0o755);
    try {
      execFileSync(bash, [
        '-c', 'task_mock_bin="$(cd "$1" && pwd)"; export PATH="$task_mock_bin:$PATH"; exec /bin/bash "$2"',
        'fixture', bin.replaceAll('\\', '/'), join(source, 'Mac-Install.command').replaceAll('\\', '/'),
      ], {
        input: 'y\n\n', timeout: 20_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Isolated installer exited ${error.status}: ${error.stdout || ''}\n${error.stderr || ''}`);
    }
    assert.equal(readFileSync(join(installed, 'data/.openclaw/openclaw.json'), 'utf8'), userConfig);
    assert.ok(existsSync(join(installed, 'app/core/new-core')));
    assert.ok(existsSync(join(installed, 'extensions/uclaw-wallet/openclaw.plugin.json')));
    assert.ok(existsSync(join(installed, 'models.json')));
    assert.ok(existsSync(join(installed, 'config-server/server.js')));
    assert.ok(existsSync(join(installed, 'lib/prepare-wallet.mjs')));
    assert.match(readFileSync(join(installed, 'start.command'), 'utf8'), /exec bash "\$DIR\/Mac-Start\.command"/);
    const backups = readdirSync(join(installed, 'data/backups'));
    assert.ok(backups.some((name) => existsSync(join(installed, 'data/backups', name, 'app/core/old-core'))));
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    assert.match(root, /uclaw-mac-install-fixture-/);
    rmSync(root, { recursive: true, force: true });
  }
});
