// Applies the narrowly-scoped U-Claw vendor patch for OpenClaw 2026.10.9.
// This must fail closed: an upstream bundle change is never silently patched.
//
// The sha256/version constants below are the reviewed anchors. When upstream
// moves, setup exits 1; use `node tools/patch-baseline.mjs --upstream <core>
// --print` to see the drift and `--accept` to recompute ONLY the anchors.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from './patch-anchors.mjs';

const EXPECTED_VERSION = '2026.10.9';
const EXPECTED_SHA256 = '734c028a328f170df098e3d9b22f566fc6a13ec8bc59eacec56db6af5ec47a7e';
const OLD = 'return path.join(CONFIG_DIR, "browser", profileName, "user-data");';
const NEXT = 'return path.join(process.env.OPENCLAW_MANAGED_BROWSER_DIR?.trim() || path.join(CONFIG_DIR, "browser"), profileName, "user-data");';
const BUNDLE = 'node_modules/openclaw/dist/chrome-IDR7c0-o.mjs';

// Machine-readable anchors for `node tools/patch-baseline.mjs --print`.
// `--accept` may rewrite only `EXPECTED_VERSION` / `EXPECTED_SHA256`.
export const PATCH_BASELINE = {
  id: 'managed-browser-root',
  title: 'Managed Chromium profile root (OPENCLAW_MANAGED_BROWSER_DIR)',
  file: fileURLToPath(import.meta.url),
  versionPins: [{ package: 'openclaw', constant: 'EXPECTED_VERSION', expected: EXPECTED_VERSION }],
  targets: [{
    bundle: BUNDLE,
    shaConstant: 'EXPECTED_SHA256',
    originalSha256: EXPECTED_SHA256,
    replacements: [[OLD, NEXT]],
  }],
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function patchManagedBrowserRoot(rawCoreDir = process.cwd()) {
  const coreDir = resolve(rawCoreDir);
  const packagePath = resolve(coreDir, 'node_modules/openclaw/package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`Refuse browser patch: expected OpenClaw ${EXPECTED_VERSION}, got ${packageJson.version}`);
  }

  const bundlePath = resolve(coreDir, BUNDLE);
  const source = readFileSync(bundlePath, 'utf8');
  // Setup also checks existing installations. Only accept the exact reviewed output.
  if (sha256(source.replace(NEXT, OLD)) === EXPECTED_SHA256 && source.split(NEXT).length - 1 === 1) {
    process.stdout.write(`managed browser root already patched: ${bundlePath}\n`);
    return;
  }
  if (sha256(source) !== EXPECTED_SHA256) {
    throw new Error(`Refuse browser patch: unexpected input SHA-256 for ${bundlePath}`);
  }
  if (source.split(OLD).length - 1 !== 1) {
    throw new Error('Refuse browser patch: expected exactly one original resolver');
  }

  const patched = source.replace(OLD, NEXT);
  if (patched.split(OLD).length - 1 !== 0 || patched.split(NEXT).length - 1 !== 1) {
    throw new Error('Refuse browser patch: post-condition failed');
  }
  writeFileSync(bundlePath, patched, 'utf8');
  process.stdout.write(`patched managed browser root: ${bundlePath}\nsha256=${sha256(patched)}\n`);
}

if (isCliEntry(import.meta.url)) {
  if (process.argv.includes('--print-anchors')) {
    process.stdout.write(`${JSON.stringify(PATCH_BASELINE, null, 2)}\n`);
  } else {
    patchManagedBrowserRoot(process.argv[2] || process.cwd());
  }
}
