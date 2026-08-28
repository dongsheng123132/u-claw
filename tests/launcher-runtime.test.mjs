// The post-bootstrap bridge must preserve runtime-paths' host/portable-strict
// decision and resolve the gateway entry from active.json, not a copied version.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { prepareLauncherRuntime, activeLauncherRuntime, writeStartupStatus } from '../portable/lib/launcher-runtime.mjs';
import { resolveRuntimePaths } from '../portable/lib/runtime-paths.mjs';

const PORTABLE = new URL('../portable/', import.meta.url);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'uclaw-launcher-runtime-'));
  const usb = join(base, 'usb');
  mkdirSync(join(usb, 'config'), { recursive: true });
  copyFileSync(new URL('config/runtime-channel.json', PORTABLE), join(usb, 'config', 'runtime-channel.json'));
  copyFileSync(new URL('OPENCLAW_VERSION', PORTABLE), join(usb, 'OPENCLAW_VERSION'));
  return { base, usb, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('launcher bridge falls back to USB strict mode through prepareRuntimePaths', () => {
  const f = fixture();
  try {
    const appdata = join(f.base, 'blocked-appdata');
    mkdirSync(appdata);
    writeFileSync(join(appdata, 'U-Claw'), 'not a directory');
    const result = prepareLauncherRuntime({ usbRoot: f.usb, platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: appdata } });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'portable-strict');
    assert.equal(result.paths.hostRoot, join(f.usb, 'host'));
  } finally { f.cleanup(); }
});

test('launcher bridge uses active.json to find the kernel entry and writes UI-only status', () => {
  const f = fixture();
  try {
    const host = join(f.base, 'host');
    const paths = resolveRuntimePaths({ usbRoot: f.usb, nodeVersion: '22.23.2', platform: 'win32', arch: 'x64', hostRoot: host });
    const version = '2026.7.1-2';
    const entry = join(paths.kernelsDir, version, 'node_modules', 'openclaw', 'openclaw.mjs');
    mkdirSync(join(paths.kernelsDir, version, 'node_modules', 'openclaw'), { recursive: true });
    writeFileSync(entry, '#!/usr/bin/env node\n');
    mkdirSync(join(paths.sharedDir), { recursive: true });
    writeFileSync(paths.activeKernelFile, JSON.stringify({ version }));

    const active = activeLauncherRuntime({ usbRoot: f.usb, hostRoot: host, platform: 'win32', arch: 'x64' });
    assert.equal(active.entry, entry);
    const status = join(paths.stateDir, 'startup-status.json');
    writeStartupStatus(status, { phase: 'runtime-seed', pct: 60 });
    assert.match(readFileSync(status, 'utf8'), /runtime-seed/);
  } finally { f.cleanup(); }
});
