import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { probeRenameIdentity } from '../portable/lib/portable-filesystem.mjs';

test('identity probe preserves existing data and cleans its own generated files', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'uclaw-fs-probe-test-'));
  try {
    const sentinel = Buffer.from('existing user data');
    await fs.writeFile(path.join(root, 'existing.json'), sentinel);
    const result = await probeRenameIdentity(root);
    assert.ok(['strict', 'verify-content-with-lock'].includes(result.mode));
    assert.deepEqual(await fs.readFile(path.join(root, 'existing.json')), sentinel);
    assert.deepEqual(await fs.readdir(root), ['existing.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unsupported platforms and unavailable storage keep the strict policy', async () => {
  assert.equal((await probeRenameIdentity('unused-path', 'darwin')).mode, 'strict');
  const root = await fs.mkdtemp(path.join(tmpdir(), 'uclaw-fs-unavailable-'));
  try {
    const file = path.join(root, 'not-a-directory');
    await fs.writeFile(file, 'preserve');
    assert.equal((await probeRenameIdentity(file, 'win32')).mode, 'strict');
    assert.equal(await fs.readFile(file, 'utf8'), 'preserve');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
