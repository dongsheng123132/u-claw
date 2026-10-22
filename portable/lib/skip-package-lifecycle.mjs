// OpenClaw ships with a one-time "package lifecycle" completion step: a pending
// marker is written by npm install (--ignore-scripts) and OpenClaw finishes the
// install before the gateway starts. That completion publishes files through an
// atomic rename whose identity it verifies via inode numbers.
//
// On exFAT/FAT32 the rename changes the reported inode (or reports none at all),
// so the completion step fails with "filesystem write failed (EIO)" and OpenClaw
// then refuses to start with:
//   openclaw: package lifecycle is incomplete. Reinstall with package scripts
//   enabled, then retry.
// The release is installed by CI with --ignore-scripts and then receives verified
// compatibility patches, so the remaining lifecycle completion is not required to
// boot the gateway. On a filesystem whose rename identity is unusable we clear the
// pending marker instead of leaving users with a USB drive that cannot start.
//
// Reuses the rename-identity probe the launchers already rely on
// (portable-filesystem.mjs): NTFS/APFS/ext4 report a stable identity and keep the
// full lifecycle completion; exFAT/FAT32 fall back to content+lock, which the
// package lifecycle publisher cannot use.
//
// Prints one KEY=VALUE line for the launchers (same contract as the other lib
// helpers); it never blocks startup.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { probeRenameIdentity } from './portable-filesystem.mjs';

const coreDir = process.argv[2];
if (!coreDir) {
  console.error('usage: skip-package-lifecycle.mjs <app/core>');
  process.exit(2);
}

const packageDir = join(coreDir, 'node_modules', 'openclaw');
const marker = join(packageDir, '.openclaw-lifecycle-pending');
const installGuard = join(packageDir, 'dist', 'openclaw-install-guard');

if (!existsSync(marker) && !existsSync(installGuard)) {
  console.log('UCLAW_LIFECYCLE=not-pending');
  process.exit(0);
}

// Force the probe on every platform: the same identity problem shows up on exFAT
// drives mounted on macOS, not only on Windows.
const probe = await probeRenameIdentity(packageDir, 'win32');
const unstableIdentity = probe.mode === 'verify-content-with-lock' || Boolean(probe.error);
if (!unstableIdentity) {
  console.log('UCLAW_LIFECYCLE=pending-completable');
  process.exit(0);
}

rmSync(marker, { force: true });
if (existsSync(installGuard)) rmSync(installGuard, { recursive: true, force: true });
console.log('UCLAW_LIFECYCLE=skipped-unstable-rename-identity');
