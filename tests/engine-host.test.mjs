import { readFileSync, existsSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// U-Claw v2.5 engine-on-host design:
//   stick  = skeleton + one engine-<OPENCLAW_VERSION>.tar.gz (+ .sha256 sidecar)
//   host   = %LOCALAPPDATA%\U-Claw\<slot>\engine\<version>  (macOS: ~/Library/Caches/...)
//   fallback: host -> <stick>\engine\<version> -> damaged-archive error (legacy loose
//   tree only for sticks that never shipped an archive).

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
const readBytes = (...parts) => readFileSync(join(repoRoot, ...parts));

test('engine-host resolvers ship for both platforms', () => {
  assert.ok(existsSync(join(repoRoot, 'portable', 'lib', 'engine-host.ps1')));
  assert.ok(existsSync(join(repoRoot, 'portable', 'lib', 'engine-host.sh')));
});

test('engine-host.ps1 is pure ASCII with CRLF and keeps the legacy default', () => {
  const bytes = readBytes('portable', 'lib', 'engine-host.ps1');
  assert.equal(bytes.findIndex((b) => b > 0x7f), -1, 'engine-host.ps1 must be ASCII (GBK console)');
  assert.ok(bytes.includes(0x0d), 'engine-host.ps1 must use CRLF');
  const ps1 = bytes.toString('utf8');
  assert.match(ps1, /UCLAW_ENGINE_SOURCE' 'legacy'/);
  assert.match(ps1, /UCLAW_ENGINE_ROOT' \$rootFull/);
});

test('engine-host.ps1 declares host/drive modes, lock, checksum and manifest', () => {
  const ps1 = read('portable', 'lib', 'engine-host.ps1');
  for (const marker of ['UCLAW_ENGINE_MODE', "'host'", "'drive'", 'LOCALAPPDATA', "'manifest.json'",
                        'New-Item -ItemType Directory -Path $lock', 'Get-FileHash', '.sha256', 'Move-Item']) {
    assert.ok(ps1.includes(marker), `engine-host.ps1 must mention ${marker}`);
  }
  assert.match(ps1, /\$source = 'drive'/, 'host failure falls back to the stick');
  assert.match(ps1, /UCLAW_ENGINE_SOURCE' 'broken'/, 'damaged archive must not look like legacy');
});

test('engine-host.sh mirrors the same contract on macOS', () => {
  const sh = read('portable', 'lib', 'engine-host.sh');
  for (const marker of ['UCLAW_ENGINE_MODE', 'host|drive|auto', 'Library/Caches', 'manifest.json',
                        'mkdir "$lock"', '.sha256', 'df -Pk', 'emit UCLAW_ENGINE_SOURCE legacy',
                        'SOURCE="drive"', 'emit UCLAW_ENGINE_SOURCE broken']) {
    assert.ok(sh.includes(marker), `engine-host.sh must mention ${marker}`);
  }
});

test('installed engines carry OPENCLAW_VERSION (runtime-requirements runs against the engine root)', () => {
  const ps1 = read('portable', 'lib', 'engine-host.ps1');
  const sh = read('portable', 'lib', 'engine-host.sh');
  assert.match(ps1, /Set-Content -LiteralPath \(Join-Path \$tmp 'OPENCLAW_VERSION'\)/);
  assert.match(sh, /printf '%s' "\$VERSION" > "\$tmp\/OPENCLAW_VERSION"/);
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

test('Windows launcher resolves the engine via a temp file (cmd quoting is a minefield)', () => {
  const bat = read('portable', 'Windows-Start.bat');
  // CI proved a backquoted for/f hands "2>nul" to PowerShell as an argument.
  assert.ok(!bat.includes('(`""powershell"'), 'no backquoted resolver call');
  assert.match(bat, /> "%UCLAW_ENGINE_ENV%" 2>nul/, 'resolver stdout goes to a temp file');
  assert.match(bat, /for \/f "usebackq tokens=1,\* delims==" %%a in \("%UCLAW_ENGINE_ENV%"\) do \(/);
  assert.match(bat, /del "%UCLAW_ENGINE_ENV%"/, 'temp file is cleaned up');
  assert.match(bat, /if not exist "%UCLAW_DIR%lib\\engine-host\.ps1" goto :uclaw_engine_resolved/);
  assert.equal((bat.match(/:uclaw_engine_resolved/g) || []).length, 3, 'two gotos + one label');
});

test('Windows launcher never compares against a quoted backslash (cmd parse trap)', () => {
  // 'if "%VAR:~-1%"=="\"' makes cmd exit 255 with "The syntax of the command is incorrect".
  const bat = read('portable', 'Windows-Start.bat');
  assert.ok(!bat.includes(':~-1%"=="\\"'), 'do not compare the last char with a quoted backslash');
});

test('Windows launcher points app-dependent helpers at the resolved engine root', () => {
  const bat = read('portable', 'Windows-Start.bat');
  for (const helper of ['runtime-requirements', 'prepare-wallet', 'upgrade-session-schema']) {
    const candidates = bat.split('\n').filter((l) => l.includes(helper + '.mjs') && !l.trimStart().startsWith('REM'));
    assert.ok(candidates.length, `${helper} call must exist`);
    assert.ok(candidates.some((l) => l.includes('%UCLAW_ENGINE_ROOT%')), `${helper} must use the engine root`);
  }
  const tokenLine = bat.split('\n').find((l) => l.includes('NODE_BIN') && l.includes('lib\\gateway-token.mjs'));
  assert.ok(tokenLine && tokenLine.includes('%UCLAW_DIR%lib\\'), 'stick-local helpers stay on the stick');
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
  // Process substitution needs /dev/fd, which sandboxes deny; read a temp file instead.
  assert.match(sh, /bash "\$UCLAW_DIR\/lib\/engine-host\.sh" "\$UCLAW_DIR" > "\$_engine_env"/);
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
  assert.match(bat, /UCLAW_ENGINE_SOURCE%"=="broken"/);
  assert.match(mac, /UCLAW_ENGINE_SOURCE" = "broken"/);
  assert.ok(bat.includes('UCLAW_ENGINE_ARCHIVE=%%b'));
  assert.ok(mac.includes('UCLAW_ENGINE_ARCHIVE) UCLAW_ENGINE_ARCHIVE='));
});

test('release CI packs one engine archive per platform and drops the loose tree', () => {
  const yml = read('.github', 'workflows', 'release.yml');
  assert.equal((yml.match(/Pack engine archive[^\n]*/g) || []).length, 2,
               'both the Windows and the macOS job must pack an engine archive');
  assert.equal((yml.match(/--exclude='app\/\.npm-cache'/g) || []).length, 2, 'build junk must not ship');
  assert.match(yml, /engine archive is missing node\.exe/);
  assert.match(yml, /engine archive is missing the arm64 node binary/);
  assert.match(yml, /sha256sum "\$archive"/);
  assert.match(yml, /rm -rf "\$stage_dir\/app"/);
  assert.match(yml, /zip 里没有 engine-<version>\.tar\.gz/);
});

test('lib CLI entry guards survive symlinked paths', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-symlink-'));
  const link = join(dir, 'runtime-requirements.mjs');
  symlinkSync(join(repoRoot, 'portable', 'lib', 'runtime-requirements.mjs'), link);
  const out = execFileSync(process.execPath, [link, join(repoRoot, 'portable')], { encoding: 'utf8' });
  assert.match(out, /UCLAW_SETUP_NEEDED=[01]/);
});

test('tools/win-accept.ps1 ships pure ASCII + CRLF and covers the six acceptance cases', () => {
  const bytes = readBytes('tools', 'win-accept.ps1');
  assert.equal(bytes.findIndex((b) => b > 0x7f), -1, 'must stay ASCII (it runs in a GBK console)');
  assert.ok(bytes.includes(0x0d), 'must use CRLF');
  const ps1 = bytes.toString('utf8');
  for (const marker of ['A_cold_first_run', 'B_warm_second_run', 'C_forced_drive',
                        'D_corrupt_archive', 'E_interrupted_install', 'F_legacy_layout']) {
    assert.ok(ps1.includes(marker), `acceptance script must run ${marker}`);
  }
});

test('docs explain the three-level fallback', () => {
  const readme = read('README.md');
  assert.match(readme, /UCLAW_ENGINE_MODE/, 'README must document the mode switch');
  assert.match(readme, /engine-<OPENCLAW_VERSION>\.tar\.gz/);
});

test('requirements capture reads a temp file and the helper sits after the main flow', () => {
  const bat = read('portable', 'Windows-Start.bat');
  // Same cmd trap as the engine resolver: a backquoted for/f leaks "2>nul" as an
  // argument, node ignores it, and the variable is captured -- but PowerShell errors.
  assert.ok(!bat.includes('runtime-requirements.mjs\" \"%UCLAW_ENGINE_ROOT%.\" 2^>nul\"`)'));
  assert.match(bat, /call :uclaw_capture_requirements/);
  assert.match(bat, /> "%UCLAW_REQ_ENV%" 2>nul/);
  // A label in the middle of the main flow would fall through and hit goto :eof.
  const labelAt = bat.lastIndexOf('\n:uclaw_capture_requirements');
  const lastExit = bat.lastIndexOf('exit /b');
  assert.ok(labelAt > lastExit, 'helper must live after the main flow (call-only)');
});

test('Windows launcher captures no command output through a backquoted for/f', () => {
  // cmd strips the quote pair and hands "2>nul" to the program: PowerShell dies on
  // strict parameter binding, node silently ignores it. Every capture now goes
  // through %TEMP% files instead.
  const bat = read('portable', 'Windows-Start.bat');
  assert.equal((bat.match(/in \(`/g) || []).length, 0, 'no backquoted command captures left');
  for (const name of ['strip', 'cache', 'lock', 'fs', 'noproxy', 'lifecycle', 'pid', 'cfgport']) {
    assert.ok(bat.includes(`uclaw-${name}.env`), `capture ${name} must use a temp file`);
    assert.ok(bat.includes(`del "%TEMP%\\uclaw-${name}.env"`), `capture ${name} must clean up`);
  }
});
