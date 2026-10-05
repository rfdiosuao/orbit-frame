#!/usr/bin/env node
// Local CLI for the authenticated gateway. Never prints LOCAL_API_KEY or signed media URLs.
import { config } from '../src/config.js';

const [command, ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${config.port}`;
const headers = { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/json' };

function value(flag, fallback) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
}

async function request(method, endpoint, body) {
  const response = await fetch(`${base}${endpoint}`, { method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(590_000) });
  const json = await response.json();
  process.stdout.write(`${JSON.stringify(json)}\n`);
  if (['failed', 'cancelled', 'video_missing'].includes(json.status) || !response.ok && response.status !== 202) process.exitCode = 1;
  else if (['waiting_input', 'unknown', 'extraction_failed'].includes(json.status)) process.exitCode = 2;
}

if (command === 'submit') {
  const prompt = args[0];
  if (!prompt || prompt.startsWith('--')) throw new Error('Usage: submit "prompt" [--model name] [--duration 5] [--ratio 16:9] [--key id] [--async]');
  await request('POST', '/v1/videos/generations', {
    provider: 'doubao-desktop', prompt,
    model: value('--model', 'Seedance 2.0 Fast'),
    duration: Number(value('--duration', 5)), ratio: value('--ratio', '16:9'),
    ...(value('--key', '') ? { idempotency_key: value('--key', '') } : {}),
    async: args.includes('--async'),
  });
} else if (command === 'status') {
  if (!args[0]) throw new Error('Usage: status <task-id> [--wait-seconds 30]');
  const seconds = Math.max(0, Math.min(60, Number(value('--wait-seconds', 0))));
  await request('GET', `/v1/videos/tasks/${encodeURIComponent(args[0])}?wait_seconds=${seconds}`);
} else if (command === 'recover') {
  if (!args[0] || !args[1]) throw new Error('Usage: recover <conversation-id> <run-id>');
  await request('POST', '/v1/videos/recover', { conversation_id: args[0], run_id: args[1] });
} else if (command === 'download') {
  if (!args[0] || !args[1]) throw new Error('Usage: download <video-id> <output.mp4>');
  const response = await fetch(`${base}/v1/videos/files/${encodeURIComponent(args[0])}`, {
    headers, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const { writeFile } = await import('node:fs/promises');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Downloaded file is not an MP4');
  await writeFile(args[1], bytes, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ file: args[1], bytes: bytes.length })}\n`);
} else {
  throw new Error('Usage: doubao-video submit|status|recover|download ...');
}
