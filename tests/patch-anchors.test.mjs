// Tests for the sha256 anchor baseline tooling (P1: 补丁基线自动化).
//
// No real OpenClaw install is required: the CLI fixtures generate a tiny
// anchor-aware patch module in a temp dir, so the three anchor outcomes
// (original hit / already-patched hit / unknown upstream) are covered without
// downloading upstream bundles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ANCHOR_STATUS,
  classifyAnchorFile,
  computeSha256,
  diffLines,
  findAnchorWindow,
  formatDiffHunks,
  planOriginalAcceptance,
  restoreOriginal,
  sha256Text,
} from '../portable/lib/patch-anchors.mjs';
import { PATCH_BASELINE as managedBrowserBaseline } from '../portable/lib/patch-managed-browser-root.mjs';
import { PATCH_BASELINE as pairingBaseline } from '../portable/lib/patch-device-pairing-retry.mjs';
import { PATCH_BASELINE as filesystemBaseline } from '../portable/lib/patch-portable-filesystem.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolPath = join(repoRoot, 'tools/patch-baseline.mjs');
const realPatchDir = join(repoRoot, 'portable/lib');
const realPatchFiles = ['patch-managed-browser-root.mjs', 'patch-device-pairing-retry.mjs', 'patch-portable-filesystem.mjs'];
const openclawPin = readFileSync(join(repoRoot, 'OPENCLAW_VERSION'), 'utf8').trim();

const FIXTURE_OLD = 'const target = "os-tmp";';
const FIXTURE_NEW = 'const target = "portable";';
const FIXTURE_ORIGINAL = `// fixture bundle\nline two stays\n${FIXTURE_OLD}\nline four stays\n`;
const FIXTURE_PATCHED = FIXTURE_ORIGINAL.replace(FIXTURE_OLD, FIXTURE_NEW);
const FIXTURE_DRIFT = FIXTURE_ORIGINAL.replace('line four stays', 'line four changed by upstream');
const FIXTURE_ANCHOR_DRIFT = FIXTURE_ORIGINAL
  .replace(FIXTURE_OLD, 'const target = process.env.OS_TMP || "os-tmp";')
  .replace('line four stays', 'line four changed by upstream');
const FIXTURE_REPLACEMENTS = [[FIXTURE_OLD, FIXTURE_NEW]];

function fixturePatchSource({ sha, version = '1.0.0', id = 'fixture-patch' }) {
  return `import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '${version}';
const EXPECTED_SHA256 = '${sha}';
const OLD = ${JSON.stringify(FIXTURE_OLD)};
const NEXT = ${JSON.stringify(FIXTURE_NEW)};

export const PATCH_BASELINE = {
  id: '${id}',
  title: 'generated anchor fixture',
  file: fileURLToPath(import.meta.url),
  versionPins: [{ package: 'openclaw', constant: 'EXPECTED_VERSION', expected: EXPECTED_VERSION }],
  targets: [{
    bundle: 'node_modules/openclaw/dist/fixture-bundle.mjs',
    shaConstant: 'EXPECTED_SHA256',
    originalSha256: EXPECTED_SHA256,
    replacements: [[OLD, NEXT]],
  }],
};
`;
}

