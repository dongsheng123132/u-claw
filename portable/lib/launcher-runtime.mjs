// launcher-runtime.mjs — non-JS launchers use this only after unpacking Node.
// The launcher never reimplements runtime selection, seed, activation, or kernel paths.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadChannel } from './runtime-channel.mjs';
import { prepareRuntimePaths, resolveRuntimePaths } from './runtime-paths.mjs';

function channelFor(usbRoot, platform, arch) {
  const bootstrap = resolveRuntimePaths({ usbRoot, platform, arch });
  return loadChannel({ portableDir: usbRoot, target: bootstrap.target });
}

export function prepareLauncherRuntime({ usbRoot, platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const channel = channelFor(usbRoot, platform, arch);
  return { ...prepareRuntimePaths({ usbRoot, nodeVersion: channel.node.version, platform, arch, env }), channel };
}

// The active pointer, not a version string copied into a launcher, chooses the kernel entry.
export function activeLauncherRuntime({ usbRoot, hostRoot, platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const channel = channelFor(usbRoot, platform, arch);
  const paths = resolveRuntimePaths({ usbRoot, nodeVersion: channel.node.version, platform, arch, env, hostRoot });
  let active;
  try { active = JSON.parse(readFileSync(paths.activeKernelFile, 'utf8')); } catch { active = null; }
  const version = typeof active?.version === 'string' ? active.version : null;
  const entry = version && join(paths.kernelsDir, version, 'node_modules', channel.kernel.package, 'openclaw.mjs');
  if (!entry || !existsSync(entry)) throw new Error(`active OpenClaw kernel entry is missing: ${entry || paths.activeKernelFile}`);
  return { paths, channel, version, entry };
}

export function writeStartupStatus(file, status) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...status, updated_at: new Date().toISOString() }), 'utf8');
}

function print(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) process.stdout.write(`${key}=${value}\n`);
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  const [command, usbRoot, hostRoot] = process.argv.slice(2);
  try {
    if (command === 'prepare') {
      const result = prepareLauncherRuntime({ usbRoot });
      if (!result.ok) throw new Error(`neither host nor USB runtime directories are writable: ${result.reason || 'unknown error'}`);
      print({
        UCLAW_RUNTIME_MODE: result.mode,
        UCLAW_RUNTIME_HOST_ROOT: result.paths.hostRoot,
        UCLAW_RUNTIME_NODE_BIN: join(result.paths.nodeHome, result.channel.node.target.nodeRelativePath),
        UCLAW_RUNTIME_COMPILE_CACHE: result.paths.compileCacheDir,
        UCLAW_RUNTIME_LOGS: result.paths.logsDir,
      });
    } else if (command === 'active') {
      const result = activeLauncherRuntime({ usbRoot, hostRoot });
      print({ UCLAW_OPENCLAW_MJS: result.entry, UCLAW_ACTIVE_KERNEL_VERSION: result.version });
    } else if (command === 'status') {
      const [file, phase, pct, ...message] = process.argv.slice(3);
      writeStartupStatus(file, { phase, pct: Number(pct) || 0, message: message.join(' ') });
    } else {
      throw new Error('usage: launcher-runtime.mjs prepare <usbRoot> | active <usbRoot> <hostRoot> | status <file> <phase> <pct> [message]');
    }
  } catch (error) {
    process.stderr.write(`[launcher-runtime] ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
