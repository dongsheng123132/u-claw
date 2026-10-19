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

export function validateRuntime({ nodeVersion, expected, installed, filesystem, platform, installedPlatform, arch, lite = false }) {
  if (platform === 'win32' && !['NTFS','EXFAT'].includes(String(filesystem).toUpperCase())) {
    throw new Error(`Windows requires NTFS or exFAT; detected ${filesystem || 'unknown filesystem'}. FAT32 is not supported. Your data has not been changed.`);
  }
  if (!supportsNode(nodeVersion)) throw new Error(`OpenClaw requires Node >=24.16.0 <25 or >=26.1.0; found ${nodeVersion}. Extract a fresh full release; do not mix old and new app folders.`);
  // Lite（PicoClaw）不依赖 OpenClaw 内核：跳过版本匹配与原生平台校验。
  // 否则干净 U 盘只装了 PicoClaw 时会被误拒（app/core/node_modules/openclaw 不存在）。
  if (!lite) {
    if (!expected || expected !== installed) throw new Error(`OpenClaw version mismatch: expected ${expected}, found ${installed || 'missing'}. Extract a fresh full release or run setup.`);
    if (arch && installedPlatform !== `${platform}-${arch}`) throw new Error('Native runtime platform mismatch. Prepare Windows and macOS in separate folders with their own setup script.');
  }
}

export function runtimeEnvironment(filesystem) {
  return String(filesystem).toUpperCase() === 'EXFAT'
    ? { FS_SAFE_NATIVE_MODE: 'off', OPENCLAW_PORTABLE_RENAME_IDENTITY: 'verify-content-with-lock' }
    : { FS_SAFE_NATIVE_MODE: 'auto', OPENCLAW_PORTABLE_RENAME_IDENTITY: 'strict' };
}

// 公共 preflight：文件系统 + Node 版本（两档共用）。
// 仅在 full（OpenClaw）模式下追加 OpenClaw 专属检查（版本匹配 + 原生平台）。
// filesystem：调用方传入（win32 下由 windows-filesystem.ps1 取），避免模块内跑 PowerShell。
export function validateCommonRuntime({ nodeVersion, filesystem, platform }) {
  validateRuntime({ nodeVersion, filesystem, platform, lite: true });
}

export async function preflight(root, { lite = false } = {}) {
  let filesystem;
  if (process.platform === 'win32') {
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'lib/windows-filesystem.ps1'), '-Path', root], {
      windowsHide: true, timeout: 30000,
    });
    filesystem = result.stdout.trim();
  }
  validateCommonRuntime({ nodeVersion: process.version, filesystem, platform: process.platform });
  // OpenClaw 专属段：Lite 模式跳过（可能没装 OpenClaw）。
  let installed, installedPlatform;
  if (!lite) {
    const expected = readFileSync(join(root, 'OPENCLAW_VERSION'), 'utf8').trim();
    installed = JSON.parse(readFileSync(join(root, 'app/core/node_modules/openclaw/package.json'), 'utf8')).version;
    try { installedPlatform = readFileSync(join(root, 'app/core/.uclaw-runtime-platform'), 'utf8').trim(); } catch {}
    validateRuntime({ nodeVersion: process.version, expected, installed, filesystem, platform: process.platform, arch: process.arch, installedPlatform, lite: false });
  }
  return { node: process.version, openclaw: installed, filesystem };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lite = process.argv.includes('--lite');
  try {
    const result = await preflight(resolve(process.argv[2] || '.'), { lite });
    if (process.argv.includes('--env')) {
      for (const [key,value] of Object.entries(runtimeEnvironment(result.filesystem))) console.log(key+'='+value);
      console.log('UCLAW_RUNTIME_OK=1');
    } else console.log('[OK] Runtime: ' + JSON.stringify(result));
  }
  catch (error) { console.error('[ERROR] ' + error.message); process.exitCode = 1; }
}
