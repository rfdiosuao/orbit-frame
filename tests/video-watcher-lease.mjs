import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWatcherLease } from '../src/video-watcher-lease.js';

test('gateways sharing a directory have one watcher; a dead owner can be replaced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-watcher-lease-'));
  const live = new Set([101, 202]);
  const alive = pid => live.has(pid);
  const first = createWatcherLease(dir, { pid: 101, alive });
  const second = createWatcherLease(dir, { pid: 202, alive });
  try {
    const results = await Promise.all([first(), second()]);
    assert.equal(results.filter(Boolean).length, 1);
    const follower = results[0] ? second : first;
    assert.equal(await follower(), false);
    live.delete(results[0] ? 101 : 202);
    assert.equal(await follower(), false); // Safely remove stale ownership first.
    assert.equal(await follower(), true);
    const owner = JSON.parse(await fs.readFile(path.join(dir, '.watcher.lock/owner.json')));
    assert.equal(owner.pid, results[0] ? 202 : 101);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
