import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(...parts) {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

function lineOf(content, needle) {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `missing line containing: ${needle}`);
  return lines[index];
}

test('Windows-Start dependency fallback text escapes parentheses inside IF block', () => {
  const script = readRepoFile('portable', 'Windows-Start.bat');

  assert.match(
    lineOf(script, 'Falling back to npm install'),
    /\^\(USB drives may take 20\+ minutes\^\)\./,
  );
  assert.match(
    lineOf(script, 'pre-installed deps'),
    /\^\(~200 MB\^\)\./,
  );
});

test('portable Windows launchers disable OpenClaw bonjour discovery', () => {
  for (const scriptName of [
    'Windows-Start.bat',
    'Windows-Maintain.bat',
    'Windows-Install.bat',
  ]) {
    const script = readRepoFile('portable', scriptName);
    assert.match(
      script,
      /OPENCLAW_DISABLE_BONJOUR=1/,
      `${scriptName} should disable bonjour discovery`,
    );
  }
});

test('portable launchers keep OpenClaw state portable and route cache/temp/log through the shared helper', () => {
  const winStart = readRepoFile('portable', 'Windows-Start.bat');
  assert.match(
    winStart,
    /call "%UCLAW_DIR%lib\\portable-cache-env\.bat" "%STATE_DIR%" "%UCLAW_DIR%"/,
    'Windows launcher must call the shared cache resolver helper',
  );
  assert.match(winStart, /set "OPENCLAW_MANAGED_BROWSER_DIR="/);
  assert.match(
    winStart,
    /if errorlevel 1 \([\s\S]*No writable local cache directory[\s\S]*exit \/b 1/,
    'Windows launcher must stop with a visible error when no writable local cache exists',
  );
  assert.doesNotMatch(winStart, /UCLAW_RUNTIME_STATE_DIR/);
  assert.doesNotMatch(winStart, /APP_DIR\\\.npm-cache|\.npm-cache/, 'npm cache must not live on the portable drive');
  assert.doesNotMatch(winStart, /check-update\.mjs/, 'startup update check is retired');

  const helperBat = readRepoFile('portable', 'lib', 'portable-cache-env.bat');
  assert.match(helperBat, /OPENCLAW_MANAGED_BROWSER_DIR=/, 'helper must export the managed browser dir');
  assert.match(helperBat, /NODE_DISABLE_COMPILE_CACHE=1/, 'helper must disable compile cache on failure');
  assert.doesNotMatch(helperBat, /2\^>nul/, 'helper must not swallow node stderr');

  const macStart = readRepoFile('portable', 'Mac-Start.command');
  assert.match(macStart, /portable-cache-env\.sh/, 'Mac launcher must source the shared cache resolver helper');
  assert.match(macStart, /unset OPENCLAW_MANAGED_BROWSER_DIR/);
  assert.match(macStart, /OPENCLAW_STATE_DIR="\$STATE_DIR"/);
  assert.match(
    macStart,
    /portable-cache-env\.sh[\s\S]*无可写本机缓存目录[\s\S]*exit 1/,
    'Mac launcher must stop with a visible error when no writable local cache exists',
  );
  assert.doesNotMatch(macStart, /data\/logs\/startup-/, 'startup log must live in the local log dir, not on USB');
  assert.doesNotMatch(macStart, /check-update\.mjs/, 'startup update check is retired');
  assert.doesNotMatch(macStart, /\.npm-cache/, 'npm cache must not live on the portable drive');

  const helperSh = readRepoFile('portable', 'lib', 'portable-cache-env.sh');
  assert.match(helperSh, /OPENCLAW_MANAGED_BROWSER_DIR=/, 'sh helper must export the managed browser dir');
  assert.match(helperSh, /NODE_DISABLE_COMPILE_CACHE=1/, 'sh helper must disable compile cache on failure');
});

test('Mac launcher gates duplicate clicks behind the portable single-instance lock', () => {
  const macStart = readRepoFile('portable', 'Mac-Start.command');
  assert.match(macStart, /portable-instance-lock\.mjs" acquire/, 'Mac launcher must acquire the launcher lock before choosing a port');
  assert.match(macStart, /UCLAW_INSTANCE_STATUS\) INSTANCE_STATUS=/, 'Mac launcher must consume the lock status');
  assert.match(macStart, /U-Claw is already running; reusing the existing instance\./, 'second click should reuse instead of starting another gateway');
  assert.match(macStart, /portable-instance-lock\.mjs" publish/, 'selected port must be published for a second click');
  assert.match(macStart, /portable-instance-lock\.mjs" release/, 'launcher must release its lock on exit');
  assert.doesNotMatch(macStart, /gateway run --allow-unconfigured --force --port/, 'launcher must not force-kill a process on a selected port');
});

test('Windows launcher gates duplicate clicks behind the portable single-instance lock', () => {
  const winStart = readRepoFile('portable', 'Windows-Start.bat');
  assert.match(winStart, /portable-instance-lock\.mjs" acquire/, 'Windows launcher must acquire the launcher lock before choosing a port');
  assert.match(winStart, /\$q\.ParentProcessId/, 'Windows launcher must keep the batch-host cmd PID, not FOR /F\'s temporary cmd PID');
  assert.match(winStart, /U-Claw is already running; reusing the existing instance\./, 'second click should reuse instead of starting another gateway');
  assert.match(winStart, /portable-instance-lock\.mjs" publish/, 'selected port must be published for a second click');
  assert.match(winStart, /portable-instance-lock\.mjs" release/, 'launcher must release its lock after the gateway exits');
  assert.doesNotMatch(winStart, /gateway run --allow-unconfigured --force --port/, 'launcher must not force-kill a process on a selected port');
});

test('Windows startup only auto-opens Config Center when no model is configured (issue #24)', () => {
  // Previously Windows-Start.bat force-opened Config Center on every launch,
  // even for returning users who already picked a model -- that's the "config
  // page pops up every single time I start it" complaint in issue #24. This
  // replaced the old "always open Config Center" behavior below with the
  // design documented in the repo CLAUDE.md: first run (no model configured)
  // opens Config Center; configured runs land on the Dashboard only. The
  // config-server itself still always starts, and Windows-Maintain.bat still
  // offers the settings entry, so Config Center remains reachable manually.
  const script = readRepoFile('portable', 'Windows-Start.bat');

  assert.match(
    script,
    /lib\\check-model-configured\.mjs/,
    'should consult the model-configured helper before deciding whether to auto-open Config Center',
  );
  assert.match(script, /\/startup\?port=%PORT%&token=uclaw&configured=%MODEL_CONFIGURED%/,
    'one startup page receives the configuration state and selects the destination after readiness');
  const wait = script.indexOf('lib\\wait-model-config.mjs');
  const run = script.indexOf('gateway run --allow-unconfigured --port');
  assert.ok(wait > 0 && wait < run, 'first run saves configuration before Gateway starts, preventing concurrent initialization writes');
});

test('Windows launcher publishes the actually-selected gateway port to runtime.json (v2.2.1)', () => {
  // v2.2.0 bug: config-server guessed the gateway port as configServerPort + 1.
  // That guess broke whenever 18789 was already taken and the gateway fell back
  // to 18790+ -- the guess then pointed at whatever else was listening on 18789
  // on the customer's machine, so saved API keys silently never reached the
  // real gateway. The launcher must now publish its actual chosen port.
  const script = readRepoFile('portable', 'Windows-Start.bat');
  assert.match(
    script,
    /lib\\runtime-ports\.mjs" publish "%STATE_DIR%" gateway %PORT%/,
    'Windows launcher must publish the selected gateway port via runtime-ports.mjs',
  );
});

test('Windows gateway port scan does not read %PORT% inside a parenthesized block (v2.2.0 off-by-one)', () => {
  // v2.2.0's ":check_port" wrote "if %PORT% gtr 18799" inside an "if %errorlevel%==0 ( ... )"
  // block. cmd.exe substitutes %PORT% for the WHOLE block at parse time, before any
  // statement in the block runs -- so the gtr check always saw the pre-increment value
  // and the loop could probe one port past 18799. The fix moves the bound check to a
  // bare (non-parenthesized) line reached via goto, so %PORT% is read fresh each time.
  const script = readRepoFile('portable', 'Windows-Start.bat');
  const checkPortStart = script.indexOf(':check_port');
  const portSelectedLabel = script.indexOf('\n:port_selected', checkPortStart + 1);
  assert.notEqual(checkPortStart, -1);
  assert.notEqual(portSelectedLabel, -1);
  const checkPortSection = script.slice(checkPortStart, portSelectedLabel);
  assert.doesNotMatch(
    checkPortSection,
    /if %errorlevel%==0 \(/,
    'gateway port bound check must not live inside a parenthesized IF block',
  );
  assert.match(checkPortSection, /if %PORT% gtr 18799 goto :no_gateway_port/);
});

test('Windows gateway fallback does not force-open Dashboard', () => {
  const script = readRepoFile('portable', 'lib', 'wait-gateway.bat');

  assert.match(
    script,
    /:timeout[\s\S]*start "" http:\/\/127\.0\.0\.1:%CONFIG_PORT%\//,
    'wait-gateway.bat should return users to Config Center on timeout',
  );
  assert.doesNotMatch(
    script,
    /#token=uclaw/,
    'fallback should not push configured users straight into Dashboard',
  );
  assert.doesNotMatch(
    lineOf(script, ':ready') + '\n' + lineOf(script, 'exit /b 0'),
    /start ""/,
    'ready fallback should not open duplicate browser tabs',
  );
});

test('portable launchers route configured model hosts around the system proxy', () => {
  const winStart = readRepoFile('portable', 'Windows-Start.bat');
  assert.match(
    winStart,
    /resolve-no-proxy\.mjs[\s\S]*UCLAW_NO_PROXY[\s\S]*set "NO_PROXY=/,
    'Windows-Start.bat should set NO_PROXY from resolve-no-proxy.mjs',
  );

  const macStart = readRepoFile('portable', 'Mac-Start.command');
  assert.match(
    macStart,
    /resolve-no-proxy\.mjs[\s\S]*export NO_PROXY=/,
    'Mac-Start.command should export NO_PROXY from resolve-no-proxy.mjs',
  );
});

test('customer-facing .bat launchers are pure ASCII (cmd.exe mis-parses UTF-8 Chinese on GBK Windows)', () => {
  // Non-ASCII bytes in a .bat get read as GBK by Chinese Windows cmd.exe, which
  // garbles parsing ("usebackq is not a command"). Chinese UX must live in the
  // node tools' stdout (rendered fine under chcp 65001), never in the .bat itself.
  for (const name of [
    'Windows-Start.bat',
    'Windows-Maintain.bat',
    'Windows-IntranetFix.bat',
    'OpenClaw-Doctor.bat',
    join('lib', 'portable-cache-env.bat'),
  ]) {
    const bytes = readFileSync(join(repoRoot, 'portable', name));
    const offending = bytes.findIndex((b) => b > 0x7f);
    assert.equal(offending, -1, `${name} has a non-ASCII byte at offset ${offending}`);
    assert.ok(bytes.includes(0x0d), `${name} must use CRLF line endings`);
  }
});

test('macOS .command launchers are LF-only (CRLF breaks #!/bin/bash on macOS)', () => {
  for (const name of [
    'Mac-Start.command',
    'Mac-Maintain.command',
    'Mac-IntranetFix.command',
    'Mac-OpenClaw-Doctor.command',
  ]) {
    const bytes = readFileSync(join(repoRoot, 'portable', name));
    const cr = bytes.indexOf(0x0d);
    assert.equal(cr, -1, `${name} has a CR byte at offset ${cr} (must be LF-only)`);
    assert.ok(bytes.toString('utf8').startsWith('#!/bin/bash'), `${name} must start with a clean shebang`);
  }
});

test('macOS intranet / doctor launchers call the shared cross-platform scripts', () => {
  assert.match(readRepoFile('portable', 'Mac-IntranetFix.command'), /lib\/intranet-check\.mjs/);
  assert.match(readRepoFile('portable', 'Mac-OpenClaw-Doctor.command'), /doctor --non-interactive/);
});

test('portable maintain menus expose a CLI terminal entry point (issue #53)', () => {
  // Windows-Maintain.bat and Mac-Maintain.command are the only maintenance menus
  // most users ever see; they must offer a way to launch the raw OpenClaw CLI.
  const winMenu = readRepoFile('portable', 'Windows-Maintain.bat');
  assert.match(winMenu, /goto :cli/, 'Windows-Maintain.bat menu choice should route to a CLI entry');
  assert.match(winMenu, /:cli[\s\S]*OpenClaw-CLI\.bat/, 'Windows-Maintain.bat should launch OpenClaw-CLI.bat');

  const macMenu = readRepoFile('portable', 'Mac-Maintain.command');
  assert.match(macMenu, /do_cli/, 'Mac-Maintain.command should have a CLI menu action');
  assert.match(macMenu, /Mac-OpenClaw-CLI\.command/, 'Mac-Maintain.command should launch Mac-OpenClaw-CLI.command');
});

test('maintain menus are thin input/open layers with no dangerous actions', () => {
  for (const name of ['Windows-Maintain.bat', 'Mac-Maintain.command']) {
    const menu = readRepoFile('portable', name);
    assert.doesNotMatch(menu, /doctor[^\n]*--repair/, `${name} must not offer doctor --repair`);
    assert.doesNotMatch(menu, /doctor[^\n]*--fix/, `${name} must not offer doctor --fix`);
    assert.doesNotMatch(menu, /taskkill|killall|fuser\s+-k|lsof[^\n]*kill/i, `${name} must not kill ports/processes`);
    assert.doesNotMatch(menu, /gateway run/, `${name} must not start a second gateway`);
    assert.doesNotMatch(menu, /onboard|channels add|plugins install/i, `${name} must not run channel/plugin install`);
    // Options must cover the approved set (plus exit).
    for (const needle of ['settings-url', 'logs-path', 'backup', 'restore', 'OpenClaw-CLI', 'releases']) {
      assert.ok(menu.includes(needle), `${name} missing option ${needle}`);
    }
    assert.match(menu, /Diagnose/i, `${name} missing Diagnose option`);
  }
  // Old full-featured menus must be gone (no revival shim).
  for (const gone of [
    join('portable', 'Windows-Menu.bat'),
    join('portable', 'Mac-Menu.command'),
    join('portable', 'lib', 'maintain.sh'),
  ]) {
    assert.equal(existsSync(join(repoRoot, gone)), false, `${gone} must be deleted`);
  }
});

test('OpenClaw doctor launcher is read-only (no destructive repair flags)', () => {
  const bat = readRepoFile('portable', 'OpenClaw-Doctor.bat');
  assert.match(bat, /OPENCLAW_MJS%" doctor --non-interactive/);
  // Must not auto-apply repairs that could overwrite user config/state.
  assert.doesNotMatch(bat, /doctor[^\n]*--fix/);
  assert.doesNotMatch(bat, /doctor[^\n]*--repair/);
  assert.doesNotMatch(bat, /doctor[^\n]*--force/);
});

test('随盘 skills-cn/ 已整体移出：无目录、setup 不复制、仓库无路径引用', () => {
  // 范围剃刀 2026-10-19：OpenClaw 自己能做的（技能）不再包一层；同内容不得
  // 在 portable/ 与 install/ 各留一份会漂移的副本。
  assert.equal(existsSync(join(repoRoot, 'portable', 'skills-cn')), false, 'portable/skills-cn/ must be deleted');

  const setupSh = readRepoFile('portable', 'setup.sh');
  assert.doesNotMatch(setupSh, /SKILLS_CN|skills-cn/, 'setup.sh must not copy skills-cn');

  // 全仓扫描：只允许 CONTRIBUTING.md 里的规格句/历史示例提到 skills-cn。
  const offenders = [];
  const skipDirs = new Set(['.git', 'node_modules', 'app', 'data', '.claude', 'dist']);
  const allowedFiles = new Set([
    join('CONTRIBUTING.md'),
    join('tests', 'windows-launchers.test.mjs'),
  ]);
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(join(dir, entry.name), join(rel, entry.name));
        continue;
      }
      if (!/\.(md|mjs|js|json|sh|ps1|bat|command|html|yml|yaml|txt)$/.test(entry.name)) continue;
      const relPath = join(rel, entry.name);
      if (allowedFiles.has(relPath)) continue;
      let content = '';
      try { content = readFileSync(join(dir, entry.name), 'utf8'); } catch { continue; }
      if (content.includes('skills-cn')) offenders.push(relPath);
    }
  };
  walk(repoRoot, '');
  assert.deepEqual(offenders, [], `skills-cn path references must be gone: ${offenders.join(', ')}`);
});

// cmd.exe treats ')' as the end of an IF/FOR ( ... ) block, so an unescaped paren in
// an `echo` *inside* a block aborts parsing ("was unexpected at this time") and the
// window flash-closes. This shipped once in v2.1.10 (echo Direct-connect (NO_PROXY)).
// Track block depth structurally and flag any unescaped ( or ) in echoes inside a block.
function unescapedParenEchoesInsideBlocks(bat) {
  const offenders = [];
  let depth = 0;
  for (const raw of bat.split(/\r?\n/)) {
    const line = raw.trim();
    if (depth > 0 && /^echo\b/i.test(line)) {
      // cmd eats an unescaped ')' that sits at the END of an echo (cosmetic: the ')'
      // just disappears). The flash-exit only happens when a ')' is followed by more
      // text on the line (e.g. "(NO_PROXY): value" → ')' closes the block, ": value"
      // then errors). So: drop escaped ^), drop trailing ')'/whitespace, and flag any
      // ')' that survives (meaning it had text after it).
      let s = line.replace(/\^\)/g, '').replace(/[)\s]+$/, '');
      if (s.includes(')')) offenders.push(raw.trim());
    }
    // structural depth: ') else (' keeps depth; leading ')' closes; if/for line ending in '(' opens
    if (/^\)\s*else\b.*\($/i.test(line)) { /* same depth */ }
    else if (/^\)/.test(line)) depth = Math.max(0, depth - 1);
    if (/^\($/.test(line) || /\b(if|for)\b.*[^^]\(\s*$/i.test(line)) depth += 1;
  }
  return offenders;
}

test('Windows launchers have no unescaped parens in echoes inside IF/FOR blocks (v2.1.10 flash-exit regression)', () => {
  for (const name of [
    'Windows-Start.bat',
    'Windows-IntranetFix.bat',
    'OpenClaw-Doctor.bat',
    'Windows-Diagnose.bat',
    'Windows-Maintain.bat',
    'Windows-Install.bat',
  ]) {
    const bat = readRepoFile('portable', name);
    const offenders = unescapedParenEchoesInsideBlocks(bat);
    assert.deepEqual(offenders, [], `${name} has unescaped parens in block echo(es): ${offenders.join(' | ')}`);
  }
});

test('PowerShell installer generated start.bat disables OpenClaw bonjour discovery', () => {
  const script = readRepoFile('install', 'install.ps1');

  assert.match(script, /\$startBat = @'/);
  assert.match(
    script,
    /set "OPENCLAW_DISABLE_BONJOUR=1"/,
    'generated start.bat should disable bonjour discovery',
  );
});