function setupFixture(t, overrides = {}) {
  const {
    content = FIXTURE_ORIGINAL,
    sha = sha256Text(FIXTURE_ORIGINAL),
    openclawVersion = '1.0.0',
    pinVersion = '1.0.0',
    patchId = 'fixture-patch',
  } = overrides;
  const scratch = mkdtempSync(join(tmpdir(), 'uclaw-patch-baseline-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const core = join(scratch, 'core');
  const patchDir = join(scratch, 'patches');
  mkdirSync(join(core, 'node_modules/openclaw/dist'), { recursive: true });
  mkdirSync(patchDir, { recursive: true });
  writeFileSync(join(core, 'node_modules/openclaw/package.json'), `${JSON.stringify({ name: 'openclaw', version: openclawVersion })}\n`);
  writeFileSync(join(core, 'node_modules/openclaw/dist/fixture-bundle.mjs'), content);
  const patchFile = join(patchDir, 'patch-fixture.mjs');
  writeFileSync(patchFile, fixturePatchSource({ sha, version: pinVersion, id: patchId }));
  return { scratch, core, patchDir, patchFile };
}

function runTool(args) {
  return spawnSync(process.execPath, [toolPath, ...args], { encoding: 'utf8', timeout: 30000 });
}

test('sha256 classification: original hit, already-patched hit, unknown input', () => {
  const originalSha256 = sha256Text(FIXTURE_ORIGINAL);
  const original = classifyAnchorFile({ source: FIXTURE_ORIGINAL, originalSha256, replacements: FIXTURE_REPLACEMENTS });
  assert.equal(original.status, ANCHOR_STATUS.ORIGINAL);
  assert.equal(original.actualSha256, originalSha256);
  const patched = classifyAnchorFile({ source: FIXTURE_PATCHED, originalSha256, replacements: FIXTURE_REPLACEMENTS });
  assert.equal(patched.status, ANCHOR_STATUS.PATCHED);
  assert.equal(patched.restoredSha256, originalSha256);
  const unknown = classifyAnchorFile({ source: FIXTURE_DRIFT, originalSha256, replacements: FIXTURE_REPLACEMENTS });
  assert.equal(unknown.status, ANCHOR_STATUS.UNKNOWN);
  assert.equal(restoreOriginal(FIXTURE_PATCHED, FIXTURE_REPLACEMENTS), FIXTURE_ORIGINAL);
});

test('computeSha256 hashes file bytes like sha256Text', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'uclaw-patch-sha-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const file = join(scratch, 'bundle.mjs');
  writeFileSync(file, FIXTURE_ORIGINAL);
  assert.equal(computeSha256(file), sha256Text(FIXTURE_ORIGINAL));
});

test('planOriginalAcceptance adopts pristine originals only', () => {
  const pristine = planOriginalAcceptance({ source: FIXTURE_DRIFT, replacements: FIXTURE_REPLACEMENTS });
  assert.equal(pristine.ok, true);
  assert.equal(pristine.patchedSha256, sha256Text(FIXTURE_DRIFT.replace(FIXTURE_OLD, FIXTURE_NEW)));
  const patched = planOriginalAcceptance({ source: FIXTURE_PATCHED, replacements: FIXTURE_REPLACEMENTS });
  assert.equal(patched.ok, false);
  assert.equal(patched.code, 'PATCHED-MARKER-PRESENT');
  const drifted = planOriginalAcceptance({ source: FIXTURE_ANCHOR_DRIFT, replacements: FIXTURE_REPLACEMENTS });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'ANCHOR-TEXT-DRIFT');
});

test('diff summary names the changed lines', () => {
  const changed = diffLines(FIXTURE_ORIGINAL, FIXTURE_DRIFT);
  assert.equal(changed.removed, 1);
  assert.equal(changed.added, 1);
  const rendered = formatDiffHunks(changed).join('\n');
  assert.match(rendered, /- 4 \| line four stays/);
  assert.match(rendered, /\+ 4 \| line four changed by upstream/);
});

test('findAnchorWindow locates the closest region when the anchor line was rewritten', () => {
  const anchor = 'const target = "os-tmp";';
  const exact = findAnchorWindow(FIXTURE_ORIGINAL, anchor);
  assert.equal(exact.exact, true);
  assert.equal(exact.startLine, 3);
  const approximate = findAnchorWindow(FIXTURE_ANCHOR_DRIFT, anchor);
  assert.notEqual(approximate, null);
  assert.equal(approximate.exact, false);
  assert.equal(approximate.startLine, 3);
  assert.ok(approximate.similarity > 0);
});

test('patch-baseline --print: original anchor hit ends green (exit 0)', t => {
  const fixture = setupFixture(t);
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--print']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /status=original/);
  assert.match(result.stdout, /RESULT: READY 1\/1 patch/);
});

test('patch-baseline --print: already-patched anchor hit ends green (exit 0)', t => {
  const fixture = setupFixture(t, { content: FIXTURE_PATCHED });
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--print']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /status=patched/);
  assert.match(result.stdout, /RESULT: READY 1\/1 patch/);
});

