// Opts two reviewed startup writers into fs-safe's explicit rename compatibility
// policy. Launchers set the opt-in only after testing rename identity on the
// actual state volume. The library's strict identity checks remain untouched.
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
const SHIM_SHA256 = '179ff9c3cbf15177bbd436846d991ef356824cf5773e1ace51fa6601d44672e8';
const STABILITY_SHA256 = '6aad9944caca8a64569d52ee835a1a21b85dd8caf99067ddb384183783a7ff4a';
const SHIM_ORIGINAL = '\tawait writeTextAtomic(executablePath, content, {\n\t\tmode: 448,\n\t\tdirMode: 448,\n\t\tdurable: false,\n\t\ttempPrefix: "openclaw-agent-cli"\n\t});';
const SHIM_COMPATIBLE = '\tif (process.platform === "win32" && process.env.OPENCLAW_PORTABLE_RENAME_IDENTITY === "verify-content-with-lock") {\n\t\treplaceFileAtomicSync({\n\t\t\tfilePath: executablePath,\n\t\t\tcontent,\n\t\t\tmode: 448,\n\t\t\tdirMode: 448,\n\t\t\tcopyFallbackOnPermissionError: true,\n\t\t\tsyncTempFile: false,\n\t\t\tsyncParentDir: false,\n\t\t\ttempPrefix: "openclaw-agent-cli",\n\t\t\trenameIdentity: "verify-content-with-lock"\n\t\t});\n\t} else {\n\t\tawait writeTextAtomic(executablePath, content, {\n\t\t\tmode: 448,\n\t\t\tdirMode: 448,\n\t\t\tdurable: false,\n\t\t\ttempPrefix: "openclaw-agent-cli"\n\t\t});\n\t}';
const TARGETS = [
  {
    bundle: 'node_modules/openclaw/dist/openclaw-cli-shim-LRKaYTVB.mjs',
    sha256: SHIM_SHA256,
    shaConstant: 'SHIM_SHA256',
    replacements: [
      ['import fs from "node:fs/promises";', 'import fs from "node:fs/promises";\nimport { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";'],
      [SHIM_ORIGINAL, SHIM_COMPATIBLE],
    ],
  },
  {
    bundle: 'node_modules/openclaw/dist/diagnostic-stability-bundle-DcoVIIR7.mjs',
    sha256: STABILITY_SHA256,
    shaConstant: 'STABILITY_SHA256',
    replacements: [
      ['\t\t\ttempPrefix: ".openclaw-stability"', '\t\t\ttempPrefix: ".openclaw-stability",\n\t\t\trenameIdentity: process.platform === "win32" && process.env.OPENCLAW_PORTABLE_RENAME_IDENTITY === "verify-content-with-lock" ? "verify-content-with-lock" : "strict"'],
    ],
  },
];

// Machine-readable anchors for `node tools/patch-baseline.mjs --print`.
// `--accept` may rewrite only the version pins and the `*_SHA256` constants.
export const PATCH_BASELINE = {
  id: 'portable-filesystem',
  title: 'Portable rename compatibility (fs-safe atomic shim + stability bundle)',
  file: fileURLToPath(import.meta.url),
  versionPins: [
    { package: 'openclaw', constant: 'EXPECTED_VERSION', expected: EXPECTED_VERSION },
    { package: '@openclaw/fs-safe', constant: 'EXPECTED_FS_SAFE_VERSION', expected: EXPECTED_FS_SAFE_VERSION },
  ],
  targets: TARGETS.map(({ bundle, shaConstant, sha256: originalSha256, replacements }) => ({
    bundle,
    shaConstant,
    originalSha256,
    replacements,
  })),
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const count = (value, anchor) => value.split(anchor).length - 1;
const refuse = message => new Error(`Refuse portable filesystem patch: ${message}`);

function prepareTarget(coreDir, target) {
  const bundlePath = resolve(coreDir, target.bundle);
  const source = readFileSync(bundlePath, 'utf8');
  // Accept only the exact reviewed original or the exact complete patched output.
  // An edited marker, partial application, or unrelated vendor drift fails closed.
  let restored = source;
  for (const [original, patched] of [...target.replacements].reverse()) {
    restored = restored.replace(patched, () => original);
  }
  if (target.replacements.every(([, patched]) => count(source, patched) === 1) && sha256(restored) === target.sha256) {
    return { bundlePath, source, patched: source, alreadyPatched: true };
  }
  if (sha256(source) !== target.sha256) throw refuse(`unexpected input SHA-256 for ${bundlePath}`);
  let patched = source;
  for (const [original, replacement] of target.replacements) {
    if (count(patched, original) !== 1) throw refuse(`expected exactly one original anchor in ${bundlePath}`);
    patched = patched.replace(original, () => replacement);
  }
  if (!target.replacements.every(([, replacement]) => count(patched, replacement) === 1)) {
    throw refuse(`post-condition failed for ${bundlePath}`);
  }
  return { bundlePath, source, patched, alreadyPatched: false };
}

export function patchPortableFilesystem(coreDir) {
  coreDir = resolve(coreDir);
  const openclaw = JSON.parse(readFileSync(resolve(coreDir, 'node_modules/openclaw/package.json'), 'utf8'));
  if (openclaw.version !== EXPECTED_VERSION) throw refuse(`expected OpenClaw ${EXPECTED_VERSION}, got ${openclaw.version}`);
  const fsSafe = JSON.parse(readFileSync(resolve(coreDir, 'node_modules/@openclaw/fs-safe/package.json'), 'utf8'));
  if (fsSafe.version !== EXPECTED_FS_SAFE_VERSION) throw refuse(`expected fs-safe ${EXPECTED_FS_SAFE_VERSION}, got ${fsSafe.version}`);
  // Validate both modules before publishing either change.
  const prepared = TARGETS.map(target => prepareTarget(coreDir, target));
  for (const target of prepared) {
    if (!target.alreadyPatched) writeFileSync(target.bundlePath, target.patched, 'utf8');
  }
  return prepared.map(target => ({
    path: target.bundlePath,
    alreadyPatched: target.alreadyPatched,
    sha256: sha256(target.patched),
  }));
}

if (isCliEntry(import.meta.url)) {
  if (process.argv.includes('--print-anchors')) {
    process.stdout.write(`${JSON.stringify(PATCH_BASELINE, null, 2)}\n`);
  } else {
    for (const result of patchPortableFilesystem(process.argv[2] || process.cwd())) {
      process.stdout.write(`${result.alreadyPatched ? 'portable filesystem compatibility already patched' : 'patched portable filesystem compatibility'}: ${result.path}\nsha256=${result.sha256}\n`);
    }
  }
}
