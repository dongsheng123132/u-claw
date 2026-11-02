import { readFileSync, existsSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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

test('installed engines carry OPENCLAW_VERSION (runtime-requirements runs against the engine root)', () => {
  const ps1 = read('portable', 'lib', 'engine-host.ps1');
  const sh = read('portable', 'lib', 'engine-host.sh');
  assert.match(ps1, /Set-Content -LiteralPath \(Join-Path \$tmp 'OPENCLAW_VERSION'\)/);
  assert.match(sh, /printf '%s' "\$VERSION" > "\$tmp\/OPENCLAW_VERSION"/);
});

test('release CI packs one engine archive per platform and drops the loose tree', () => {
  const yml = read('.github', 'workflows', 'release.yml');
  const packSteps = yml.match(/Pack engine archive[^\n]*/g) || [];
  assert.equal(packSteps.length, 2, 'both the Windows and the macOS job must pack an engine archive');
  // Build junk must never ship inside the engine.
  assert.equal((yml.match(/--exclude='app\/\.npm-cache'/g) || []).length, 2);
  // A truncated archive must fail the build, not the customer's first start.
  assert.match(yml, /engine archive is missing node\.exe/);
  assert.match(yml, /engine archive is missing the arm64 node binary/);
  assert.match(yml, /sha256sum "\$archive"/);
  // The loose app/ tree is removed from the shipped bundle (that was the whole point).
  assert.match(yml, /rm -rf "\$stage_dir\/app"/);
  // macOS zip self-check no longer expects node inside the zip, but must find the archive.
  assert.match(yml, /zip 里没有 engine-<version>\.tar\.gz/);
});

test('lib CLI entry guards survive symlinked paths', { skip: process.platform === 'win32' }, () => {
  // macOS /tmp -> /private/tmp taught us the hard way: a raw-argv guard prints
  // nothing, the launcher reads that as "needs setup", and the customer is sent
  // to an online reinstall on first start.
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-symlink-'));
  const link = join(dir, 'runtime-requirements.mjs');
  symlinkSync(join(repoRoot, 'portable', 'lib', 'runtime-requirements.mjs'), link);
  const out = execFileSync(process.execPath, [link, join(repoRoot, 'portable')], { encoding: 'utf8' });
  assert.match(out, /UCLAW_SETUP_NEEDED=[01]/);
});

test('tools/win-accept.ps1 ships pure ASCII + CRLF and covers the six acceptance cases', () => {
  const bytes = readBytes('tools', 'win-accept.ps1');
  assert.equal(bytes.findIndex((b) => b > 0x7f), -1, 'win-accept.ps1 must stay ASCII (it runs in a GBK console)');
  assert.ok(bytes.includes(0x0d), 'win-accept.ps1 must use CRLF');
  const ps1 = bytes.toString('utf8');
  for (const marker of ['A_cold_first_run', 'B_warm_second_run', 'C_forced_drive',
                        'D_corrupt_archive', 'E_interrupted_install', 'F_legacy_layout']) {
    assert.ok(ps1.includes(marker), `acceptance script must run ${marker}`);
  }
});

test('a damaged archive stops with a clear message instead of an online setup', () => {
  const ps1 = read('portable', 'lib', 'engine-host.ps1');
  const sh = read('portable', 'lib', 'engine-host.sh');
  for (const src of [ps1, sh]) {
    assert.match(src, /UCLAW_ENGINE_SOURCE' 'broken'|emit UCLAW_ENGINE_SOURCE broken/);
    assert.match(src, /UCLAW_ENGINE_ARCHIVE/);
  }
  const bat = read('portable', 'Windows-Start.bat');
  const mac = read('portable', 'Mac-Start.command');
  for (const src of [bat, mac]) {
    assert.ok(src.includes('UCLAW_ENGINE_SOURCE'), 'launchers must branch on the engine source');
  }
  assert.match(bat, /UCLAW_ENGINE_SOURCE%"=="broken"/);
  assert.match(mac, /UCLAW_ENGINE_SOURCE" = "broken"/);
  // The archive path has to reach the message, otherwise "File:" prints empty.
  assert.ok(bat.includes('UCLAW_ENGINE_ARCHIVE=%%b'));
  assert.ok(mac.includes('UCLAW_ENGINE_ARCHIVE) UCLAW_ENGINE_ARCHIVE='));
});

test('Windows launcher never compares against a quoted backslash (cmd parse trap)', () => {
  // '"%VAR:~-1%"=="\\"' makes cmd report "The syntax of the command is incorrect"
  // and exits 255 right after the banner -- exactly what the CI run showed.
  const bat = read('portable', 'Windows-Start.bat');
  assert.ok(!bat.includes(':~-1%"=="\\"'), 'do not compare the last char with a quoted backslash');
});

test('engine resolver call uses the launcher-wide for/f quote convention', () => {
  const bat = read('portable', 'Windows-Start.bat');
  const line = bat.split('\n').find((l) => l.includes('engine-host.ps1" "%UCLAW_DIR%."'));
  assert.ok(line, 'resolver call must exist');
  assert.ok(line.includes('`""powershell"'), 'for/f over a quoted command needs the outer quote pair');
  assert.ok(line.trimEnd().endsWith('2^>nul"`) do ('), 'stderr redirect must stay inside the quote pair');
  // The call must not sit inside an IF block (cmd re-parses %VAR% there).
  const before = bat.slice(0, bat.indexOf(line));
  const openIf = (before.match(/^if .*\($/gm) || []).length;
  assert.equal(openIf, 0, 'resolver must run at top level, guarded by goto');
});
