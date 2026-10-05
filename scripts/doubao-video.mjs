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

async function request(method, endpoint, body, { quiet = false, timeout = 590_000 } = {}) {
  const response = await fetch(`${base}${endpoint}`, { method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
  const json = await response.json();
  if (!quiet) process.stdout.write(`${JSON.stringify(json)}\n`);
  if (['failed', 'cancelled', 'video_missing'].includes(json.status) || !response.ok && response.status !== 202) process.exitCode = 1;
  else if (['waiting_input', 'unknown', 'extraction_failed'].includes(json.status)) process.exitCode = 2;
  if (quiet && !response.ok && response.status !== 202) throw new Error(json?.error?.message || `HTTP ${response.status}`);
  return json;
}

async function download(id, output) {
  const response = await fetch(`${base}/v1/videos/files/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const { writeFile } = await import('node:fs/promises');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Downloaded file is not an MP4');
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  return { file: output, bytes: bytes.length };
}

if (command === 'generate') {
  const output = value('--output', '');
  const existing = value('--task', '');
  const seconds = Number(value('--timeout-seconds', 900));
  if (!output || !Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error('generate requires --output file.mp4 and timeout 1..86400 seconds');
  const { access } = await import('node:fs/promises');
  try { await access(output); throw new Error('Output already exists; choose a new filename'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deadline = Date.now() + seconds * 1000;
  let job;
  if (existing) job = { task_id: existing, status: 'running' };
  else {
    if (!args[0] || args[0].startsWith('--')) throw new Error('generate requires a prompt or --task id');
    const { randomUUID } = await import('node:crypto');
    job = await request('POST', '/v1/videos/generations', { provider: 'doubao-desktop', prompt: args[0], model: value('--model', 'Seedance 2.0 Fast'), duration: Number(value('--duration', 5)), ratio: value('--ratio', '16:9'), idempotency_key: value('--key', randomUUID()), async: true }, { quiet: true, timeout: Math.min(60000, seconds * 1000) });
  }
  while (['running', 'submitting'].includes(job.status)) {
    if (!job.task_id) throw new Error('Gateway did not return a task_id');
    const remaining = deadline - Date.now();
    if (remaining <= 0) { job = { ...job, timed_out: true, message: 'Timeout; resume with generate --task TASK_ID --output FILE' }; process.exitCode = 2; break; }
    process.stderr.write(`Task ${job.task_id}: ${job.status}\n`);
    try {
      job = await request('GET', `/v1/videos/tasks/${encodeURIComponent(job.task_id)}?wait_seconds=${Math.min(30, Math.floor(remaining / 1000))}`, null, { quiet: true, timeout: remaining });
    } catch (error) {
      if (Date.now() >= deadline || error.name === 'TimeoutError') { job = { ...job, timed_out: true, message: 'Timeout; query the same task to resume' }; process.exitCode = 2; break; }
      throw error;
    }
    if (['running', 'submitting'].includes(job.status)) await new Promise(r => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
  if (job.status === 'completed') {
    if (!job.videos?.[0]?.id) { job = { ...job, status: 'video_missing' }; process.exitCode = 1; }
    else job = { ...job, ...await download(job.videos[0].id, output) };
  } else if (['failed', 'cancelled', 'video_missing'].includes(job.status)) process.exitCode = 1;
  else process.exitCode = 2;
  process.stdout.write(`${JSON.stringify(job)}\n`);
} else if (command === 'submit') {
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
  process.stdout.write(`${JSON.stringify(await download(args[0], args[1]))}\n`);
} else {
  throw new Error('Usage: doubao-video generate|submit|status|recover|download ...');
}
