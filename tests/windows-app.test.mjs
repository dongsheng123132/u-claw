import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(...parts) {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

test('Windows-App.bat is pure ASCII with CRLF line endings', () => {
  const bytes = readFileSync(join(repoRoot, 'portable', 'Windows-App.bat'));
  const offending = bytes.findIndex((b) => b > 0x7f);
  assert.equal(offending, -1, `non-ASCII byte at offset ${offending}`);
  assert.ok(bytes.includes(0x0d), 'Windows-App.bat must use CRLF line endings');
});

test('open-app.ps1 is pure ASCII with CRLF line endings', () => {
  const bytes = readFileSync(join(repoRoot, 'portable', 'lib', 'open-app.ps1'));
  const offending = bytes.findIndex((b) => b > 0x7f);
  assert.equal(offending, -1, `non-ASCII byte at offset ${offending}`);
  assert.ok(bytes.includes(0x0d), 'open-app.ps1 must use CRLF line endings');
});

test('Windows-App.bat runs headless and delegates Edge mode to the shared open-app.ps1', () => {
  const bat = readRepoFile('portable', 'Windows-App.bat');
  assert.match(bat, /set "UCLAW_HEADLESS=1"/, 'wrapper must stop Windows-Start.bat from opening its own browser');
  assert.match(bat, /lib\\open-app\.ps1" -Mode edge/, 'wrapper must delegate to open-app.ps1 in edge mode');
  assert.doesNotMatch(bat, /(?:call|start)\s.*Windows-Start\.bat/, 'wrapper must not start Windows-Start.bat directly');
});

test('open-app.ps1 starts Windows-Start.bat only when the gateway is not ready', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /Windows-Start\.bat/);
  assert.match(ps, /Test-GatewayReady/);
  assert.match(ps, /if \(\$Port -and \(Test-GatewayReady \$Port\)\)/, 'reuse a live gateway before starting the launcher');
  assert.match(ps, /Start-WindowsStartBat/);
  assert.match(ps, /cmd \/c ""/, 'Windows-Start.bat must launch in its own console');
});

test('open-app.ps1 reads the actual gatewayPort from runtime.json and never guesses', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /runtime\.json/);
  assert.match(ps, /gatewayPort/);
  assert.match(ps, /Get-GatewayPortFromRuntime/);
  assert.doesNotMatch(ps, /18789/, 'must not hardcode a guessed gateway port');
});

test('open-app.ps1 validates /ready as JSON shape, not arbitrary HTML', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /\/ready/);
  assert.match(ps, /Invoke-RestMethod/);
  assert.match(ps, /\.ready\b/);
  assert.match(ps, /\.failing\b/);
  assert.match(ps, /\.uptimeMs\b/);
  assert.match(ps, /\.eventLoop\b/);
  assert.doesNotMatch(ps, /Invoke-WebRequest/, 'must parse /ready as JSON, not HTML');
});

test('open-app.ps1 locates Edge in standard host paths and falls back to the default browser', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /ProgramFiles\(x86\)/);
  assert.match(ps, /Microsoft\\Edge\\Application\\msedge\.exe/);
  assert.match(ps, /LOCALAPPDATA/);
  assert.match(ps, /Start-Process -FilePath \$Url/, 'default browser fallback');
});

test('open-app.ps1 keeps the browser profile under LOCALAPPDATA U-Claw with a stable path-hash slot', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /Join-Path \(Join-Path \$LocalAppData 'U-Claw'\) \$Slot/);
  assert.match(ps, /SHA256/);
  assert.match(ps, /ToLowerInvariant\(\)/, 'slot must derive from the normalized absolute root');
  assert.match(ps, /Substring\(0, 16\)/);
  assert.match(ps, /user-data-dir/);
  assert.match(ps, /GetTempPath\(\).*'U-Claw'/, 'never fall back to the USB drive for the profile');
});

test('open-app.ps1 quotes arguments for spaces and ampersands for CreateProcess', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /Quote-CliArg/);
  assert.match(ps, /\[\\s&\]/, 'must quote values containing spaces or ampersands');
  assert.match(ps, /UseShellExecute = \$false/, 'pass args straight to CreateProcess, never through cmd');
});

test('open-app.ps1 supports -Mode webview calling app/shell/U-Claw-Shell.exe with url and cache path', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /\[ValidateSet\('edge', 'webview'\)\]/);
  assert.match(ps, /app\\shell\\U-Claw-Shell\.exe/);
  assert.match(ps, /\(Quote-CliArg \$Url\) \+ ' ' \+ \(Quote-CliArg \$UserDataDir\)/, 'shell takes positional <url> <cache-dir> args');
  assert.match(ps, /'webview'/);
});

test('open-app.ps1 accepts the -Root argument Windows-WebView.bat passes', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /\[string\]\$Root/, '-Root parameter must exist for Windows-WebView.bat');
  assert.match(ps, /GetFullPath\(\$Root\)/, 'Root must resolve to the absolute portable root');
});

test('open-app.ps1 waits a bounded time for the gateway before opening the app', () => {
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  assert.match(ps, /ReadyTimeoutSeconds/);
  assert.match(ps, /AddSeconds\(/);
  assert.match(ps, /Start-Sleep -Seconds 1/);
});

test('the app launcher performs no auto-downloads and touches no backend', () => {
  const bat = readRepoFile('portable', 'Windows-App.bat');
  const ps = readRepoFile('portable', 'lib', 'open-app.ps1');
  for (const [name, src] of [['Windows-App.bat', bat], ['open-app.ps1', ps]]) {
    assert.doesNotMatch(
      src,
      /\birm\b|Invoke-WebRequest|bitsadmin|Start-BitsTransfer|curl\.exe/i,
      `${name} must not download anything`,
    );
  }
  assert.doesNotMatch(ps, /setup\.bat|setup\.ps1/, 'must not trigger runtime setup/downloads');
});
