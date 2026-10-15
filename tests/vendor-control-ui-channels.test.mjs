import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { patchControlUiChannels, UI_PATCHES } from '../portable/lib/patch-control-ui-channels.mjs';

const core = process.env.UCLAW_TEST_CORE_DIR;
test('channel entry points and extra provider navigation disappear while wallet setup uses the native host', { skip: !core }, t => {
  const scratch = fs.mkdtempSync(join(tmpdir(), 'uclaw-ui-patch-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const openclaw = join(scratch, 'node_modules/openclaw');
  const assets = join(openclaw, 'dist/control-ui/assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(join(core, 'node_modules/openclaw/package.json'), join(openclaw, 'package.json'));
  for (const name of ['asset-manifest.json', 'sw.js', 'sw.js.gz', 'sw.js.br']) {
    const file = join(core, 'node_modules/openclaw/dist/control-ui', name);
    if (fs.existsSync(file)) fs.copyFileSync(file, join(openclaw, 'dist/control-ui', name));
  }
  const original = new Map();
  for (const patch of UI_PATCHES) {
    for (const suffix of ['', '.gz', '.br']) {
      const name = patch.file + suffix;
      const file = join(core, 'node_modules/openclaw/dist/control-ui/assets', name);
      if (fs.existsSync(file)) { fs.copyFileSync(file, join(assets, name)); original.set(name, fs.readFileSync(file)); }
    }
  }
  const result = patchControlUiChannels(scratch);
  assert.equal(result.ok, true);
  const manifest = JSON.parse(fs.readFileSync(join(openclaw, 'dist/control-ui/asset-manifest.json'), 'utf8'));
  const generation = createHash('sha256');
  for (const entry of manifest.assets) generation.update(`${entry.path}\0${entry.size}\0${entry.sha256}\n`);
  assert.equal(manifest.generation, generation.digest('hex'), 'gateway must accept the regenerated manifest');
  const worker = fs.readFileSync(join(openclaw, 'dist/control-ui/sw.js'), 'utf8');
  assert.ok(worker.includes('uclaw-single-model-v3'), 'offline cache version must change for patched assets');
  for (const patch of UI_PATCHES) {
    const entry = manifest.assets.find(item => item.path === 'assets/' + patch.file);
    const bytes = fs.readFileSync(join(assets, patch.file));
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(entry.size, bytes.length);
    if (worker.includes(`"path":"assets/${patch.file}"`)) {
      assert.ok(worker.includes(`"path":"assets/${patch.file}","integrity":"sha256-${Buffer.from(entry.sha256, 'hex').toString('base64')}"`), 'offline boot SRI must match patched assets');
    }
  }
  const reviewed = new Map();
  for (const patch of UI_PATCHES) {
    const content = fs.readFileSync(join(assets, patch.file), 'utf8');
    reviewed.set(patch.file, content);
    let expected = original.get(patch.file).toString('utf8');
    for (const [before, after] of patch.replacements) expected = expected.replace(before, after);
    assert.equal(content, expected, 'only the reviewed channel-entry span may change');
    if (patch.file.startsWith('control-ui-core-D6')) {
      assert.ok(content.includes('routes:[`agents`,`search`,`plugin-settings`'), 'plugin settings navigation stays intact');
      assert.ok(!content.includes('routes:[`agents`,`model-providers`'), 'extra provider setup is absent from settings navigation');
      assert.ok(!content.includes('routes:[`connection`,`channels`'));
    }
    if (patch.file.startsWith('control-ui-boot-shared-5')) {
      assert.ok(!content.includes('`chat.welcome.suggestions.configureChannel`'), 'chat must not suggest configuring a channel');
      assert.ok(content.includes('打开设备钱包'), 'missing credentials must direct users to the wallet');
    }
    if (patch.file.startsWith('settings-targets-')) assert.ok(!content.includes('modelBehavior:{'), 'settings search must not open the extra provider setup');
    if (patch.file.startsWith('control-ui-boot-chat-Ijj')) assert.ok(!content.includes('onSetup:()=>this.context.navigate(`model-setup`)'), 'above-composer credential prompt must use the wallet setup callback');
    for (const [suffix, decode] of [['.gz', gunzipSync], ['.br', brotliDecompressSync]]) {
      const file = join(assets, patch.file + suffix);
      if (fs.existsSync(file)) assert.equal(decode(fs.readFileSync(file)).toString('utf8'), content, 'compressed responses must serve the patched UI');
    }
  }
  assert.equal(patchControlUiChannels(scratch).ok, true, 're-running setup remains valid');
  for (const [name, value] of reviewed) assert.equal(fs.readFileSync(join(assets, name), 'utf8'), value);
  const workerPath = join(openclaw, 'dist/control-ui/sw.js');
  const manifestPath = join(openclaw, 'dist/control-ui/asset-manifest.json');
  const reviewedWorker = fs.readFileSync(workerPath);
  const reviewedManifest = fs.readFileSync(manifestPath);
  fs.appendFileSync(workerPath, '\n// unreviewed offline boot change');
  assert.throws(() => patchControlUiChannels(scratch), /unreviewed service worker/);
  assert.deepEqual(fs.readFileSync(manifestPath), reviewedManifest, 'service worker drift must stop before manifest writes');
  fs.writeFileSync(workerPath, reviewedWorker);
  const changedManifest = JSON.parse(reviewedManifest);
  const other = changedManifest.assets.find(item => !UI_PATCHES.some(patch => item.path === 'assets/' + patch.file));
  assert.ok(other, 'manifest fixture must include unrelated assets');
  other.size++;
  const alteredGeneration = createHash('sha256');
  for (const entry of changedManifest.assets) alteredGeneration.update(`${entry.path}\0${entry.size}\0${entry.sha256}\n`);
  changedManifest.generation = alteredGeneration.digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(changedManifest));
  assert.throws(() => patchControlUiChannels(scratch), /unreviewed asset manifest/);
  assert.deepEqual(fs.readFileSync(workerPath), reviewedWorker, 'unreviewed manifest must stop before service worker writes');
  fs.writeFileSync(manifestPath, reviewedManifest);
  const drift = join(assets, UI_PATCHES.at(-1).file);
  fs.appendFileSync(drift, '\n// unreviewed drift');
  const beforeFailure = fs.readFileSync(join(assets, UI_PATCHES[0].file));
  assert.throws(() => patchControlUiChannels(scratch), /unexpected input SHA-256/);
  assert.deepEqual(fs.readFileSync(join(assets, UI_PATCHES[0].file)), beforeFailure, 'later hash drift must be detected before any write');
});

test('model setup callbacks open the registered wallet page through the native navigation API', () => {
  const calls = [];
  const context = {
    navigate() { throw new Error('built-in provider navigation must not run'); },
    plugins: { registrations(kind) {
      assert.equal(kind, 'pages');
      return [
        { pluginId: 'unrelated', value: { id: 'wallet' }, host: { navigation: { openPage() { throw new Error('wrong plugin'); } } } },
        { pluginId: 'uclaw-wallet', value: { id: 'wallet' }, host: { navigation: { openPage(target) { calls.push(target); } } } },
      ];
    } },
  };
  for (const patch of UI_PATCHES) for (const [before, after] of patch.replacements) {
    const prefix = before.startsWith('onModelSetup:') ? 'onModelSetup:' : before.startsWith('onSetup:') ? 'onSetup:' : null;
    if (!prefix) continue;
    const expression = after.slice(prefix.length).replace(/,onProviderSettings:$/, '').replace(/,error:$/, '');
    const callback = Function('e', `return (${expression});`).call({ context }, { context });
    callback();
  }
  assert.equal(calls.length, 5, 'welcome, model picker, and credential prompt must all use the registered wallet host');
  for (const call of calls) assert.deepEqual(call, { id: 'wallet' });
});
