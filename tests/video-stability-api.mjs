import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { taskIdForKey, fetchGateway } from '../scripts/video-request-id.mjs';

// Never touch a real client's login or real jobs in fault-injection tests.
process.env.DOUBAO_CDP_ENDPOINT = 'http://127.0.0.1:0';
const { config } = await import('../src/config.js');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-stability-'));
config.dataDir = dir;
const { createApp } = await import('../src/gateway.js');
const { wakeEnterpriseVideoWatcher } = await import('../src/enterprise-video-jobs.js');

test('offline client is rejected before creating a task, CLI/MCP return safe diagnostics and restart preserves uncertain submissions', async () => {
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/json' };
  const orphan = randomUUID(), unsent = randomUUID(), jobsDir = path.join(dir, 'enterprise-video-jobs');
  try {
    assert.equal((await fetch(base + '/v1/videos/readiness')).status, 401);
    const readiness = await (await fetch(base + '/v1/videos/readiness', { headers })).json();
    assert.equal(readiness.ready, false); assert.equal(readiness.code, 'client_unavailable');
    const post = await fetch(base + '/v1/videos/generations', { method: 'POST', headers,
      body: JSON.stringify({ provider: 'doubao-desktop', prompt: 'TEST_ONLY_OFFLINE', async: true, idempotency_key: randomUUID() }) });
    assert.equal(post.status, 503);
    const result = await post.json(); assert.equal(result.error.submitted, false); assert.equal(result.error.code, 'client_unavailable');
    assert.deepEqual((await (await fetch(base + '/v1/videos/tasks', { headers })).json()).tasks, []);
    for (const ratio of ['0:0', '99:1']) {
      const bad = await fetch(base + '/v1/videos/generations', { method: 'POST', headers, body: JSON.stringify({ provider: 'doubao-desktop', prompt: 'TEST_ONLY_BAD_RATIO', ratio }) });
      assert.equal(bad.status, 400);
    }
    const run = async (script, args, stdin) => {
      const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, PORT: String(server.address().port), LOCAL_API_KEY: config.localApiKey } });
      let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      child.stdin.end(stdin || ''); const [code] = await once(child, 'close');
      assert.ok(!stdout.includes(config.localApiKey)); assert.ok(!stderr.includes(config.localApiKey));
      return { code, stdout };
    };
    const cli = await run('scripts/doubao-video.mjs', ['generate', 'TEST_ONLY_OFFLINE', '--output', path.join(dir, 'out.mp4')]);
    assert.equal(cli.code, 1); assert.equal(JSON.parse(cli.stdout).error.submitted, false);
    const mcp = await run('scripts/orbit-frame-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_video_connection', arguments: {} } }) + '\n');
    const payload = JSON.parse(mcp.stdout).result.structuredContent; assert.equal(payload.ready, false);
    await fs.mkdir(jobsDir, { recursive: true });
    await fs.writeFile(path.join(jobsDir, `${orphan}.json`), JSON.stringify({ id: orphan, status: 'submitting', createdAt: new Date().toISOString(), videos: [] }));
    await fs.writeFile(path.join(jobsDir, `${unsent}.json`), JSON.stringify({ id: unsent, status: 'submitting', submissionStarted: false, createdAt: new Date().toISOString(), videos: [] }));
    wakeEnterpriseVideoWatcher();
    const deadline = Date.now() + 2000;
    let stored;
    do { stored = JSON.parse(await fs.readFile(path.join(jobsDir, `${orphan}.json`), 'utf8')); if (stored.status === 'unknown') break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
    assert.equal(stored.status, 'unknown'); assert.equal(stored.error.code, 'submit_unknown');
    assert.equal(stored.error.submitted, 'unknown');
    const unsentJob = JSON.parse(await fs.readFile(path.join(jobsDir, `${unsent}.json`), 'utf8'));
    assert.equal(unsentJob.status, 'failed'); assert.equal(unsentJob.error.submitted, false);
    const existing = await fetch(base + `/v1/videos/tasks/${orphan}?refresh=1`, { headers });
    assert.equal((await existing.json()).status, 'unknown'); // No IDs: never blindly resend.
  } finally { server.close(); server.closeAllConnections(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('CLI and MCP preserve the same task ID when the submit response is lost and never resend automatically', async () => {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') { posts++; req.resume(); req.on('end', () => res.destroy()); }
    else { res.writeHead(404); res.end('{}'); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const key = 'lost-response-test', taskId = taskIdForKey(key);
  const run = async (script, args, stdin) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, PORT: String(server.address().port) } });
    let stdout = ''; child.stdout.on('data', b => stdout += b); child.stdin.end(stdin || '');
    await once(child, 'close'); return stdout;
  };
  try {
    const cli = JSON.parse(await run('scripts/doubao-video.mjs', ['generate', 'TEST_ONLY', '--key', key, '--output', path.join(os.tmpdir(), `${randomUUID()}.mp4`)]));
    assert.equal(cli.error.task_id, taskId); assert.equal(cli.error.submitted, 'unknown');
    const mcp = JSON.parse(await run('scripts/orbit-frame-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_and_wait', arguments: { prompt: 'TEST_ONLY', idempotency_key: key } } }) + '\n'));
    assert.equal(mcp.result.structuredContent.error.task_id, taskId);
    assert.equal(posts, 2); // One mutation per explicit invocation, no blind retry.
  } finally { server.close(); server.closeAllConnections(); }
});

test('read-only gateway queries survive a brief disconnect without retrying mutations', async () => {
  let reads = 0;
  const server = http.createServer((req, res) => {
    reads++;
    if (reads === 1) res.destroy();
    else { res.writeHead(200); res.end('{"status":"running"}'); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetchGateway(`http://127.0.0.1:${server.address().port}`, { method: 'GET', signal: AbortSignal.timeout(5000) });
    assert.equal((await response.json()).status, 'running'); assert.equal(reads, 2);
  } finally { server.close(); server.closeAllConnections(); }
});

test('MCP total deadline covers a stalled submission and retains its deterministic task id', async () => {
  let posts = 0;
  const server = http.createServer((req, res) => { posts++; req.resume(); /* Deliberately never respond. */ }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const key = 'deadline-test';
  const began = Date.now();
  const child = spawn(process.execPath, ['scripts/orbit-frame-mcp.mjs'], { env: { ...process.env, PORT: String(server.address().port) } });
  let stdout = ''; child.stdout.on('data', chunk => stdout += chunk);
  try {
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_and_wait', arguments: { prompt: 'TEST_ONLY', idempotency_key: key, timeout_seconds: 10 } } }) + '\n');
    await once(child, 'close');
    assert.ok(Date.now() - began < 11500, '10 second deadline must include POST');
    const result = JSON.parse(stdout).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.task_id, taskIdForKey(key));
    assert.equal(posts, 1);
  } finally { child.kill(); server.close(); server.closeAllConnections(); }
});

test('the total deadline also interrupts read retry backoff', async () => {
  const server = http.createServer((_req, res) => res.destroy()).listen(0, '127.0.0.1'); await once(server, 'listening');
  const began = Date.now();
  try {
    await assert.rejects(fetchGateway(`http://127.0.0.1:${server.address().port}`, { method: 'GET', signal: AbortSignal.timeout(50) }));
    assert.ok(Date.now() - began < 300, 'Retry sleep must be abortable');
  } finally { server.close(); server.closeAllConnections(); }
});
