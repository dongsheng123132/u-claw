import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const guard = join(repoRoot, 'portable', 'lib', 'skip-package-lifecycle.mjs');

function makeFixture(withMarker) {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-lifecycle-'));
  const core = join(root, 'app', 'core');
  const pkg = join(core, 'node_modules', 'openclaw');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  if (withMarker) writeFileSync(join(pkg, '.openclaw-lifecycle-pending'), 'pending\n');
  if (withMarker) writeFileSync(join(pkg, 'dist', 'openclaw-install-guard'), 'guard\n');
  return { root, core, pkg };
}

test('package-lifecycle guard is a no-op when nothing is pending', () => {
  const { root, core } = makeFixture(false);
  try {
    const out = execFileSync(process.execPath, [guard, core], { encoding: 'utf8' });
    assert.match(out, /UCLAW_LIFECYCLE=not-pending/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package-lifecycle guard keeps the completion on filesystems with stable rename identity', () => {
  const { root, core, pkg } = makeFixture(true);
  try {
    const out = execFileSync(process.execPath, [guard, core], { encoding: 'utf8' });
    // NTFS/APFS/ext4 report a usable inode, so the one-time completion is left alone.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.match(out, /UCLAW_LIFECYCLE=pending-completable/);
      assert.ok(existsSync(join(pkg, '.openclaw-lifecycle-pending')));
    } else {
      // ext4 under CI also reports a stable identity.
      assert.match(out, /UCLAW_LIFECYCLE=pending-completable/);
      assert.ok(existsSync(join(pkg, '.openclaw-lifecycle-pending')));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launchers wire the guard and document why it exists', () => {
  const win = readFileSync(join(repoRoot, 'portable', 'Windows-Start.bat'), 'utf8');
  const mac = readFileSync(join(repoRoot, 'portable', 'Mac-Start.command'), 'utf8');
  const source = readFileSync(guard, 'utf8');
  assert.match(source, /openclaw-lifecycle-pending/);
  assert.match(source, /verify-content-with-lock/);
  assert.match(win, /skip-package-lifecycle\.mjs/);
  assert.match(mac, /skip-package-lifecycle\.mjs/);
});

