import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
process.env.DOUBAO_CDP_ENDPOINT = 'http://127.0.0.1:0';
const { config } = await import('../src/config.js');
config.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-events-'));
const { createApp } = await import('../src/gateway.js');
const { jobEvents } = await import('../src/enterprise-video-jobs.js');
after(() => fs.rm(config.dataDir, { recursive: true, force: true }));

test('canvas SSE reports a missing task instead of leaving its card loading forever', async () => {
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  const controller = new AbortController();
  try {
    const id = randomUUID();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/videos/events?ids=${id}`, { headers: { Authorization: `Bearer ${config.localApiKey}` }, signal: controller.signal });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const chunk = await reader.read();
    assert.match(chunk.value, /"status":"failed"/); assert.match(chunk.value, /task_not_found/);
    controller.abort();
  } finally { server.close(); server.closeAllConnections(); }
});

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
    jobEvents.emit(id, { ...job, id, status: 'unknown', run_id: 'test-run', error: { code: 'connection_lost' }, created_at: now });
    const recovering = await reader.read();
    assert.equal(recovering.done, false, 'Temporary observation failure must not close SSE');
    text += recovering.value;
    assert.match(text, /"status":"unknown"/);
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

test('SSE catches a status written by another process without querying Doubao', async () => {
  const id = randomUUID(), dir = path.join(config.dataDir, 'enterprise-video-jobs'), file = path.join(dir, `${id}.json`);
  const job = { id, status: 'running', videos: [], createdAt: new Date().toISOString() };
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file, JSON.stringify(job));
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/videos/tasks/${id}/events`, {
      headers: { Authorization: `Bearer ${config.localApiKey}` }, signal: AbortSignal.timeout(20000),
    });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    assert.match((await reader.read()).value, /"status":"running"/);
    // No EventEmitter notification: emulate another process's atomic write.
    await fs.writeFile(file + '.tmp', JSON.stringify({ ...job, status: 'completed' })); await fs.rename(file + '.tmp', file);
    let received = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) received += chunk.value;
    assert.match(received, /"status":"completed"/);
  } finally { server.close(); server.closeAllConnections(); await fs.rm(file, { force: true }); }
});
