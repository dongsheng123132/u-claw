import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPort, readPorts, main } from '../portable/lib/runtime-ports.mjs';

function fixtureStateDir() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-runtime-ports-'));
  const stateDir = join(root, 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

test('publishPort writes gatewayPort without touching an existing configServerPort', () => {
  const stateDir = fixtureStateDir();
  assert.equal(publishPort(stateDir, 'configServer', 18788), true);
  assert.equal(publishPort(stateDir, 'gateway', 18790), true);
  assert.deepEqual(readPorts(stateDir), { configServerPort: 18788, gatewayPort: 18790 });
});

test('publishPort merges instead of clobbering when called in either order', () => {
  const stateDir = fixtureStateDir();
  assert.equal(publishPort(stateDir, 'gateway', 18790), true);
  assert.equal(publishPort(stateDir, 'configServer', 18787), true);
  assert.deepEqual(readPorts(stateDir), { configServerPort: 18787, gatewayPort: 18790 });
});

test('publishPort overwrites only its own role on republish (port re-selected after conflict)', () => {
  const stateDir = fixtureStateDir();
  publishPort(stateDir, 'gateway', 18789);
  publishPort(stateDir, 'configServer', 18788);
  publishPort(stateDir, 'gateway', 18791); // e.g. relaunch after 18789 got squatted
  assert.deepEqual(readPorts(stateDir), { configServerPort: 18788, gatewayPort: 18791 });
});

test('publishPort writes atomically (no leftover tmp files, real file has final content)', () => {
  const stateDir = fixtureStateDir();
  publishPort(stateDir, 'gateway', 18790);
  const raw = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
  assert.equal(raw.gatewayPort, 18790);
  assert.equal(typeof raw.gatewayPortUpdatedAt, 'string');
});

test('publishPort rejects bad input silently (non-integer port, unknown role, missing stateDir)', () => {
  const stateDir = fixtureStateDir();
  assert.equal(publishPort(stateDir, 'gateway', 'not-a-port'), false);
  assert.equal(publishPort(stateDir, 'gateway', -1), false);
  assert.equal(publishPort(stateDir, 'gateway', 0), false);
  assert.equal(publishPort(stateDir, 'bogusRole', 18789), false);
  assert.equal(publishPort('', 'gateway', 18789), false);
  assert.equal(publishPort(undefined, 'gateway', 18789), false);
});

test('readPorts on a missing runtime.json returns nulls instead of throwing', () => {
  const stateDir = fixtureStateDir();
  assert.deepEqual(readPorts(stateDir), { configServerPort: null, gatewayPort: null });
});

test('readPorts on a corrupt runtime.json returns nulls instead of throwing (v2.2.0 must-not-guess)', () => {
  const stateDir = fixtureStateDir();
  writeFileSync(join(stateDir, 'runtime.json'), '{ this is not json');
  assert.deepEqual(readPorts(stateDir), { configServerPort: null, gatewayPort: null });
});

test('readPorts ignores non-integer fields left by a foreign writer', () => {
  const stateDir = fixtureStateDir();
  writeFileSync(join(stateDir, 'runtime.json'), JSON.stringify({ gatewayPort: '18789', configServerPort: null }));
  assert.deepEqual(readPorts(stateDir), { configServerPort: null, gatewayPort: null });
});

test('publishPort never throws even if the directory cannot be created (silent-failure contract)', () => {
  // Point stateDir at a path whose parent is a file, not a directory -- mkdirSync must fail.
  const root = mkdtempSync(join(tmpdir(), 'uclaw-runtime-ports-'));
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const stateDir = join(blocker, 'data', '.openclaw');
  assert.doesNotThrow(() => {
    assert.equal(publishPort(stateDir, 'gateway', 18789), false);
  });
});

test('CLI publish/read round-trip prints UCLAW_CONFIG_PORT / UCLAW_GATEWAY_PORT lines', () => {
  const stateDir = fixtureStateDir();
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    assert.equal(main(['node', 'runtime-ports.mjs', 'publish', stateDir, 'gateway', '18792']), 0);
    assert.equal(main(['node', 'runtime-ports.mjs', 'read', stateDir]), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  const out = chunks.join('');
  assert.match(out, /UCLAW_CONFIG_PORT=\n/);
  assert.match(out, /UCLAW_GATEWAY_PORT=18792\n/);
});

test('CLI publish is silent-fail (exit 0) even with a bad port argument', () => {
  const stateDir = fixtureStateDir();
  assert.equal(main(['node', 'runtime-ports.mjs', 'publish', stateDir, 'gateway', 'nope']), 0);
});

test('CLI with an unknown command returns a non-zero exit code', () => {
  const stateDir = fixtureStateDir();
  assert.notEqual(main(['node', 'runtime-ports.mjs', 'bogus', stateDir]), 0);
});
