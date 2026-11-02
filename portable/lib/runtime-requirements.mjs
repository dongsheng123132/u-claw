import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function supportsNode(version) {
  const match = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  if (major === 24) return minor > 22 || (minor === 22 && patch >= 1);
  if (major === 26) return minor > 12 || (minor === 12 && patch >= 1);
  return major > 26;
}

export function needsSetup(root, nodeVersion = process.version, platform = `${process.platform}-${process.arch}`) {
  if (!supportsNode(nodeVersion)) return true;
  try {
    const expected = readFileSync(join(root, 'OPENCLAW_VERSION'), 'utf8').trim();
    const installed = JSON.parse(readFileSync(join(root, 'app/core/node_modules/openclaw/package.json'), 'utf8'));
    const installedPlatform = readFileSync(join(root, 'app/core/.uclaw-runtime-platform'), 'utf8').trim();
    // Multi-platform portable images (e.g. Windows+Mac on one exFAT drive) list
    // every supported platform in the marker, separated by comma/newline.
    const platforms = installedPlatform.split(/[\s,]+/).filter(Boolean);
    return installed.version !== expected || !platforms.includes(platform);
  } catch {
    return true;
  }
}

function isEntryPoint() {
  // Realpath, not the raw argv: macOS /tmp -> /private/tmp and any symlinked path
  // (some mounts, `ln -s`, sandboxed runners) otherwise make the CLI print nothing,
  // which callers read as "requirements unmet" and trigger a bogus online setup.
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  console.log(`UCLAW_SETUP_NEEDED=${needsSetup(resolve(process.argv[2] || '.')) ? 1 : 0}`);
}
