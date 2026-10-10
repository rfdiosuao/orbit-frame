#!/usr/bin/env node
// Local CLI for the authenticated gateway. Never prints LOCAL_API_KEY or signed media URLs.
import { config } from '../src/config.js';
import { taskIdForKey, resumableVideoError, fetchGateway } from './video-request-id.mjs';
import { followsVideoTask, isCloudVideo, needsCloudExtraction } from '../public/video-task-state.js';
import { prepareVideoFrames, uploadFrame } from './frame-workflow.mjs';

const [command, ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${config.port}`;
const headers = { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/json' };
const argumentError = message => Object.assign(new Error(message), {diagnostic:{code:'invalid_argument',message,submitted:false}});
function validateArguments() {
  const valued = new Set(['--mode','--first-frame','--last-frame','--canvas','--key','--card','--title','--model','--duration','--ratio','--output','--task','--timeout-seconds','--wait-seconds']);
  const boolean = new Set(['--async','--refresh']);
  const allowed = {
    generate:['--mode','--first-frame','--last-frame','--canvas','--key','--card','--model','--duration','--ratio','--output','--task','--timeout-seconds'],
    submit:['--mode','--first-frame','--last-frame','--key','--model','--duration','--ratio','--async'],
    scene:['--mode','--first-frame','--last-frame','--canvas','--key','--card','--title','--model','--duration','--ratio'],
    status:['--wait-seconds','--refresh'],
  }[command] || [];
  const seen=new Set();let positional=0;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(!arg.startsWith('-')) {positional++;continue;}
    if(!allowed.includes(arg) || !valued.has(arg) && !boolean.has(arg)) throw argumentError(`Unknown option ${arg} for ${command}`);
    if(seen.has(arg)) throw argumentError(`Duplicate option ${arg}`);
    seen.add(arg);
    if(valued.has(arg)) {if(!args[i+1] || args[i+1].startsWith('--')) throw argumentError(`Missing value for ${arg}`);i++;}
  }
  const max=['recover','download'].includes(command)?2:['check','help','--help','-h'].includes(command)?0:1;
  if(positional>max) throw argumentError('Unexpected positional argument');
}

function value(flag, fallback) {
  const at = args.indexOf(flag);
  if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith('--'))) throw Object.assign(new Error(`Missing value for ${flag}`), {
    diagnostic: { code: 'invalid_argument', message: `Missing value for ${flag}`, submitted: false } });
  return at >= 0 ? args[at + 1] : fallback;
}

async function frameOptions() {
  return prepareVideoFrames({ mode: value('--mode', 'auto'),
    ...(value('--first-frame', '') ? { first_frame: { path: value('--first-frame', '') } } : {}),
    ...(value('--last-frame', '') ? { last_frame: { path: value('--last-frame', '') } } : {}) });
}

async function request(method, endpoint, body, { quiet = false, timeout = 590_000 } = {}) {
  const response = await fetchGateway(`${base}${endpoint}`, { method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
  const json = await response.json();
  if (!quiet) process.stdout.write(`${JSON.stringify(json)}\n`);
  if (['failed', 'cancelled', 'video_missing'].includes(json.status) || !response.ok && response.status !== 202) process.exitCode = 1;
  else if (['waiting_input', 'unknown', 'extraction_failed'].includes(json.status)) process.exitCode = 2;
  if (quiet && !response.ok && response.status !== 202) throw Object.assign(new Error(json?.error?.message || `HTTP ${response.status}`), { diagnostic: json?.error });
  return json;
}

async function download(id, output, timeout = 120_000) {
  const source = await request('GET', `/v1/videos/files/${encodeURIComponent(id)}/source`, null, { quiet: true, timeout });
  if (!isCloudVideo(source)) throw new Error('Only verified cloud videos can be downloaded; refresh the original task first');
  const response = await fetch(`${base}/v1/videos/files/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(Math.max(1, timeout)) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const { writeFile } = await import('node:fs/promises');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Downloaded file is not an MP4');
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  return { file: output, bytes: bytes.length };
}

