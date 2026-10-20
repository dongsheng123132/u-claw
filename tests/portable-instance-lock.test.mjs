import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquirePortableInstance,
  publishPortableInstance,
  releasePortableInstance,
} from '../portable/lib/portable-instance-lock.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-instance-'));
  return { cacheRoot: join(root, 'cache'), stateDir: join(root, 'usb', 'data', '.openclaw') };
}

test('second launcher reuses a live instance instead of selecting a second port', () => {
  const args = fixture();
  assert.deepEqual(acquirePortableInstance({ ...args, pid: 101, isPidAlive: (pid) => pid === 101 }), { status: 'acquired', port: null });
  assert.equal(publishPortableInstance({ ...args, pid: 101, port: 18790 }), true);
  assert.deepEqual(acquirePortableInstance({ ...args, pid: 202, isPidAlive: (pid) => pid === 101 }), { status: 'existing', port: 18790 });
});

test('a stale launcher lock is replaced safely', () => {
  const args = fixture();
  acquirePortableInstance({ ...args, pid: 101, isPidAlive: () => true });
  assert.deepEqual(acquirePortableInstance({ ...args, pid: 202, isPidAlive: () => false }), { status: 'acquired', port: null });
});

test('an incomplete fresh lock is busy, then only recovers after the grace period', () => {
  const args = fixture();
  mkdirSync(join(args.cacheRoot, 'launcher-instance.lock'), { recursive: true });
  assert.deepEqual(
    acquirePortableInstance({ ...args, pid: 202, isPidAlive: () => false, now: () => Date.now() }),
    { status: 'busy', port: null },
  );
  assert.deepEqual(
    acquirePortableInstance({ ...args, pid: 202, isPidAlive: () => false, now: () => Date.now() + 6_000 }),
    { status: 'acquired', port: null },
  );
});

test('only the owning launcher can release the lock', () => {
  const args = fixture();
  acquirePortableInstance({ ...args, pid: 101, isPidAlive: () => true });
  assert.equal(releasePortableInstance({ ...args, pid: 202 }), false);
  assert.equal(releasePortableInstance({ ...args, pid: 101 }), true);
});
