import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchPortableFilesystem } from '../portable/lib/patch-portable-filesystem.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = process.env.UCLAW_TEST_CORE_DIR || path.join(repo, '.download-cache/smoke-windows/app/core');
const available = fs.existsSync(path.join(core, 'node_modules/openclaw/package.json'));
const shimName = 'openclaw-cli-shim-I4WwJOH3.mjs';
const stabilityName = 'diagnostic-stability-bundle-vmtXgIWw.mjs';
const dist = path.join(core, 'node_modules/openclaw/dist');
const guards = ['strict-file-identity.js', 'root-file-final-admission.js'];
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'uclaw-filesystem-patch-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const target = path.join(scratch, 'core');
  for (const name of [shimName, stabilityName]) {
    const destination = path.join(target, 'node_modules/openclaw/dist', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(dist, name), destination);
  }
  for (const packageName of ['openclaw', '@openclaw/fs-safe']) {
    const destination = path.join(target, 'node_modules', packageName, 'package.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(core, 'node_modules', packageName, 'package.json'), destination);
  }
  for (const name of guards) {
    const destination = path.join(target, 'node_modules/@openclaw/fs-safe/dist', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(core, 'node_modules/@openclaw/fs-safe/dist', name), destination);
  }
  return { scratch, target, modulePath: name => path.join(target, 'node_modules/openclaw/dist', name) };
}

function importVendorModule(source, { platform, flag, calls }) {
  const hook = `__uclawFilesystemCalls${Math.random().toString(36).slice(2)}`;
  globalThis[hook] = calls;
  const syncApi = dataModule(`export function replaceFileAtomicSync(options) { globalThis[${JSON.stringify(hook)}].push({api:'sync',options}); }`);
  const asyncApi = dataModule(`export async function m(filePath,content,options) { globalThis[${JSON.stringify(hook)}].push({api:'async',filePath,content,options}); }`);
  const mockProcess = dataModule(`export default new Proxy(globalThis.process,{get(target,key){if(key==='platform')return ${JSON.stringify(platform)};if(key==='env')return {...target.env,OPENCLAW_PORTABLE_RENAME_IDENTITY:${JSON.stringify(flag)}};return Reflect.get(target,key);}});`);
  source = source.replace(/(from\s+|import\s+)("\.\/[^"\n]+")/g, (_whole, lead, quoted) => {
    const relative = JSON.parse(quoted);
    return `${lead}${JSON.stringify(pathToFileURL(path.join(dist, relative)).href)}`;
  });
  source = source.replace(/from "@openclaw\/fs-safe\/atomic"/g, () => `from ${JSON.stringify(syncApi)}`);
  source = source.replace(/from "[^"\n]*json-files-C5mNTScg\.mjs"/, () => `from ${JSON.stringify(asyncApi)}`);
  if (source.includes('import process from "node:process";')) {
    source = source.replace('import process from "node:process";', () => `import process from ${JSON.stringify(mockProcess)};`);
  } else {
    source = `import process from ${JSON.stringify(mockProcess)};\n${source}`;
  }
  return { module: import(dataModule(source)), cleanup: () => delete globalThis[hook] };
}

test('portable filesystem patch accepts only reviewed versions and exact complete source', { skip: !available }, async t => {
  await t.test('both modules patch once; repeated patch is identical and identity guards are untouched', () => {
    const f = fixture(t);
    const beforeGuards = guards.map(name => fs.readFileSync(path.join(f.target, 'node_modules/@openclaw/fs-safe/dist', name)));
    const wasPatched = [shimName, stabilityName].map(name => fs.readFileSync(f.modulePath(name), 'utf8').includes('OPENCLAW_PORTABLE_RENAME_IDENTITY'));
    const first = patchPortableFilesystem(f.target);
    assert.deepEqual(first.map(value => value.alreadyPatched), wasPatched);
    const after = [shimName, stabilityName].map(name => fs.readFileSync(f.modulePath(name)));
    const second = patchPortableFilesystem(f.target);
    assert.deepEqual(second.map(value => value.alreadyPatched), [true, true]);
    assert.deepEqual(second.map(value => value.sha256), first.map(value => value.sha256));
    [shimName, stabilityName].forEach((name, i) => assert.deepEqual(fs.readFileSync(f.modulePath(name)), after[i]));
    guards.forEach((name, i) => assert.deepEqual(fs.readFileSync(path.join(f.target, 'node_modules/@openclaw/fs-safe/dist', name)), beforeGuards[i]));
  });
  await t.test('drift in the second module refuses both writes', () => {
    const f = fixture(t);
    fs.appendFileSync(f.modulePath(stabilityName), '\n// unexpected vendor change\n');
    const before = [shimName, stabilityName].map(name => fs.readFileSync(f.modulePath(name)));
    assert.throws(() => patchPortableFilesystem(f.target), /unexpected input SHA-256/);
    [shimName, stabilityName].forEach((name, i) => assert.deepEqual(fs.readFileSync(f.modulePath(name)), before[i]));
  });
  await t.test('partially patched or edited patched source is refused', () => {
    const f = fixture(t);
    patchPortableFilesystem(f.target);
    const full = fs.readFileSync(f.modulePath(shimName), 'utf8');
    for (const edited of [full.replace('import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";\n', ''), full + '\n// altered output\n']) {
      fs.writeFileSync(f.modulePath(shimName), edited);
      assert.throws(() => patchPortableFilesystem(f.target), /unexpected input SHA-256/);
      assert.equal(fs.readFileSync(f.modulePath(shimName), 'utf8'), edited);
    }
  });
  await t.test('unsupported OpenClaw or fs-safe version refuses before writes', () => {
    for (const packageName of ['openclaw', '@openclaw/fs-safe']) {
      const f = fixture(t);
      const file = path.join(f.target, 'node_modules', packageName, 'package.json');
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...json, version: '999.0.0' }));
      const before = fs.readFileSync(f.modulePath(shimName));
      assert.throws(() => patchPortableFilesystem(f.target), /expected (OpenClaw|fs-safe)/);
      assert.deepEqual(fs.readFileSync(f.modulePath(shimName)), before);
    }
  });
});

