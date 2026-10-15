import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function supportsNode(version) {
  const match = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return (major === 24 && minor >= 16) || major > 26 || (major === 26 && minor >= 1);
}

export function needsSetup(root, nodeVersion = process.version, platform = `${process.platform}-${process.arch}`) {
  if (!supportsNode(nodeVersion)) return true;
  try {
    const expected = readFileSync(join(root, 'OPENCLAW_VERSION'), 'utf8').trim();
    const installed = JSON.parse(readFileSync(join(root, 'app/core/node_modules/openclaw/package.json'), 'utf8'));
    const installedPlatform = readFileSync(join(root, 'app/core/.uclaw-runtime-platform'), 'utf8').trim();
    return installed.version !== expected || installedPlatform !== platform;
  } catch {
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`UCLAW_SETUP_NEEDED=${needsSetup(resolve(process.argv[2] || '.')) ? 1 : 0}`);
}
