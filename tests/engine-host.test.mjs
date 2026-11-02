import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// U-Claw v2.5 engine-on-host design:
//   stick  = skeleton + one engine-<OPENCLAW_VERSION>.tar.gz (+ .sha256 sidecar)
//   host   = %LOCALAPPDATA%\U-Claw\<slot>\engine\<version>  (macOS: ~/Library/Caches/...)
//   fallback chain: host -> <stick>\engine\<version> -> legacy loose app/ (old sticks)
// These tests pin the contract; the real A/B numbers live in the release notes.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
const readBytes = (...parts) => readFileSync(join(repoRoot, ...parts));

test('engine-host resolvers ship for both platforms', () => {
  assert.ok(existsSync(join(repoRoot, 'portable', 'lib', 'engine-host.ps1')));
  assert.ok(existsSync(join(repoRoot, 'portable', 'lib', 'engine-host.sh')));
});

test('engine-host.ps1 is pure ASCII with CRLF and keeps the legacy default', () => {
  const bytes = readBytes('portable', 'lib', 'engine-host.ps1');
  const offending = bytes.findIndex((b) => b > 0x7f);
  assert.equal(offending, -1, `non-ASCII byte at offset ${offending}`);
  assert.ok(bytes.includes(0x0d), 'engine-host.ps1 must use CRLF');
  const ps1 = bytes.toString('utf8');
  // No archive -> exactly the old behaviour (run from the stick).
  assert.match(ps1, /UCLAW_ENGINE_SOURCE' 'legacy'/);
  assert.match(ps1, /UCLAW_ENGINE_ROOT' \$rootFull/);
});

test('engine-host.ps1 declares host/drive modes, lock, checksum and manifest', () => {
  const ps1 = read('portable', 'lib', 'engine-host.ps1');
  for (const marker of [
    "UCLAW_ENGINE_MODE",
    "'host'",
    "'drive'",
    "LOCALAPPDATA",
    "engine",
    "'manifest.json'",
    "New-Item -ItemType Directory -Path $lock",
    "Get-FileHash",
    ".sha256",
    "free",              // space precheck
    "Move-Item",
  ]) {
    assert.ok(ps1.includes(marker), `engine-host.ps1 must mention ${marker}`);
  }
  // Host install failure must fall back to the stick, not abort startup.
  assert.match(ps1, /\$source = 'drive'/);
  assert.match(ps1, /UCLAW_ENGINE_SOURCE' 'usb'/);
});

test('engine-host.sh mirrors the same contract on macOS', () => {
  const sh = read('portable', 'lib', 'engine-host.sh');
  for (const marker of [
    'UCLAW_ENGINE_MODE',
    'host|drive|auto',
    'Library/Caches',
    'manifest.json',
    'mkdir "$lock"',
    'sha256_of',
    '.sha256',
    'df -Pk',
    'emit UCLAW_ENGINE_SOURCE legacy',
    'SOURCE="drive"',
  ]) {
    assert.ok(sh.includes(marker), `engine-host.sh must mention ${marker}`);
  }
});

test('Windows launcher resolves the engine before the Node bootstrap check', () => {
  const bat = read('portable', 'Windows-Start.bat');
  const resolver = bat.indexOf('lib\\engine-host.ps1');
  const bootstrap = bat.indexOf('call "%UCLAW_DIR%setup.bat"');
  assert.ok(resolver > 0, 'launcher must call engine-host.ps1');
  assert.ok(bootstrap > resolver, 'engine must be resolved before setup.bat bootstrap');
  assert.match(bat, /set "UCLAW_ENGINE_SOURCE=legacy"/, 'legacy must be the default');
  assert.match(bat, /set "UCLAW_ENGINE_ROOT=%UCLAW_DIR%\."/);
});

test('Windows launcher points app-dependent helpers at the resolved engine root', () => {
  const bat = read('portable', 'Windows-Start.bat');
  for (const helper of ['runtime-requirements', 'prepare-wallet', 'upgrade-session-schema']) {
    const line = bat.split('\n').find((l) => l.includes(helper + '.mjs'));
    assert.ok(line, `${helper} call must exist`);
    assert.ok(line.includes('%UCLAW_ENGINE_ROOT%'), `${helper} must use the engine root`);
  }
  // Stick-local helpers keep using UCLAW_DIR (lib/, data/ live on the stick).
  const tokenLine = bat.split('\n').find((l) => l.includes('NODE_BIN') && l.includes('lib\\gateway-token.mjs'));
  assert.ok(tokenLine && tokenLine.includes('%UCLAW_DIR%lib\\'), 'library helpers stay on the stick');
});

test('macOS launcher resolves the engine and uses it for app-dependent helpers', () => {
  const sh = read('portable', 'Mac-Start.command');
  assert.match(sh, /lib\/engine-host\.sh/);
  assert.match(sh, /UCLAW_ENGINE_SOURCE="legacy"/);
  for (const helper of ['runtime-requirements', 'prepare-wallet', 'upgrade-session-schema']) {
    const line = sh.split('\n').find((l) => l.includes(helper + '.mjs'));
    assert.ok(line, `${helper} call must exist`);
    assert.ok(line.includes('$UCLAW_ENGINE_ROOT'), `${helper} must use the engine root`);
  }
});

test('docs explain the three-level fallback', () => {
  const readme = read('README.md');
  assert.match(readme, /engine-host|引擎|engine-<版本>|engine\.tar\.gz/i, 'README must document the engine layout');
});
