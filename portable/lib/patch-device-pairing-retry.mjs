// Adds a narrowly-scoped retry for Windows device-pairing state publication.
// OpenClaw 2026.10.2 uses fs-safe 0.24.2's shared async/sync rename generator.
// Reviewed input and reviewed output are the only accepted files.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED_VERSION = '2026.10.2';
const EXPECTED_FS_SAFE_VERSION = '0.24.2';
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
const sha256 = value => createHash('sha256').update(value).digest('hex');
const coreDir = resolve(process.argv[2] || process.cwd());
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
  process.exit(0);
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
