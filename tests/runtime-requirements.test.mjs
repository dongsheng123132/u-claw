import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { supportsNode, needsSetup } from '../portable/lib/runtime-requirements.mjs';

test('runtime gate enforces the complete OpenClaw Node engine boundaries', () => {
  for (const version of ['v24.16.0', '24.19.0', '26.1.0', '27.0.0']) {
    assert.equal(supportsNode(version), true, version);
  }
  for (const version of ['22.22.3', '23.9.0', '24.15.9', '25.9.0', '26.0.9', 'unknown']) {
    assert.equal(supportsNode(version), false, version);
  }
});

test('existing portable folder upgrades missing, stale or incompatible runtime', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'uclaw-runtime-gate-'));
  try {
    fs.writeFileSync(path.join(root, 'OPENCLAW_VERSION'), '2026.10.2\n');
    assert.equal(needsSetup(root, '24.16.0'), true);
    const packageDir = path.join(root, 'app/core/node_modules/openclaw');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '2026.9.2' }));
    assert.equal(needsSetup(root, '24.16.0'), true);
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '2026.10.2' }));
    assert.equal(needsSetup(root, '24.16.0'), true, 'unverified platform must repair its optional dependencies');
    fs.writeFileSync(path.join(root, 'app/core/.uclaw-runtime-platform'), `${process.platform}-${process.arch}`);
    assert.equal(needsSetup(root, '24.16.0'), false);
    assert.equal(needsSetup(root, '24.16.0', 'different-platform'), true);
    assert.equal(needsSetup(root, '22.22.3'), true);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
