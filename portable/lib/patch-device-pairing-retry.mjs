// Adds a narrowly-scoped retry for Windows device-pairing state publication.
// OpenClaw 2026.10.9 uses fs-safe 0.26.0's shared async/sync rename generator.
// Reviewed input and reviewed output are the only accepted files.
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
const EXPECTED_FS_SAFE_VERSION = '0.26.0';
const EXPECTED_SHA256 = 'b02256c407103a8f91c99ea01140f05f5b810c747eddfbec6622522f6ac86d7c';
const BUNDLE = 'node_modules/@openclaw/fs-safe/dist/replace-file.js';
const REPLACEMENTS = [
  [
    '    const maxRetries = options.renameMaxRetries ?? 0;\n    const baseDelayMs = options.renameRetryBaseDelayMs ?? 50;\n    const copyFallbackOnPermissionError = options.copyFallbackOnPermissionError === true;',
    '    const pairingStateFile = /[\\\\/]devices[\\\\/](?:paired|pending)\\.json$/i.test(destination);\n    const maxRetries = pairingStateFile ? Math.max(options.renameMaxRetries ?? 0, 4) : options.renameMaxRetries ?? 0;\n    const baseDelayMs = pairingStateFile ? 25 : options.renameRetryBaseDelayMs ?? 50;\n    const copyFallbackOnPermissionError = !pairingStateFile && options.copyFallbackOnPermissionError === true;',
  ],
  [
    'if (code === "EBUSY" && attempt < maxRetries) {',
    'if ((code === "EBUSY" || pairingStateFile && (code === "EPERM" || code === "ENOTEMPTY")) && attempt < maxRetries) {',
  ],
];

// Machine-readable anchors for `node tools/patch-baseline.mjs --print`.
// `--accept` may rewrite only `EXPECTED_VERSION` / `EXPECTED_FS_SAFE_VERSION` /
// `EXPECTED_SHA256`.
export const PATCH_BASELINE = {
  id: 'device-pairing-retry',
  title: 'Windows device-pairing rename retry (fs-safe)',
  file: fileURLToPath(import.meta.url),
  versionPins: [
    { package: 'openclaw', constant: 'EXPECTED_VERSION', expected: EXPECTED_VERSION },
    { package: '@openclaw/fs-safe', constant: 'EXPECTED_FS_SAFE_VERSION', expected: EXPECTED_FS_SAFE_VERSION },
  ],
  targets: [{
    bundle: BUNDLE,
    shaConstant: 'EXPECTED_SHA256',
    originalSha256: EXPECTED_SHA256,
    replacements: REPLACEMENTS,
  }],
};

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function patchDevicePairingRetry(rawCoreDir = process.cwd()) {
  const coreDir = resolve(rawCoreDir);
  const openclaw = JSON.parse(readFileSync(resolve(coreDir, 'node_modules/openclaw/package.json'), 'utf8'));
  if (openclaw.version !== EXPECTED_VERSION) {
    throw new Error(`Refuse pairing retry patch: expected OpenClaw ${EXPECTED_VERSION}, got ${openclaw.version}`);
  }
  const fsSafe = JSON.parse(readFileSync(resolve(coreDir, 'node_modules/@openclaw/fs-safe/package.json'), 'utf8'));
  if (fsSafe.version !== EXPECTED_FS_SAFE_VERSION) {
    throw new Error(`Refuse pairing retry patch: expected fs-safe ${EXPECTED_FS_SAFE_VERSION}, got ${fsSafe.version}`);
  }

  const bundlePath = resolve(coreDir, BUNDLE);
  const source = readFileSync(bundlePath, 'utf8');
  let restored = source;
  for (const [oldText, newText] of REPLACEMENTS) restored = restored.replace(newText, oldText);
  if (sha256(restored) === EXPECTED_SHA256 && REPLACEMENTS.every(([, text]) => source.split(text).length - 1 === 1)) {
    process.stdout.write(`device pairing rename retry already patched: ${bundlePath}\n`);
    return;
  }
  if (sha256(source) !== EXPECTED_SHA256) {
    throw new Error(`Refuse pairing retry patch: unexpected input SHA-256 for ${bundlePath}`);
  }
  let patched = source;
  for (const [oldText, newText] of REPLACEMENTS) {
    if (patched.split(oldText).length - 1 !== 1) {
      throw new Error('Refuse pairing retry patch: expected exactly one original anchor');
    }
    patched = patched.replace(oldText, newText);
  }
  if (!REPLACEMENTS.every(([oldText, newText]) => !patched.includes(oldText) && patched.split(newText).length - 1 === 1)) {
    throw new Error('Refuse pairing retry patch: post-condition failed');
  }
  writeFileSync(bundlePath, patched, 'utf8');
  process.stdout.write(`patched device pairing rename retry: ${bundlePath}\nsha256=${sha256(patched)}\n`);
}

if (isCliEntry(import.meta.url)) {
  if (process.argv.includes('--print-anchors')) {
    process.stdout.write(`${JSON.stringify(PATCH_BASELINE, null, 2)}\n`);
  } else {
    patchDevicePairingRetry(process.argv[2] || process.cwd());
  }
}
