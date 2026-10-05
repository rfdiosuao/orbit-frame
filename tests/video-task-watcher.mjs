import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/gateway.js';
import { config } from '../src/config.js';
import { jobEvents } from '../src/enterprise-video-jobs.js';

// A running job without conversation/run IDs is never handed to the watcher,
// so these checks exercise only local state and never touch Doubao CDP.
test('task status reads local state and streams updates over SSE', async () => {
  const id = randomUUID();
  const dir = path.join(config.dataDir, 'enterprise-video-jobs');
  const file = path.join(dir, `${id}.json`);
  const now = new Date().toISOString();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ id, fingerprint: id, prompt: 'TEST_ONLY_WATCHER', requestedModel: 'Seedance 2.0 Fast',
    options: { duration: 5, ratio: '16:9' }, status: 'running', videos: [], pending: [], confirmedIds: [],
    confirmationAttemptedIds: [], createdAt: now, updatedAt: now }), { mode: 0o600 });
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${config.localApiKey}` };
  try {
    const started = Date.now();
    const status = await fetch(`${base}/v1/videos/tasks/${id}`, { headers });
    assert.equal(status.status, 202);
    const job = await status.json();
    assert.equal(job.phase, 'submitted');
    assert.ok(Date.now() - started < 500, 'Status query must not wait on Doubao');

    assert.equal((await fetch(`${base}/v1/videos/tasks/${id}/events`)).status, 401);
    const stream = await fetch(`${base}/v1/videos/tasks/${id}/events`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = (await reader.read()).value;
    assert.match(text, /"status":"running"/);
    jobEvents.emit(id, { ...job, id, status: 'completed', phase: 'ready', created_at: now });
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += chunk.value;
    assert.match(text, /"status":"completed"/);
    assert.match(text, /"phase":"ready"/);
  } finally {
    server.close();
    server.closeAllConnections();
    await fs.rm(file, { force: true });
  }
});
