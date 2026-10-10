import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

// Ports do not define ownership: two gateways may share the same task directory.
export function createWatcherLease(dir, { pid = process.pid, alive = processAlive, now = Date.now } = {}) {
  const lock = path.join(dir, '.watcher.lock'), token = randomUUID();
  let owned = false;
  return async () => {
    if (owned) return true;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid, token }), { mode: 0o600 });
      owned = true; return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      const stat = await fs.stat(lock).catch(() => null);
      if (owner?.pid ? alive(owner.pid) : !stat || now() - stat.mtimeMs < 30_000) return false;
      const stale = `${lock}.stale.${randomUUID()}`;
      await fs.rename(lock, stale).then(() => fs.rm(stale, { recursive: true, force: true })).catch(() => {});
      return false; // Re-contend next tick; another process may have won.
    }
  };
}
