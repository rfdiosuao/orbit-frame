import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/gateway.js';
import { config } from '../src/config.js';
const originalFetch = globalThis.fetch;
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
 server.close();
 server.closeAllConnections();
}
