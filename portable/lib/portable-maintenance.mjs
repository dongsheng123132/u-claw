#!/usr/bin/env node
// U-Claw portable maintenance helper (zero dependency).
// Called by Windows-Maintain.bat / Mac-Maintain.command — the menus only collect
// input and open things; every business action lives here once.
//
// Subcommands:
//   settings-url                      print the config-center URL of the current instance
//   logs-path                         print the local log directory (from portable-cache)
//   backup [--output PATH]            openclaw backup create --verify --output <path>
//   restore <archive> [--target DIR]  openclaw backup restore <archive> --target <fresh dir>
//
// stdout = result only. stderr = logs / user guidance. Exit codes: 0 ok, 1 soft
// failure / usage / timeout, otherwise the native backup CLI's own exit code.
//
// Backup/restore artifacts are durable user data, not cache: they land under
// <portable-root>/data/backups/ (on the USB drive) by default so disk-cleanup
// tools that wipe %LOCALAPPDATA% cannot eat them. --output / --target override.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePortableCache } from './portable-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTABLE_ROOT = resolve(HERE, '..');
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || join(PORTABLE_ROOT, 'data', '.openclaw');
const HOME_DIR = process.env.OPENCLAW_HOME || join(PORTABLE_ROOT, 'data');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(STATE_DIR, 'openclaw.json');
const OPENCLAW_MJS = process.env.UCLAW_OPENCLAW_MJS
  || join(PORTABLE_ROOT, 'app', 'core', 'node_modules', 'openclaw', 'openclaw.mjs');

// UCLAW_DIR 覆盖便携根（默认取本文件所在 portable/ 根）；测试用它钉住 U 盘边界。
function usbRoot() {
  return process.env.UCLAW_DIR || PORTABLE_ROOT;
}

// Must match config-server/server.js instanceId algorithm exactly:
// sha256(path.resolve(stateDir)) hex — foreign/stale runtime ports fail the check.
export function instanceIdOf(stateDir) {
  return createHash('sha256').update(resolve(stateDir)).digest('hex');
}

// Local loopback HTTP on a cold slow USB + Defender scan can exceed 1.5s;
// 5s is still instant feedback for a human but does not misjudge a live instance.
const SETTINGS_TIMEOUT_MS = 5000;
// create is smaller than restore (restore unpacks everything).
export const CREATE_TIMEOUT_MS = 10 * 60 * 1000;
export const RESTORE_TIMEOUT_MS = 30 * 60 * 1000;