test('patch-baseline --print: unknown upstream exits 1 with diff and --accept hint', t => {
  const fixture = setupFixture(t, { content: FIXTURE_ANCHOR_DRIFT });
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--print']);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /status=unknown/);
  assert.match(result.stdout, /diff/);
  assert.match(result.stdout, /- 1 \| const target = "os-tmp";/);
  assert.match(result.stdout, /\+ 3 \| const target = process\.env\.OS_TMP/);
  assert.match(result.stdout, /--accept --patch fixture-patch/);
  assert.match(result.stdout, /RESULT: NEEDS-ACCEPT 1\/1 patch/);
});

test('patch-baseline --baseline: renders the upstream drift as a line diff', t => {
  const fixture = setupFixture(t, { content: FIXTURE_DRIFT });
  const baseline = join(fixture.scratch, 'baseline-core');
  mkdirSync(join(baseline, 'node_modules/openclaw/dist'), { recursive: true });
  writeFileSync(join(baseline, 'node_modules/openclaw/dist/fixture-bundle.mjs'), FIXTURE_ORIGINAL);
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--baseline', baseline, '--print']);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /baseline .*-1 \+1/);
  assert.match(result.stdout, /- 4 \| line four stays/);
  assert.match(result.stdout, /\+ 4 \| line four changed by upstream/);
});

test('patch-baseline --accept: rewrites only the sha256 anchor and re-verifies', t => {
  const fixture = setupFixture(t, { content: FIXTURE_DRIFT });
  const before = readFileSync(fixture.patchFile, 'utf8');
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--accept']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /RESULT: ACCEPTED 1 patch file/);
  const after = readFileSync(fixture.patchFile, 'utf8');
  const expected = before.replace(
    `const EXPECTED_SHA256 = '${sha256Text(FIXTURE_ORIGINAL)}';`,
    `const EXPECTED_SHA256 = '${sha256Text(FIXTURE_DRIFT)}';`,
  );
  assert.equal(after, expected, '--accept must only rewrite the anchor constant line');
  const reprint = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--print']);
  assert.equal(reprint.status, 0, reprint.stderr + reprint.stdout);
  assert.match(reprint.stdout, /status=original/);
});

test('patch-baseline --accept --dry-run writes nothing', t => {
  const fixture = setupFixture(t, { content: FIXTURE_DRIFT });
  const before = readFileSync(fixture.patchFile, 'utf8');
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--accept', '--dry-run']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /RESULT: DRY-RUN/);
  assert.equal(readFileSync(fixture.patchFile, 'utf8'), before);
});

test('patch-baseline --accept refuses when the patch replacement text drifted', t => {
  const fixture = setupFixture(t, { content: FIXTURE_ANCHOR_DRIFT });
  const before = readFileSync(fixture.patchFile, 'utf8');
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--accept']);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /RESULT: REFUSED/);
  assert.match(result.stdout, /ANCHOR-TEXT-DRIFT/);
  assert.equal(readFileSync(fixture.patchFile, 'utf8'), before, 'refused accept must not write');
});

test('patch-baseline --accept bumps a stale version pin without touching sha anchors', t => {
  const fixture = setupFixture(t, { content: FIXTURE_ORIGINAL, openclawVersion: '2.0.0', pinVersion: '1.0.0' });
  const before = readFileSync(fixture.patchFile, 'utf8');
  const report = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--print']);
  assert.equal(report.status, 1, report.stderr + report.stdout);
  assert.match(report.stdout, /MISMATCH/);
  assert.match(report.stdout, /status=original/);
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--accept']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const after = readFileSync(fixture.patchFile, 'utf8');
  assert.match(after, /const EXPECTED_VERSION = '2\.0\.0';/);
  assert.match(after, new RegExp(`const EXPECTED_SHA256 = '${sha256Text(FIXTURE_ORIGINAL)}';`));
  assert.notEqual(after, before);
  const reprint = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--print']);
  assert.equal(reprint.status, 0, reprint.stderr + reprint.stdout);
});

test('patch-baseline --json exposes machine-readable status', t => {
  const fixture = setupFixture(t, { content: FIXTURE_PATCHED });
  const result = runTool(['--upstream', fixture.core, '--patch-dir', fixture.patchDir, '--json']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.patches[0].targets[0].status, 'patched');
});

