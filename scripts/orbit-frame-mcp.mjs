#!/usr/bin/env node
// Local stdio MCP server for Orbit Frame video generation.
// Reads LOCAL_API_KEY itself so the key never enters prompts or tool output.
// stdout carries JSON-RPC only; diagnostics go to stderr.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';

const base = `http://127.0.0.1:${config.port}`;
const headers = { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/json' };
const outputDir = path.resolve(process.env.ORBIT_FRAME_OUTPUT_DIR || path.join(config.dataDir, 'exports'));
const activeStatuses = ['submitting', 'running'];

const tools = [
  {
    name: 'generate_and_wait',
    description: `Generate a video with Doubao (Seedance) through the local Orbit Frame gateway: text_to_video, image_to_video (first_frame) or first_last_frame (first_frame + last_frame). Frame images must be PNG/JPEG/WebP files inside ${config.mediaDir}. By default waits until the MP4 is downloaded and validated, then returns task_id, local file path and preview URL. If it times out, call get_video_status with the returned task_id; never resubmit the same prompt.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the video should show.' },
        model: { type: 'string', default: 'Seedance 2.0 Fast' },
        duration: { type: 'integer', minimum: 1, maximum: 15, default: 5, description: 'Seconds.' },
        ratio: { type: 'string', default: '16:9', description: 'Aspect ratio such as 16:9, 9:16, 1:1.' },
        mode: { type: 'string', enum: ['text_to_video', 'image_to_video', 'first_last_frame'], default: 'text_to_video' },
        first_frame: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
          description: 'Required for image_to_video and first_last_frame. Path inside the media directory (absolute or relative to it).' },
        last_frame: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
          description: 'Required for first_last_frame only.' },
        wait: { type: 'boolean', default: true },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 3600, default: 900 },
        idempotency_key: { type: 'string', description: 'Reuse to resume the same request instead of creating a new video.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_video_status',
    description: 'Read the status and phase of a video task. Optionally wait up to 60 seconds for it to change.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 60, default: 0 },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'download_video',
    description: `Copy a completed task's MP4 into the export directory (${outputDir}). Only a file name may be chosen, not a directory.`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        filename: { type: 'string', description: 'Optional file name ending in .mp4.' },
      },
      required: ['task_id'],
    },
  },
];

async function request(method, endpoint, body, timeoutMs = 120_000) {
  let response;
  try {
    response = await fetch(`${base}${endpoint}`, { method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'Gateway request timed out' : `Gateway is not reachable at ${base}; run "npm start" first`);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) throw new Error(json?.error?.message || `Gateway returned HTTP ${response.status}`);
  return json;
}

function summary(job) {
  const video = job.videos?.find(item => item?.id);
  return {
    task_id: job.task_id, status: job.status, phase: job.phase ?? null,
    prompt: job.prompt, duration: job.duration, ratio: job.ratio,
    requested_model: job.requested_model, message: job.message || null, mode: job.mode,
    frames: (job.frames || []).map(({ role, width, height }) => ({ role, width, height })),
    ...(job.warnings?.length ? { warnings: job.warnings } : {}),
    ...(video ? {
      video_id: video.id, width: video.width, height: video.height, video_duration: video.duration,
      file: path.join(config.dataDir, 'videos', `${video.id}.mp4`),
    } : {}),
    preview_url: `${base}/?task=${encodeURIComponent(job.task_id)}`,
  };
}

function validTaskId(value) {
  const id = String(value || '');
  if (!/^(?:[0-9a-f-]{36}|[0-9a-f]{64})$/.test(id)) throw new Error('Invalid task_id');
  return id;
}

async function waitFor(taskId, deadline, progress) {
  let job = await request('GET', `/v1/videos/tasks/${taskId}`);
  while (activeStatuses.includes(job.status) && Date.now() < deadline) {
    progress(job);
    const seconds = Math.max(1, Math.min(30, Math.floor((deadline - Date.now()) / 1000)));
    job = await request('GET', `/v1/videos/tasks/${taskId}?wait_seconds=${seconds}`, null, (seconds + 30) * 1000);
  }
  return job;
}

async function generateAndWait(args, progress) {
  const timeout = Math.max(10, Math.min(3600, Number(args.timeout_seconds) || 900));
  const deadline = Date.now() + timeout * 1000;
  let job = await request('POST', '/v1/videos/generations', {
    provider: 'doubao-desktop', prompt: args.prompt, model: args.model || 'Seedance 2.0 Fast',
    duration: Number(args.duration ?? 5), ratio: args.ratio || '16:9', mode: args.mode || 'text_to_video',
    ...(args.first_frame ? { first_frame: args.first_frame } : {}),
    ...(args.last_frame ? { last_frame: args.last_frame } : {}),
    idempotency_key: args.idempotency_key || randomUUID(), async: true,
  });
  if (!job?.task_id) throw new Error('Gateway did not return a task_id');
  if (args.wait !== false) job = await waitFor(job.task_id, deadline, progress);
  const result = summary(job);
  if (activeStatuses.includes(job.status) && args.wait !== false) {
    result.timed_out = true;
    result.next_step = 'Call get_video_status with this task_id to keep waiting; do not resubmit.';
  }
  return result;
}

async function downloadVideo(args) {
  const taskId = validTaskId(args.task_id);
  const job = await request('GET', `/v1/videos/tasks/${taskId}`);
  const video = job.videos?.find(item => /^[0-9a-f]{32,64}$/.test(String(item?.id || '')));
  if (job.status !== 'completed' || !video) throw new Error(`Task is ${job.status}; no video to download yet`);
  const name = args.filename ? String(args.filename) : `orbit-frame-${taskId.slice(0, 8)}.mp4`;
  if (name !== path.basename(name) || !/^[\w一-鿿 .-]{1,120}\.mp4$/i.test(name) || name.startsWith('.')) {
    throw new Error('filename must be a plain name ending in .mp4');
  }
  const response = await fetch(`${base}/v1/videos/files/${video.id}`, { headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Video download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 32 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Downloaded file is not an MP4');
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const file = path.join(outputDir, name);
  try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('A file with that name already exists; choose another filename'); throw error; }
  return { task_id: taskId, video_id: video.id, file, bytes: bytes.length };
}

async function callTool(name, args = {}, progress) {
  if (name === 'generate_and_wait') return generateAndWait(args, progress);
  if (name === 'get_video_status') {
    const seconds = Math.max(0, Math.min(60, Number(args.wait_seconds) || 0));
    return summary(await request('GET', `/v1/videos/tasks/${validTaskId(args.task_id)}?wait_seconds=${seconds}`, null, (seconds + 30) * 1000));
  }
  if (name === 'download_video') return downloadVideo(args);
  throw new Error(`Unknown tool: ${name}`);
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'orbit-frame', version: '1.0.0' } } });
  }
  if (id === undefined) return; // Notifications such as notifications/initialized.
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method === 'tools/call') {
    const token = params._meta?.progressToken;
    let step = 0;
    const progress = job => {
      if (token === undefined) return;
      send({ method: 'notifications/progress', params: { progressToken: token, progress: ++step,
        message: `${job.status}${job.phase ? ` / ${job.phase}` : ''}` } });
    };
    try {
      const result = await callTool(params.name, params.arguments, progress);
      return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    } catch (error) {
      return send({ id, result: { isError: true, content: [{ type: 'text', text: String(error.message || error) }] } });
    }
  }
  return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(message).catch(error => process.stderr.write(`orbit-frame-mcp: ${error.message}\n`));
});
