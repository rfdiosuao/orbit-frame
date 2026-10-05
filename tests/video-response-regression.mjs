import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/gateway.js';
import { config } from '../src/config.js';
const originalFetch = globalThis.fetch;
const originalSessionFile = config.sessionFile;
const originalCdp = process.env.DOUBAO_USE_CDP;
const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-response-test-'));
// This regression uses a mocked provider, so it must not depend on a real
// login record or connect to a user's CDP browser on a fresh checkout.
config.sessionFile = path.join(sessionDir, 'session.json');
process.env.DOUBAO_USE_CDP = '0';
await writeFile(config.sessionFile, JSON.stringify({ sessionId: 'f'.repeat(32), source: 'test' }), { mode: 0o600 });
let scenario = 'quota';
let upstreamCalls = 0;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://www.doubao.com/')) {
    upstreamCalls++;
    const text = scenario === 'quota' ? '今日视频生成免费额度已用完，本次将消耗付费额度。是否继续生成？' : '视频生成已提交，预计等待三分钟，生成好后会主动发送。';
    const event = { event_type: 2001, event_data: JSON.stringify({ conversation_id: '0', message: JSON.stringify({ content_type: 2001, content: JSON.stringify({ text }) }) }) };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200 });
  }
  const host = new URL(String(url)).hostname;
  assert.equal(host, '127.0.0.1', 'Regression must never call a real remote provider');
  return originalFetch(url, options);
};
const server = createApp().listen(0, '127.0.0.1');
await once(server, 'listening');
try {
 for (scenario of ['quota', 'acceptance_without_task']) {
  const start = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/videos/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.localApiKey}` }, body: JSON.stringify({ prompt: 'TEST_ONLY_MOCK_RESPONSE', duration: 5, ratio: '16:9' }), signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  assert.equal(response.status, 500);
  assert.equal(result.pending, undefined);
  assert.equal(result.status, undefined);
  if (scenario === 'acceptance_without_task') assert.equal(result.error.type, 'video_task_unverified');
  assert.ok(Date.now() - start < 5000, 'No empty 12-minute polling');
  console.log(`PASS ${scenario}: rejected without reporting a generated video`);
 }
 assert.equal(upstreamCalls, 2, 'No automatic retries or paid confirmation');
} finally {
 globalThis.fetch = originalFetch;
 config.sessionFile = originalSessionFile;
 if (originalCdp === undefined) delete process.env.DOUBAO_USE_CDP;
 else process.env.DOUBAO_USE_CDP = originalCdp;
 server.close();
 server.closeAllConnections();
 await rm(sessionDir, { recursive: true, force: true });
}
