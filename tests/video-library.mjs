import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
process.env.DOUBAO_CDP_ENDPOINT = 'http://127.0.0.1:0';
const { config } = await import('../src/config.js');
config.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-library-'));
const { createApp } = await import('../src/gateway.js');
after(() => fs.rm(config.dataDir, { recursive: true, force: true }));

test('library pages expose older tasks and see atomic writes from another process', async () => {
  const dir = path.join(config.dataDir, 'enterprise-video-jobs'); await fs.mkdir(dir);
  const ids = Array.from({ length: 105 }, () => randomUUID());
  await Promise.all(ids.map((id, index) => fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, status: 'completed',
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(), prompt: 'TEST_ONLY', videos: [] }))));
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${config.localApiKey}` };
  const get = async query => (await (await fetch(base + '/v1/videos/tasks' + query, { headers })).json());
  try {
    const page = await get('?limit=100'); assert.equal(page.tasks.length, 100); assert.equal(page.next_cursor, ids[5]);
    const rest = await get(`?before=${page.next_cursor}`); assert.equal(rest.tasks.length, 5); assert.equal(rest.next_cursor, null);
    assert.equal(new Set([...page.tasks, ...rest.tasks].map(task => task.task_id)).size, 105);
    const latest = path.join(dir, `${ids[104]}.json`), changed = JSON.parse(await fs.readFile(latest, 'utf8'));
    changed.status = 'failed'; await fs.writeFile(latest + '.tmp', JSON.stringify(changed)); await fs.rename(latest + '.tmp', latest);
    assert.equal((await get('?limit=1')).tasks[0].status, 'failed');
    assert.equal((await fetch(base + '/v1/videos/tasks?before=bad', { headers })).status, 400);
  } finally { server.close(); server.closeAllConnections(); }
});
