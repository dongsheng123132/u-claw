// The Windows release builder supplies its real, pinned runtime. Ordinary CI
// has no vendor dependencies; hardware acceptance additionally runs on exFAT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { patchExfatCompatibility } from '../portable/lib/patch-exfat-compatibility.mjs';

const core = process.env.UCLAW_RUNTIME_CORE;
const skip = !core || process.platform !== 'win32' ? 'Requires built Windows runtime (UCLAW_RUNTIME_CORE)' : false;
const run = promisify(execFile);
const vendorFiles = [
  '@openclaw/fs-safe/dist/pinned-write.js',
  '@openclaw/fs-safe/dist/root-write-verification.js',
  '@openclaw/fs-safe/dist/publish-copy-stage.js',
  '@openclaw/fs-safe/dist/uclaw-exfat-publish.ps1',
  'openclaw/dist/openclaw-cli-shim-I4WwJOH3.mjs',
  'openclaw/dist/diagnostic-stability-bundle-vmtXgIWw.mjs',
];

test('release patch is idempotent and rejects vendor drift before writing', { skip }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-patch-regression-'));
  try {
    for (const relative of [...vendorFiles, 'openclaw/package.json', '@openclaw/fs-safe/package.json']) {
      const target = path.join(fixture, 'node_modules', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(core, 'node_modules', relative), target);
    }
    const snapshot = () => vendorFiles.map(relative => fs.readFileSync(path.join(fixture, 'node_modules', relative), 'utf8'));
    const before = snapshot();
    patchExfatCompatibility(fixture);
    assert.deepEqual(snapshot(), before);
    const drift = path.join(fixture, 'node_modules', vendorFiles.at(-1));
    fs.appendFileSync(drift, '\n// unknown vendor change\n');
    const changed = snapshot();
    assert.throws(() => patchExfatCompatibility(fixture), /Unreviewed vendor bytes/);
    assert.deepEqual(snapshot(), changed, 'a failed preflight must not alter any vendor module');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

for (const mode of ['strict', 'verify-content-with-lock']) {
  test(`both actual startup writers work with ${mode}`, { skip, timeout: 60000 }, async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-startup-writers-'));
    try {
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import assert from 'node:assert/strict';
        import {pathToFileURL} from 'node:url';
        const [core,state]=process.argv.slice(1);
        const load=name=>import(pathToFileURL(path.join(core,'node_modules/openclaw/dist',name)));
        const shim=await load('openclaw-cli-shim-I4WwJOH3.mjs');
        for(let n=0;n<2;n++) await shim.r({stateDir:state,invocation:{command:process.execPath,args:['--version'],env:{}}});
        assert.match(fs.readFileSync(path.join(state,'tmp/agent-cli/openclaw.cmd'),'utf8'),/--version/);
        const diagnostic=await load('diagnostic-stability-bundle-vmtXgIWw.mjs');
        const result=diagnostic.c({stateDir:state,reason:'startup-regression',includeEmpty:true});
        if(result.status!=='written') throw result.error || Error(result.status);
        assert.equal(JSON.parse(fs.readFileSync(result.path,'utf8')).reason,'startup-regression');
        console.log('startup writers passed');
      `;
      const result = await run(process.execPath, ['--input-type=module', '-e', script, core, state], {
        timeout: 55000, windowsHide: true,
        env: { ...process.env, FS_SAFE_NATIVE_MODE: mode === 'strict' ? 'auto' : 'off', OPENCLAW_PORTABLE_RENAME_IDENTITY: mode },
      });
      assert.match(result.stdout, /startup writers passed/);
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
  });
}
