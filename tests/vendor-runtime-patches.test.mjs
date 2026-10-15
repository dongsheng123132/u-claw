import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { copyDirSync } from '../portable/lib/copy-dir.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = process.env.UCLAW_TEST_CORE_DIR;

test('reviewed vendor patches preserve pairing files through transient rename errors', { skip: !core }, async t => {
  const scratch = fs.mkdtempSync(join(tmpdir(), 'uclaw-vendor-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const fixture = join(scratch, 'core');
  fs.mkdirSync(join(fixture, 'node_modules/openclaw/dist'), { recursive: true });
  fs.copyFileSync(join(core, 'node_modules/openclaw/package.json'), join(fixture, 'node_modules/openclaw/package.json'));
  fs.copyFileSync(join(core, 'node_modules/openclaw/dist/chrome-D7PwFEoa.mjs'), join(fixture, 'node_modules/openclaw/dist/chrome-D7PwFEoa.mjs'));
  copyDirSync(join(core, 'node_modules/@openclaw/fs-safe'), join(fixture, 'node_modules/@openclaw/fs-safe'));
  const runPatch = name => spawnSync(process.execPath, [join(root, 'portable/lib', name), fixture], { encoding: 'utf8', timeout: 10000 });
  for (const patch of ['patch-managed-browser-root.mjs', 'patch-device-pairing-retry.mjs']) {
    let result = runPatch(patch);
    assert.equal(result.status, 0, result.stderr);
    result = runPatch(patch);
    assert.equal(result.status, 0, 're-running setup must accept the reviewed patched output: ' + result.stderr);
  }
  const { replaceFileAtomic, replaceFileAtomicSync } = await import(pathToFileURL(join(fixture, 'node_modules/@openclaw/fs-safe/dist/replace-file.js')).href);
  const devices = join(scratch, 'devices');
  fs.mkdirSync(devices);
  const paired = join(devices, 'paired.json');
  fs.writeFileSync(paired, 'original');

  await t.test('async pairing rename retries EPERM and publishes atomically', async () => {
    let attempts = 0;
    const promises = { ...fsp, rename: async (...args) => { if (++attempts <= 2) throw Object.assign(new Error('held'), { code: 'EPERM' }); return fsp.rename(...args); } };
    const result = await replaceFileAtomic({ filePath: paired, content: 'async', fileSystem: { ...fs, promises }, copyFallbackOnPermissionError: true });
    assert.equal(attempts, 3);
    assert.equal(result.method, 'rename');
    assert.equal(fs.readFileSync(paired, 'utf8'), 'async');
  });
  await t.test('sync pairing rename retries ENOTEMPTY', () => {
    let attempts = 0;
    const fileSystem = { ...fs, renameSync: (...args) => { if (++attempts <= 1) throw Object.assign(new Error('held'), { code: 'ENOTEMPTY' }); return fs.renameSync(...args); } };
    const result = replaceFileAtomicSync({ filePath: paired, content: 'sync', fileSystem });
    assert.equal(attempts, 2);
    assert.equal(result.method, 'rename');
  });
  await t.test('permanent pairing failure keeps the last good content', async () => {
    let attempts = 0;
    const promises = { ...fsp, rename: async () => { attempts++; throw Object.assign(new Error('held'), { code: 'EPERM' }); } };
    await assert.rejects(replaceFileAtomic({ filePath: paired, content: 'lost', fileSystem: { ...fs, promises }, copyFallbackOnPermissionError: true }), { code: 'EPERM' });
    assert.equal(attempts, 5);
    assert.equal(fs.readFileSync(paired, 'utf8'), 'sync');
  });
  await t.test('ordinary state files keep upstream retry behavior', async () => {
    let attempts = 0;
    const promises = { ...fsp, rename: async () => { attempts++; throw Object.assign(new Error('held'), { code: 'EPERM' }); } };
    await assert.rejects(replaceFileAtomic({ filePath: join(scratch, 'settings.json'), content: '{}', fileSystem: { ...fs, promises } }), { code: 'EPERM' });
    assert.equal(attempts, 1);
  });
  await t.test('unexpected input is refused without a write', () => {
    const bundle = join(fixture, 'node_modules/openclaw/dist/chrome-D7PwFEoa.mjs');
    fs.appendFileSync(bundle, '\n// unreviewed drift\n');
    const before = fs.readFileSync(bundle, 'utf8');
    const result = runPatch('patch-managed-browser-root.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected input SHA-256/);
    assert.equal(fs.readFileSync(bundle, 'utf8'), before);
  });
});
