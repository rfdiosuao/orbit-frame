import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/gateway.js';
import { config } from '../src/config.js';

const server = createApp().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const unauthenticated = await fetch(`${base}/v1/videos/tasks`);
  assert.equal(unauthenticated.status, 401);
  const response = await fetch(`${base}/v1/videos/tasks`, { headers: { Authorization: `Bearer ${config.localApiKey}` } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.tasks));
  const allowed = new Set(['task_id', 'status', 'prompt', 'duration', 'ratio', 'created_at', 'updated_at', 'videos']);
  const videoAllowed = new Set(['id', 'width', 'height', 'duration']);
  for (const task of data.tasks) {
    assert.ok(Object.keys(task).every(key => allowed.has(key)), 'Task list contains only UI metadata');
    assert.match(task.task_id, /^(?:[0-9a-f-]{36}|[0-9a-f]{64})$/);
    assert.ok(Array.isArray(task.videos));
    for (const video of task.videos) assert.ok(Object.keys(video).every(key => videoAllowed.has(key)), 'No file path or source URL leaves the task list');
  }
  console.log(`PASS video library: authorization and safe metadata schema (${data.tasks.length} tasks)`);
} finally {
  server.close();
  server.closeAllConnections();
}