test('reviewed shim and stability modules opt in only on Windows with exact verified policy', { skip: !available }, async t => {
  const f = fixture(t);
  patchPortableFilesystem(f.target);
  const shim = fs.readFileSync(f.modulePath(shimName), 'utf8');
  const stability = fs.readFileSync(f.modulePath(stabilityName), 'utf8');
  for (const [platform, flag, expected] of [['win32', 'verify-content-with-lock', 'sync'], ['win32', undefined, 'async'], ['win32', 'true', 'async'], ['darwin', 'verify-content-with-lock', 'async']]) {
    await t.test(`shim ${platform}/${flag ?? 'unset'} selects ${expected}`, async () => {
      const calls = [];
      const loaded = importVendorModule(shim, { platform, flag, calls });
      try {
        const api = await loaded.module;
        await api.r({ stateDir: path.join(f.scratch, `${platform}-${expected}-${flag ?? 'unset'}`), env: {}, platform: 'win32', invocation: { command: 'fixture-node', args: ['fixture-openclaw.mjs'] } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].api, expected);
        const call = calls[0];
        assert.match(call.options.tempPrefix, /^openclaw-agent-cli$/);
        assert.equal(call.options.mode, 448);
        assert.equal(call.options.dirMode, 448);
        if (expected === 'sync') {
          assert.equal(call.options.renameIdentity, 'verify-content-with-lock');
          assert.equal(call.options.copyFallbackOnPermissionError, true);
          assert.equal(call.options.syncTempFile, false);
          assert.equal(call.options.syncParentDir, false);
          assert.match(call.options.filePath, /openclaw\.cmd$/);
          assert.match(call.options.content, /fixture-openclaw\.mjs/);
        } else {
          assert.deepEqual(call.options, { mode: 448, dirMode: 448, durable: false, tempPrefix: 'openclaw-agent-cli' });
        }
      } finally { loaded.cleanup(); }
    });
  }
  for (const [platform, flag, expected] of [['win32', 'verify-content-with-lock', 'verify-content-with-lock'], ['win32', undefined, 'strict'], ['darwin', 'verify-content-with-lock', 'strict']]) {
    await t.test(`stability ${platform}/${flag ?? 'unset'} selects ${expected}`, async () => {
      const calls = [];
      const loaded = importVendorModule(stability, { platform, flag, calls });
      try {
        const api = await loaded.module;
        const result = api.c({ stateDir: f.scratch, reason: 'fixture.failure', includeEmpty: true, error: new Error('fixture error'), now: new Date('2026-10-13T00:00:00Z') });
        assert.equal(result.status, 'written', String(result.error));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.renameIdentity, expected);
        assert.equal(calls[0].options.mode, 384);
        assert.equal(calls[0].options.dirMode, 448);
        assert.equal(calls[0].options.tempPrefix, '.openclaw-stability');
        assert.equal(JSON.parse(calls[0].options.content).reason, 'fixture.failure');
      } finally { loaded.cleanup(); }
    });
  }
});

test('official locked synchronous atomic API keeps content verification and lock cleanup', { skip: !available }, async t => {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'uclaw-official-atomic-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const { replaceFileAtomicSync } = await import(pathToFileURL(path.join(core, 'node_modules/@openclaw/fs-safe/dist/replace-file.js')).href);
  const target = path.join(scratch, 'fixture.json');
  replaceFileAtomicSync({ filePath: target, content: 'expected', renameIdentity: 'verify-content-with-lock', syncTempFile: true, syncParentDir: true, destinationHardlinks: 'reject' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'expected');
  const fileSystem = { ...fs, renameSync(source, destination) {
    fs.renameSync(source, destination);
    fs.unlinkSync(destination);
    fs.writeFileSync(destination, 'different content');
  } };
  assert.throws(() => replaceFileAtomicSync({ filePath: target, content: 'requested', renameIdentity: 'verify-content-with-lock', fileSystem }), error => error.code === 'path-mismatch' && /published content changed/.test(error.message));
  assert.equal(fs.readFileSync(target, 'utf8'), 'different content', 'refusal must not roll back an unowned publication');
  assert.equal(fs.readdirSync(scratch).some(name => name.endsWith('.lock')), false);
});