function envTimeout(name, fallback) {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function die(message, code = 1) {
  process.stderr.write(`[portable-maintenance] ${message}\n`);
  process.exit(code);
}

function childEnv() {
  return {
    ...process.env,
    OPENCLAW_HOME: HOME_DIR,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_CONFIG_PATH: CONFIG_PATH,
  };
}

function runOpenClaw(args, timeoutMs) {
  return new Promise((resolveDone) => {
    if (!existsSync(OPENCLAW_MJS)) {
      resolveDone({ ok: false, code: 1, reason: `openclaw CLI not found: ${OPENCLAW_MJS}` });
      return;
    }
    execFile(process.execPath, [OPENCLAW_MJS, ...args], {
      env: childEnv(),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (!error) {
        resolveDone({ ok: true, code: 0 });
        return;
      }
      if (error.killed) {
        resolveDone({ ok: false, code: 1, reason: `timed out after ${timeoutMs}ms` });
        return;
      }
      resolveDone({ ok: false, code: typeof error.code === 'number' ? error.code : 1, reason: error.message });
    });
  });
}

function localCache() {
  const injected = (process.env.UCLAW_CACHE_CANDIDATES || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean);
  return resolvePortableCache({
    stateDir: STATE_DIR,
    usbRoot: usbRoot(),
    candidates: injected.length ? injected : undefined,
  });
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

const SESSIONS_NOTE = '[portable-maintenance] note: live agents/**/sessions/*.jsonl are volatile and are skipped by official backup\n';
const USB_NOTE = '[portable-maintenance] this directory is on the portable drive (durable, travels with the USB stick)\n';

// settingsUrl: read runtime.json.configServerPort → GET /api/runtime → verify
// the instanceId fingerprint. Throws on any failure; never returns a URL for
// a foreign/stale config server.
export async function settingsUrl(stateDir, { fetchImpl, timeoutMs = SETTINGS_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || fetch;
  const dir = resolve(stateDir);
  let runtime = {};
  try {
    runtime = existsSync(join(dir, 'runtime.json'))
      ? JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'))
      : {};
  } catch {
    throw new Error('runtime.json is unreadable; start U-Claw first (Windows-Start.bat / Mac-Start.command)');
  }
  const port = Number.isInteger(runtime.configServerPort) ? runtime.configServerPort : null;
  if (!port) throw new Error('no config server port in runtime.json; start U-Claw first (Windows-Start.bat / Mac-Start.command)');

  let body;
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/api/runtime`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`config server answered ${res.status}; start U-Claw first`);
    body = await res.json();
  } catch (err) {
    if (err && err.message && /config server answered/.test(err.message)) throw err;
    throw new Error('config server not reachable; start U-Claw first (Windows-Start.bat / Mac-Start.command)');
  }

  const expected = instanceIdOf(dir);
  if (!body || body.instanceId !== expected) {
    throw new Error('port/portable instance mismatch (foreign or stale config server); start this U-Claw first');
  }
  return `http://127.0.0.1:${port}/`;
}

// createBackup: default output is a fresh timestamped folder under
// <portable-root>/data/backups/ (USB, durable). Returns the spawn result
// { ok, code, reason } with the child's real exit code preserved.
export async function createBackup({ output, timeoutMs } = {}) {
  const limit = timeoutMs || envTimeout('UCLAW_BACKUP_TIMEOUT_MS', CREATE_TIMEOUT_MS);
  const target = output
    ? resolve(output)
    : join(usbRoot(), 'data', 'backups', timestampSlug());
  try { mkdirSync(target, { recursive: true }); } catch (err) {
    throw new Error(`cannot create backup target: ${err.message}`);
  }

  process.stderr.write(SESSIONS_NOTE);
  process.stderr.write(USB_NOTE);
  process.stderr.write(`[portable-maintenance] backup output: ${target}\n`);
  return runOpenClaw(['backup', 'create', '--verify', '--output', target], limit);
}

// restoreBackup: target must not exist or be an empty directory — never
// overwrites STATE_DIR or any existing data. Default target is a fresh unique
// folder under <portable-root>/data/backups/. Returns the spawn result.
export async function restoreBackup({ archive, target, timeoutMs } = {}) {
  const src = archive ? resolve(archive) : null;
  if (!src) throw new Error('usage: portable-maintenance.mjs restore <archive> [--target DIR]');
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`archive not found: ${src}`);

  const limit = timeoutMs || envTimeout('UCLAW_RESTORE_TIMEOUT_MS', RESTORE_TIMEOUT_MS);
  const dest = target
    ? resolve(target)
    : join(usbRoot(), 'data', 'backups', `restore-${timestampSlug()}-${randomBytes(4).toString('hex')}`);

  if (existsSync(dest)) {
    const st = statSync(dest);
    if (!st.isDirectory()) throw new Error(`restore target exists and is not a directory: ${dest}`);
    const entries = readdirSync(dest);
    if (entries.length > 0) throw new Error(`restore target must be empty or non-existent: ${dest}`);
  } else {
    try { mkdirSync(dest, { recursive: true }); } catch (err) {
      throw new Error(`cannot create restore target: ${err.message}`);
    }
  }

  process.stderr.write(SESSIONS_NOTE);
  process.stderr.write(USB_NOTE);
  process.stderr.write(`[portable-maintenance] restore target (fresh, empty): ${dest}\n`);
  const r = await runOpenClaw(['backup', 'restore', src, '--target', dest], limit);
  if (r.ok) {
    process.stderr.write('[portable-maintenance] restore finished. The restore directory is on the portable drive; stop the Gateway before activating the new copy — nothing existing was overwritten.\n');
    process.stdout.write(`${dest}\n`);
  }
  return r;
}

async function cmdSettingsUrl() {
  try {
    const url = await settingsUrl(STATE_DIR);
    process.stdout.write(`${url}\n`);
  } catch (err) {
    die(err && err.message ? err.message : String(err));
  }
}

function cmdLogsPath() {
  const c = localCache();
  if (!c.localCacheAvailable || !c.logDir) {
    die('no writable local cache directory; refusing to fall back to the portable drive');
  }
  process.stdout.write(`${c.logDir}\n`);
}

async function cmdBackup(argv) {
  let output = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output') {
      output = argv[i + 1] || null;
      i += 1;
    }
  }
  try {
    const r = await createBackup({ output });
    if (!r.ok) die(r.reason || 'backup failed', r.code || 1);
  } catch (err) {
    die(err && err.message ? err.message : String(err), 1);
  }
}

async function cmdRestore(argv) {
  let archive = null;
  let target = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') {
      target = argv[i + 1] || null;
      i += 1;
    } else if (!argv[i].startsWith('-') && archive === null) {
      archive = argv[i];
    }
  }
  try {
    const r = await restoreBackup({ archive, target });
    if (!r.ok) die(r.reason || 'restore failed', r.code || 1);
  } catch (err) {
    die(err && err.message ? err.message : String(err), 1);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'settings-url') return cmdSettingsUrl();
  if (cmd === 'logs-path') return cmdLogsPath();
  if (cmd === 'backup') return cmdBackup(rest);
  if (cmd === 'restore') return cmdRestore(rest);
  process.stderr.write('usage: portable-maintenance.mjs settings-url|logs-path|backup [--output PATH]|restore <archive> [--target DIR]\n');
  process.exit(1);
}

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  main().catch((err) => die(err && err.message ? err.message : String(err)));
}
