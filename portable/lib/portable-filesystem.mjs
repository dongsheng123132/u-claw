// Probe only a newly created file. Never retry a failed runtime write in a weaker mode.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function probeRenameIdentity(stateDir, platform = process.platform) {
  if (platform !== 'win32') return { mode: 'strict' };
  stateDir = path.resolve(stateDir);
  let directory, handle;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    directory = await fs.mkdtemp(path.join(stateDir, '.uclaw-fs-probe-'));
    // Use the same long staging-name shape as the SDK's atomic publication.
    const source = path.join(directory, '.uclaw-stage-00000000000000000000000000000000000000000000.tmp');
    const destination = path.join(directory, 'published');
    const bytes = Buffer.from('U-Claw generated-file identity probe\n');
    handle = await fs.open(source, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    const before = await handle.stat({ bigint: true });
    await fs.rename(source, destination);
    const after = await handle.stat({ bigint: true });
    const published = await fs.lstat(destination, { bigint: true });
    const content = await fs.readFile(destination);
    const changed = before.dev !== after.dev || before.ino !== after.ino;
    const verified = published.isFile() && !published.isSymbolicLink()
      && after.dev === published.dev && after.ino === published.ino && content.equals(bytes);
    // Windows exFAT/FAT32 report a constant (usually 0) inode via stat, so
    // rename never looks "changed" even though identity is unstable. Treat an
    // unavailable inode as unreliable identity and fall back to content+lock.
    const inoUnavailable = before.ino === 0n && after.ino === 0n && published.ino === 0n;
    return { mode: (changed || inoUnavailable) && verified ? 'verify-content-with-lock' : 'strict', changed, verified,
      before: before.ino.toString(), after: after.ino.toString(), published: published.ino.toString() };
  } catch (error) {
    return { mode: 'strict', error: error.code || error.name };
  } finally {
    await handle?.close().catch(() => {});
    // Only remove the exact temporary directory created above, within the chosen state folder.
    if (directory && path.dirname(directory) === stateDir && path.basename(directory).startsWith('.uclaw-fs-probe-')) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A missing/ejected disk must not leave the launcher waiting indefinitely.
  const watchdog = setTimeout(() => { console.log('UCLAW_RENAME_IDENTITY=strict'); process.exit(0); }, 5000);
  const result = await probeRenameIdentity(process.argv[2] || '.');
  clearTimeout(watchdog);
  console.log('UCLAW_RENAME_IDENTITY=' + result.mode);
}