test('each vendor patch exposes its anchors through --print-anchors', () => {
  const expectedIds = {
    'patch-managed-browser-root.mjs': 'managed-browser-root',
    'patch-device-pairing-retry.mjs': 'device-pairing-retry',
    'patch-portable-filesystem.mjs': 'portable-filesystem',
  };
  for (const name of realPatchFiles) {
    const result = spawnSync(process.execPath, [join(realPatchDir, name), '--print-anchors'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.id, expectedIds[name]);
    assert.ok(payload.targets.length >= 1, `${name} must print at least one target anchor`);
  }
});

test('patch CLI guard survives symlinked script paths', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'uclaw-patch-symlink-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const link = join(scratch, 'linked-patch.mjs');
  try {
    symlinkSync(join(realPatchDir, 'patch-managed-browser-root.mjs'), link, 'file');
  } catch {
    t.skip('symlinks are not permitted in this environment');
    return;
  }
  const result = spawnSync(process.execPath, [link, '--print-anchors'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, 'managed-browser-root');
});

test('real vendor patches export complete anchor metadata', () => {
  const patches = [managedBrowserBaseline, pairingBaseline, filesystemBaseline];
  assert.deepEqual(
    patches.map(patch => patch.id).sort(),
    ['device-pairing-retry', 'managed-browser-root', 'portable-filesystem'],
  );
  for (const patch of patches) {
    assert.match(patch.file, /patch-[a-z-]+\.mjs$/);
    assert.ok(patch.targets.length >= 1, `${patch.id} must expose its targets`);
    for (const target of patch.targets) {
      assert.match(target.bundle, /^node_modules\/(?:openclaw|@openclaw\/fs-safe)\//);
      assert.match(target.originalSha256, /^[0-9a-f]{64}$/);
      assert.match(target.shaConstant, /^[A-Z0-9_]+$/);
      for (const [original, patched] of target.replacements) {
        assert.ok(original.length > 0 && patched.length > 0);
        assert.notEqual(original, patched);
      }
    }
    const pins = patch.versionPins.map(pin => pin.package);
    assert.ok(pins.includes('openclaw'), `${patch.id} must pin the OpenClaw version`);
    const pin = patch.versionPins.find(value => value.package === 'openclaw');
    assert.equal(pin.expected, openclawPin, `${patch.id} 的 openclaw 版本 pin 必须与 OPENCLAW_VERSION 一致`);
  }
});

test('unknown upstream still fails closed everywhere (setup gate unchanged)', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'uclaw-patch-gate-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const core = join(scratch, 'core');
  const patches = [managedBrowserBaseline, pairingBaseline, filesystemBaseline];
  const pins = new Map();
  for (const patch of patches) for (const pin of patch.versionPins) pins.set(pin.package, pin.expected);
  for (const [packageName, version] of pins) {
    const file = join(core, 'node_modules', packageName, 'package.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ name: packageName, version })}\n`);
  }
  for (const target of patches.flatMap(patch => patch.targets)) {
    const file = join(core, target.bundle);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '// deliberately unreviewed upstream content\n');
  }
  const report = runTool(['--upstream', core, '--patch-dir', realPatchDir, '--print']);
  assert.equal(report.status, 1, report.stderr + report.stdout);
  assert.match(report.stdout, /RESULT: NEEDS-ACCEPT/);
  assert.equal((report.stdout.match(/status=unknown/g) ?? []).length, 4, 'all four vendor targets are unknown');
  const before = realPatchFiles.map(name => readFileSync(join(realPatchDir, name), 'utf8'));
  const accept = runTool(['--upstream', core, '--patch-dir', realPatchDir, '--accept']);
  assert.equal(accept.status, 1, accept.stderr + accept.stdout);
  assert.match(accept.stdout, /RESULT: REFUSED/);
  assert.deepEqual(
    realPatchFiles.map(name => readFileSync(join(realPatchDir, name), 'utf8')),
    before,
    'refused accept must never rewrite the real repo anchors',
  );
  for (const name of realPatchFiles) {
    const patchRun = spawnSync(process.execPath, [join(realPatchDir, name), core], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(patchRun.status, 0, `${name} must fail closed on unknown upstream`);
    assert.match(patchRun.stderr, /unexpected input SHA-256|expected exactly one original/);
  }
});
