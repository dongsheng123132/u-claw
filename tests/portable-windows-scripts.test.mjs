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

test('Windows launchers disable OpenClaw bonjour discovery to avoid Windows ciao crash', () => {
  const startScript = readRepoFile('portable', 'Windows-Start.bat');
  const menuScript = readRepoFile('portable', 'Windows-Menu.bat');
  const installScript = readRepoFile('portable', 'Windows-Install.bat');

  assert.match(startScript, /set "OPENCLAW_DISABLE_BONJOUR=1"/);
  assert.match(menuScript, /set "OPENCLAW_DISABLE_BONJOUR=1"/);
  assert.match(installScript, /OPENCLAW_DISABLE_BONJOUR=1/);
});