try {
validateArguments();
if (['help', '--help', '-h'].includes(command)) {
  process.stdout.write(`Orbit Frame video CLI
  generate "prompt" --output clip.mp4 [--duration 5 --ratio 16:9 --model "Seedance 2.0 Fast" --key UUID]
  generate --task TASK_ID --output clip.mp4
  generate --canvas CANVAS_ID --card CARD_ID --output clip.mp4
  generate "prompt" --first-frame /absolute/start.png [--last-frame /absolute/end.png] --output clip.mp4
  upload-frame /absolute/picture.png
  scene "prompt" [--canvas CANVAS_ID --card CARD_ID --first-frame FILE --last-frame FILE]
  scenes CANVAS_ID
  submit "prompt" --async [--first-frame FILE --last-frame FILE --mode auto|image_to_video|first_last_frame]
  status TASK_ID [--refresh]
  cancel TASK_ID
  check
Local PNG/JPEG/WebP paths are uploaded automatically. One image selects image_to_video; two select first_last_frame. Existing uploads/ or generated/ media paths also work. Prefer these flags over computer use; supplied frames are never ignored. Credentials load automatically. Resume the original task after timeouts. Downloads require verified cloud delivery.
Duration: Seedance 2.5 accepts 4..30 seconds; other models accept 1..15 seconds.
`);
} else if (command === 'upload-frame') {
  process.stdout.write(`${JSON.stringify(await uploadFrame(args[0]))}\n`);
} else if (command === 'scenes') {
  await request('GET', args[0] ? `/v1/canvases/${encodeURIComponent(args[0])}/video-scenes` : '/v1/canvases');
} else if (command === 'scene') {
  if (!args[0] || args[0].startsWith('--')) throw new Error('scene requires a prompt');
  const frames = await frameOptions();
  const existingCanvas = value('--canvas', '');
  const {randomUUID}=await import('node:crypto');const key=value('--key',randomUUID());
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) throw argumentError('--key must be a UUID for scene preparation');
  if (value('--card', '') && !existingCanvas) throw new Error('--card requires --canvas');
  try {
  const canvasId = existingCanvas || (await request('POST', '/v1/canvases', { title: value('--title', 'Agent 视频镜头'),idempotency_key:key }, { quiet: true })).id;
  const result = await request('POST', `/v1/canvases/${encodeURIComponent(canvasId)}/video-scenes`, { prompt: args[0], ...frames,
    ...(value('--card', '') ? { card_id: value('--card', '') } : {}), model: value('--model', 'Seedance 2.0 Fast'),
    duration: Number(value('--duration', 5)), ratio: value('--ratio', '16:9'),idempotency_key:key }, { quiet: true });
  process.stdout.write(`${JSON.stringify({ ...result,idempotency_key:key,canvas_url: `${base}/canvas.html?id=${canvasId}`, submitted: false })}\n`);
  } catch(error) {
    error.diagnostic={...(error.diagnostic || {code:'compose_response_unknown',message:'Retry this preparation with the same key and inputs',submitted:false}),idempotency_key:key};
    throw error;
  }
} else if (command === 'check') {
  const state = await request('GET', '/v1/videos/readiness?refresh=1');
  if (!state.ready) process.exitCode = 1;
} else if (command === 'generate') {
  const output = value('--output', '');
  const existing = value('--task', '');
  const canvasId = value('--canvas', ''), cardId = value('--card', '');
  const seconds = Number(value('--timeout-seconds', 900));
  if (!output || !Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error('generate requires --output file.mp4 and timeout 1..86400 seconds');
  const { access } = await import('node:fs/promises');
  try { await access(output); throw new Error('Output already exists; choose a new filename'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deadline = Date.now() + seconds * 1000;
  let job;
  if (existing) job = { task_id: existing, status: 'running' };
  else if (canvasId || cardId) {
    if (!canvasId || !cardId) throw new Error('--canvas and --card are both required');
    if (['--first-frame','--last-frame','--model','--duration','--ratio','--mode'].some(flag=>args.includes(flag))) throw new Error('Canvas generation uses saved inputs; edit with scene first');
    job = await request('POST', `/v1/canvases/${encodeURIComponent(canvasId)}/video-scenes/${encodeURIComponent(cardId)}/generate`, {}, { quiet: true });
  }
  else {
    if (!args[0] || args[0].startsWith('--')) throw new Error('generate requires a prompt or --task id');
    const { randomUUID } = await import('node:crypto');
    const key = value('--key', randomUUID());
    const frames = await frameOptions();
    try {
      job = await request('POST', '/v1/videos/generations', { provider: 'doubao-desktop', prompt: args[0], model: value('--model', 'Seedance 2.0 Fast'), duration: Number(value('--duration', 5)), ratio: value('--ratio', '16:9'), ...frames, idempotency_key: key, async: true }, { quiet: true, timeout: Math.min(150000, seconds * 1000) });
    } catch (error) { throw resumableVideoError(error, taskIdForKey(key)); }
  }
  while (followsVideoTask(job)) {
    if (!job.task_id) throw new Error('Gateway did not return a task_id');
    const remaining = deadline - Date.now();
    if (remaining <= 0) { job = { ...job, timed_out: true, message: 'Timeout; resume with generate --task TASK_ID --output FILE' }; process.exitCode = 2; break; }
    process.stderr.write(`Task ${job.task_id}: ${job.status}\n`);
    try {
      job = await request('GET', `/v1/videos/tasks/${encodeURIComponent(job.task_id)}?wait_seconds=${Math.min(30, Math.floor(remaining / 1000))}`, null, { quiet: true, timeout: remaining });
    } catch (error) {
      if (Date.now() >= deadline || error.name === 'TimeoutError') { job = { ...job, timed_out: true, message: 'Timeout; query the same task to resume' }; process.exitCode = 2; break; }
      throw resumableVideoError(error, job.task_id);
    }
    if (needsCloudExtraction(job)) job = await request('GET', `/v1/videos/tasks/${encodeURIComponent(job.task_id)}?refresh=1`, null, { quiet: true, timeout: Math.max(1, deadline - Date.now()) });
    if (followsVideoTask(job)) await new Promise(r => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
  if (job.status === 'completed') {
    if (!isCloudVideo(job.videos?.[0])) { job = { ...job, status: 'video_missing' }; process.exitCode = 1; }
    else {
      try { job = { ...job, ...await download(job.videos[0].id, output, deadline - Date.now()) }; process.exitCode = 0; }
      catch (error) { if (Date.now() < deadline && error.name !== 'TimeoutError') throw resumableVideoError(error, job.task_id); job = { ...job, timed_out: true, message: 'Video completed; use download or resume the same task to export the file' }; process.exitCode = 2; }
    }
  } else if (['failed', 'cancelled', 'video_missing'].includes(job.status)) process.exitCode = 1;
  else process.exitCode = 2;
  process.stdout.write(`${JSON.stringify(job)}\n`);
} else if (command === 'submit') {
  const prompt = args[0];
  if (!prompt || prompt.startsWith('--')) throw new Error('Usage: submit "prompt" [--model name] [--duration 5] [--ratio 16:9] [--mode image_to_video|first_last_frame --first-frame a.png [--last-frame b.png]] [--key id] [--async]');
  const { randomUUID } = await import('node:crypto');
  const key = value('--key', randomUUID()), frames = await frameOptions();
  try { await request('POST', '/v1/videos/generations', {
    provider: 'doubao-desktop', prompt,
    model: value('--model', 'Seedance 2.0 Fast'),
    duration: Number(value('--duration', 5)), ratio: value('--ratio', '16:9'), ...frames,
    idempotency_key: key,
    async: args.includes('--async'),
  }); } catch (error) { throw resumableVideoError(error, taskIdForKey(key)); }
} else if (command === 'cancel') {
  if(!args[0])throw Error('cancel requires a task ID');
  await request('POST',`/v1/videos/tasks/${encodeURIComponent(args[0])}/cancel`,{});
} else if (command === 'status') {
  if (!args[0]) throw new Error('Usage: status <task-id> [--wait-seconds 30] [--refresh]');
  const seconds = Math.max(0, Math.min(60, Number(value('--wait-seconds', 0))));
  await request('GET', `/v1/videos/tasks/${encodeURIComponent(args[0])}?wait_seconds=${seconds}${args.includes("--refresh") ? "&refresh=1" : ""}`);
} else if (command === 'recover') {
  if (!args[0] || !args[1]) throw new Error('Usage: recover <conversation-id> <run-id>');
  await request('POST', '/v1/videos/recover', { conversation_id: args[0], run_id: args[1] });
} else if (command === 'download') {
  if (!args[0] || !args[1]) throw new Error('Usage: download <video-id> <output.mp4>');
  process.stdout.write(`${JSON.stringify(await download(args[0], args[1]))}\n`);
} else {
  throw new Error('Usage: doubao-video check|upload-frame|scene|scenes|generate|submit|status|recover|download ...');
}

} catch (error) {
  process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ status: 'error', error: error.diagnostic || { code: error.name === 'TimeoutError' ? 'gateway_timeout' : 'gateway_error', message: error.message } })}\n`);
}
