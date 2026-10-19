// Local-only wait for the shared wallet; never claims a key or logs credentials.
import { hasPicoclawWalletKey } from './picoclaw-config.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitPicoclawKey(picoHome, { timeoutMs = 600_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try { if (hasPicoclawWalletKey({ picoHome })) return true; } catch { /* malformed/unfinished config: wait */ }
    if (Date.now() >= deadline) return false;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ready = await waitPicoclawKey(process.argv[2]);
  if (!ready) console.error('Wallet configuration timed out. Enable a wallet key in Config Center and start again.');
  process.exitCode = ready ? 0 : 1;
}
