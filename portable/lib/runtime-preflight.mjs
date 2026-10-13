// Fail before touching portable state when the runtime or filesystem is unsupported.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function supportsNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return (major === 24 && minor >= 16) || major > 26 || (major === 26 && minor >= 1);
}

export function validateRuntime({ nodeVersion, expected, installed, filesystem, platform, installedPlatform, arch }) {
  if (platform === 'win32' && filesystem !== 'NTFS') {
    throw new Error(`Windows requires NTFS; detected ${filesystem || 'unknown filesystem'}. Extract the full release to an NTFS USB drive or local disk. exFAT/FAT32 are not supported. Your data has not been changed.`);
  }
  if (!supportsNode(nodeVersion)) throw new Error(`OpenClaw requires Node >=24.16.0 <25 or >=26.1.0; found ${nodeVersion}. Extract a fresh full release; do not mix old and new app folders.`);
  if (!expected || expected !== installed) throw new Error(`OpenClaw version mismatch: expected ${expected}, found ${installed || 'missing'}. Extract a fresh full release or run setup.`);
  if (arch && installedPlatform !== `${platform}-${arch}`) throw new Error('Native runtime platform mismatch. Prepare Windows and macOS in separate folders with their own setup script.');
}

export async function preflight(root) {
  let filesystem;
  if (process.platform === 'win32') {
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'lib/windows-filesystem.ps1'), '-Path', root], {
      windowsHide: true, timeout: 30000,
    });
    filesystem = result.stdout.trim();
  }
  const expected = readFileSync(join(root, 'OPENCLAW_VERSION'), 'utf8').trim();
  const installed = JSON.parse(readFileSync(join(root, 'app/core/node_modules/openclaw/package.json'), 'utf8')).version;
  let installedPlatform;
  try { installedPlatform = readFileSync(join(root, 'app/core/.uclaw-runtime-platform'), 'utf8').trim(); } catch {}
  validateRuntime({ nodeVersion: process.version, expected, installed, filesystem, platform: process.platform, arch: process.arch, installedPlatform });
  return { node: process.version, openclaw: installed, filesystem };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log('[OK] Runtime: ' + JSON.stringify(await preflight(resolve(process.argv[2] || '.')))); }
  catch (error) { console.error('[ERROR] ' + error.message); process.exitCode = 1; }
}
