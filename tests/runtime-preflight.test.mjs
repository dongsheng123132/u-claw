import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsNode, validateRuntime } from '../portable/lib/runtime-preflight.mjs';
import { readFileSync } from 'node:fs';

test('new runtime rejects old Node and the unsupported Node 25 branch', () => {
  for (const version of ['22.22.3','24.15.9','25.9.0','26.0.9','bad']) assert.equal(supportsNode(version), false, version);
  for (const version of ['v24.16.0','24.17.0','26.1.0','27.0.0']) assert.equal(supportsNode(version), true, version);
});
test('Windows filesystem and runtime mismatch fail before state creation', () => {
  const valid = { nodeVersion:'24.16.0', expected:'2026.10.2', installed:'2026.10.2', platform:'win32', filesystem:'NTFS' };
  assert.doesNotThrow(() => validateRuntime(valid));
  for (const filesystem of ['exFAT','FAT32',undefined]) assert.throws(() => validateRuntime({...valid,filesystem}), /requires NTFS/);
  assert.throws(() => validateRuntime({...valid,installed:'2026.9.2'}), /version mismatch/);
  assert.doesNotThrow(() => validateRuntime({...valid,platform:'darwin',filesystem:'APFS'}));
  assert.throws(() => validateRuntime({...valid,arch:'x64',installedPlatform:'darwin-arm64'}), /platform mismatch/);
  assert.doesNotThrow(() => validateRuntime({...valid,arch:'x64',installedPlatform:'win32-x64'}));
});
test('locked runtime matches both public pins and declares a supported Node engine', () => {
  const read = name => readFileSync(new URL('../'+name, import.meta.url),'utf8');
  const pin=read('OPENCLAW_VERSION').trim();
  assert.equal(read('portable/OPENCLAW_VERSION').trim(),pin);
  assert.equal(JSON.parse(read('portable/runtime-package.json')).dependencies.openclaw,pin);
  const lock=JSON.parse(read('portable/runtime-package-lock.json'));
  assert.equal(lock.packages['node_modules/openclaw'].version,pin);
  assert.equal(lock.packages['node_modules/openclaw'].engines.node,'>=24.16.0 <25 || >=26.1.0');
  assert.ok(lock.packages['node_modules/@openclaw/fs-safe-win32-x64-msvc'], 'Windows native filesystem module must be locked');
});
