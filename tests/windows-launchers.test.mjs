import { readFileSync } from 'node:fs';
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
    'Windows-Menu.bat',
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

test('Windows startup only auto-opens Config Center when no model is configured (issue #24)', () => {
  // Previously Windows-Start.bat force-opened Config Center on every launch,
  // even for returning users who already picked a model -- that's the "config
  // page pops up every single time I start it" complaint in issue #24. This
  // replaced the old "always open Config Center" behavior below with the
  // design documented in the repo CLAUDE.md: first run (no model configured)
  // opens Config Center; configured runs land on the Dashboard only. The
  // config-server itself still always starts, and Windows-Menu.bat still
  // offers the setup wizard, so Config Center remains reachable manually.
  const script = readRepoFile('portable', 'Windows-Start.bat');

  assert.match(
    script,
    /lib\\check-model-configured\.mjs/,
    'should consult the model-configured helper before deciding whether to auto-open Config Center',
  );
  assert.match(
    script,
    /if "%MODEL_CONFIGURED%"=="1" \([\s\S]*\) else \([\s\S]*start "" http:\/\/127\.0\.0\.1:%CONFIG_PORT%\/[\s\S]*\)/,
    'Config Center should only auto-open in the "not configured" branch',
  );
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
    'Windows-IntranetFix.bat',
    'Windows-LocalModel.bat',
    'OpenClaw-Doctor.bat',
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
    'Mac-IntranetFix.command',
    'Mac-LocalModel.command',
    'Mac-OpenClaw-Doctor.command',
  ]) {
    const bytes = readFileSync(join(repoRoot, 'portable', name));
    const cr = bytes.indexOf(0x0d);
    assert.equal(cr, -1, `${name} has a CR byte at offset ${cr} (must be LF-only)`);
    assert.ok(bytes.toString('utf8').startsWith('#!/bin/bash'), `${name} must start with a clean shebang`);
  }
});

test('macOS local-model / intranet launchers call the shared cross-platform scripts', () => {
  assert.match(readRepoFile('portable', 'Mac-IntranetFix.command'), /lib\/intranet-check\.mjs/);
  assert.match(readRepoFile('portable', 'Mac-LocalModel.command'), /lib\/setup-local-model\.mjs/);
  assert.match(readRepoFile('portable', 'Mac-OpenClaw-Doctor.command'), /doctor --non-interactive/);
});

test('local-model setup launcher calls setup-local-model.mjs', () => {
  const bat = readRepoFile('portable', 'Windows-LocalModel.bat');
  assert.match(bat, /lib\\setup-local-model\.mjs/);
});

test('portable menus expose a CLI terminal entry point (issue #53)', () => {
  // Windows-Menu.bat and Mac-Menu.command are the only menus most users ever
  // see (Windows-Start.bat / Mac-Start.command only open the web UI); before
  // this the standalone OpenClaw-CLI.bat / Mac-OpenClaw-CLI.command existed
  // but had no entry in either menu, so users assumed U-Claw was "web only"
  // (issue #53). Both menus must offer a way to launch them.
  const winMenu = readRepoFile('portable', 'Windows-Menu.bat');
  assert.match(winMenu, /goto :clitool/, 'Windows-Menu.bat menu choice should route to a CLI entry');
  assert.match(winMenu, /:clitool[\s\S]*OpenClaw-CLI\.bat/, 'Windows-Menu.bat should launch OpenClaw-CLI.bat');

  const macMenu = readRepoFile('portable', 'Mac-Menu.command');
  assert.match(macMenu, /do_cli/, 'Mac-Menu.command should have a CLI menu action');
  assert.match(macMenu, /Mac-OpenClaw-CLI\.command/, 'Mac-Menu.command should launch Mac-OpenClaw-CLI.command');
});

test('OpenClaw doctor launcher is read-only (no destructive repair flags)', () => {
  const bat = readRepoFile('portable', 'OpenClaw-Doctor.bat');
  assert.match(bat, /OPENCLAW_MJS%" doctor --non-interactive/);
  // Must not auto-apply repairs that could overwrite user config/state.
  assert.doesNotMatch(bat, /doctor[^\n]*--fix/);
  assert.doesNotMatch(bat, /doctor[^\n]*--repair/);
  assert.doesNotMatch(bat, /doctor[^\n]*--force/);
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
    'Windows-LocalModel.bat',
    'OpenClaw-Doctor.bat',
    'Windows-Diagnose.bat',
    'Windows-Menu.bat',
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

test('Electron desktop launcher disables OpenClaw bonjour discovery on Windows only', () => {
  const source = readRepoFile('u-claw-app', 'src', 'main.js');

  assert.match(
    source,
    /if\s*\(\s*process\.platform\s*===\s*['"]win32['"]\s*\)\s*{[\s\S]*?env\.OPENCLAW_DISABLE_BONJOUR\s*=\s*['"]1['"]/,
  );
  assert.doesNotMatch(
    source,
    /OPENCLAW_DISABLE_BONJOUR:\s*['"]1['"]/,
    'bonjour disable flag should not be in the unconditional env object',
  );
});
