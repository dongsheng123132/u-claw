// OpenClaw 2026.10.2 refuses legacy agent schemas until its official doctor runs.
// Run after the launcher instance lock, before Config Center or Gateway can write.
import { DatabaseSync, backup } from 'node:sqlite';
import { readdir, mkdir, copyFile, rename, open, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const SCHEMA_VERSION = 24; // Contract of the pinned OpenClaw 2026.10.2 runtime.
export async function inspectAgentSchemas(state) {
  const base = join(state, 'agents');
  if (!existsSync(base)) return [];
  const schemas = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(base, entry.name, 'agent', 'openclaw-agent.sqlite');
    if (!existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Saved sessions need a newer OpenClaw runtime (schema ${version}). Keep the newer release; do not downgrade.`);
      schemas.push({ file, version });
    } finally { db.close(); }
  }
  return schemas;
}

async function runDoctor(root, logFile) {
  const output = await open(logFile, 'a');
  try {
    await new Promise((ok, fail) => {
      const child = spawn(process.execPath, [join(root, 'app/core/node_modules/openclaw/openclaw.mjs'), 'doctor', '--fix', '--non-interactive'], {
        cwd: root, windowsHide: true, stdio: ['ignore', output.fd, output.fd],
        env: { ...process.env, OPENCLAW_HOME: join(root, 'data'), OPENCLAW_STATE_DIR: join(root, 'data/.openclaw'), OPENCLAW_CONFIG_PATH: join(root, 'data/.openclaw/openclaw.json') },
      });
      const timer = setTimeout(() => { child.kill(); }, 10 * 60 * 1000);
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) ok(); else fail(new Error(`Session upgrade failed (${signal || code}). See ${logFile}. Keep the backup and retry after closing other OpenClaw instances.`));
      });
    });
  } finally { await output.close(); }
}

export async function upgradeSessionSchema(root, doctor = runDoctor) {
  const state = join(root, 'data/.openclaw');
  const schemas = await inspectAgentSchemas(state);
  if (!schemas.some(item => item.version < SCHEMA_VERSION)) return { upgraded: false };
  const backupDir = join(root, 'data/backups', 'before-core-2026.10.2-' + randomUUID());
  await mkdir(backupDir, { recursive: true });
  await copyFile(join(state, 'openclaw.json'), join(backupDir, 'openclaw.json'));
  // SQLite backup includes committed WAL pages; a plain file copy would not.
  const shared = join(state, 'state/openclaw.sqlite');
  const files = [...schemas.map(item => item.file), ...(existsSync(shared) ? [shared] : [])];
  for (const [index, file] of files.entries()) {
    const db = new DatabaseSync(file, { readOnly: true });
    const target = join(backupDir, `database-${index}.sqlite`);
    try { await backup(db, target + '.tmp'); await rename(target + '.tmp', target); }
    finally { db.close(); }
  }
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify({config:'openclaw.json',databases:files.map((file,index)=>({original:file,backup:`database-${index}.sqlite`}))}, null, 2));
  const logs = join(root, 'data/logs');
  await mkdir(logs, { recursive: true });
  console.log(`Upgrading saved sessions for OpenClaw 2026.10.2. This can take several minutes. Backup: ${backupDir}`);
  await doctor(root, join(logs, 'session-upgrade.log'));
  if ((await inspectAgentSchemas(state)).some(item => item.version < SCHEMA_VERSION)) throw new Error('Session upgrade incomplete. See data/logs/session-upgrade.log; your pre-upgrade backup has been retained.');
  return { upgraded: true, backupDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await upgradeSessionSchema(resolve(process.argv[2])); }
  catch (error) { console.error('[ERROR] ' + error.message); process.exitCode = 1; }
}
