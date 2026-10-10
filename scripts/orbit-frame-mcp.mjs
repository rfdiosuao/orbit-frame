#!/usr/bin/env node
// Local stdio MCP server for Orbit Frame video generation.
// Reads LOCAL_API_KEY itself so the key never enters prompts or tool output.
// stdout carries JSON-RPC only; diagnostics go to stderr.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { generateImageAndWait, imageRequest, imageSummary } from './image-workflow.mjs';
import { config } from '../src/config.js';
import { taskIdForKey, resumableVideoError, fetchGateway } from './video-request-id.mjs';
import { saveGeneratedImages, generatedImageDir } from '../src/image-save.js';
import { followsVideoTask, isCloudVideo, needsCloudExtraction } from '../public/video-task-state.js';
import { prepareVideoFrames, uploadFrame } from './frame-workflow.mjs';
import {preflightWorkflow,prepareWorkflow,runWorkflow,workflowStatus,cancelWorkflow,exportWorkflow} from './canvas-workflow.mjs';

const base = `http://127.0.0.1:${config.port}`;
const headers = { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/json' };
const outputDir = path.resolve(process.env.ORBIT_FRAME_OUTPUT_DIR || path.join(config.dataDir, 'exports'));
const activeStatuses = ['submitting', 'running'];

const tools = [
  {name:'manage_workflow',description:'Operate a local shot manifest without browser coordinates. preflight validates dependencies and hashes; prepare imports images and maps workflow/shot/canvas/card IDs without generating; run needs live:true and permits 1..5 new tasks (default 1). status and resume retain original jobs; pause records local pause and actual upstream cancellation receipts; export writes verified cloud clips and an editing manifest. Unknown external requests are never automatically resent.',inputSchema:{type:'object',properties:{manifest_path:{type:'string'},action:{type:'string',enum:['preflight','prepare','run','status','pause','export']},live:{type:'boolean',default:false},resume:{type:'boolean',default:false},max_new_tasks:{type:'integer',minimum:1,maximum:5,default:1},timeout_seconds:{type:'integer',minimum:1,maximum:3600,default:900}},required:['manifest_path','action']}},
  { name: 'upload_frame', description: 'Upload an explicitly chosen local PNG/JPEG/WebP image (absolute path, ~/ path, or path relative to the MCP working directory). Returns reusable media path, preview, dimensions and SHA256. Use this tool instead of computer use or manual copying into the media directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_media', description: 'Find existing uploaded or generated reference images by metadata, without opening the browser. Returned path values can directly feed video frame inputs.',
    inputSchema: { type: 'object', properties: { directory: { type: 'string', enum: ['uploads', 'generated'], default: 'generated' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } } } },
  { name: 'get_canvas', description: 'With no canvas_id, list available canvases. With an ID, read semantic video scenes: actual prompt, first/last frame roles, missing inputs and original task ID. No coordinates or computer use needed.',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' } } } },
  { name: 'compose_video_scene', description: 'Prepare a video scene without generating: supply prompt and optional local first/last image paths; uploads, cards, role connections and layout are created together. One image selects image_to_video, two select first_last_frame. Supply canvas_id to append and card_id to replace an unsubmitted scene. Then generate_and_wait with returned canvas_id + card_id. Never redraw supplied frames or use computer use to connect them.',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, card_id: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
      first_frame_path: { type: 'string' }, last_frame_path: { type: 'string' }, model: { type: 'string' }, duration: { type: 'integer', minimum: 1, maximum: 30 }, ratio: { type: 'string' },idempotency_key:{type:'string',description:'UUID for preparing the same scene safely after a lost response.'} }, required: ['prompt'] } },
  {name:'get_image_capabilities',description:'Read configured image providers, real model discovery and generate/edit/cancel/query capabilities without generating.',inputSchema:{type:'object',properties:{probe:{type:'boolean'}}}},
  {name:'cancel_task',description:'Request cancellation of an original video/image task. Read cancellation.state/accepted/confirmed; unsupported or unknown does not mean upstream stopped.',inputSchema:{type:'object',properties:{task_id:{type:'string'},kind:{type:'string',enum:['video','image']}},required:['task_id','kind']}},
  {
    name: 'check_video_connection',
    description: 'Check gateway, Doubao desktop connection and local login state without submitting or consuming video quota. Generation permission is not probed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_image',
    description: `Generate or edit images with Doubao desktop or the configured OpenAI-compatible provider. reference_image_paths uploads original bytes for real image editing and preserves parent hashes. Saves files under ${generatedImageDir}, usable as video frames. Resume timeouts with original task_id; synchronous external providers cannot guarantee task query or cancellation.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image should show.' },
        task_id: { type: 'string', description: 'Resume a previously submitted image job; no new generation.' },
        idempotency_key: { type: 'string', description: 'Reuse the same UUID for the same request.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600, default: 600 },
        provider:{type:'string',enum:['doubao-desktop','openai-compatible']},
        model: { type: 'string', description:'Actual provider model request name. Defaults to Seedream 4.5 or configured external model.' },
        reference_image_paths:{type:'array',maxItems:8,items:{type:'string'},description:'Original local files to upload for image-to-image editing. Never redraw these reference images.'},
        reference_images:{type:'array',maxItems:8,items:{type:'object',properties:{path:{type:'string'}},required:['path']},description:'Alternative existing media paths; do not combine with reference_image_paths.'},
        ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], default: '1:1' },
      },
      anyOf:[{required:['prompt']},{required:['task_id']}],
    },
  },
  { name: 'get_image_status', description: 'Read an image task and its real phase. Refresh resumes the original desktop run.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, wait_seconds: { type: 'integer', minimum: 0, maximum: 60 }, refresh: { type: 'boolean' } }, required: ['task_id'] } },
  {
    name: 'generate_and_wait',
    description: 'Generate a video directly from prompt + local image paths, or from canvas_id + card_id. Use first_frame_path for one image (image_to_video), and first_frame_path + last_frame_path for first_last_frame; mode auto prioritizes supplied images. Local files upload automatically, with no browser or computer use. Reuse existing media paths from generate_image/list_media/upload_frame. Canvas generation freezes roles, attaches task ID and is safe to resume. Defaults to waiting for verified cloud MP4. On timeout pass task_id to this tool or get_video_status; never submit a new generation.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the video should show.' },
        task_id: { type: 'string', description: 'Resume an existing video; no upload or new generation.' },
        canvas_id: { type: 'string', description: 'Generate/resume this saved scene together with card_id; do not supply overrides.' },
        card_id: { type: 'string' },
        model: { type: 'string', default: 'Seedance 2.0 Fast' },
        duration: { type: 'integer', minimum: 1, maximum: 30, default: 5, description: 'Seconds. Seedance 2.5 accepts 4..30; other models accept 1..15. The gateway checks the selected model.' },
        ratio: { type: 'string', default: '16:9', description: 'Aspect ratio such as 16:9, 9:16, 1:1.' },
        mode: { type: 'string', enum: ['auto', 'text_to_video', 'image_to_video', 'first_last_frame'], default: 'auto' },
        first_frame_path: { type: 'string', description: 'Local PNG/JPEG/WebP path. Preferred shortcut for first_frame.path. Can be outside the project; uploaded automatically.' },
        last_frame_path: { type: 'string', description: 'Local end-frame path, used with first_frame_path. Uploaded automatically.' },
        first_frame: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
          description: 'First/reference image. Local file path or existing uploads/ or generated/ path. Automatically uploaded when needed.' },
        last_frame: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
          description: 'Required for first_last_frame only.' },
        wait: { type: 'boolean', default: true },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 3600, default: 900 },
        idempotency_key: { type: 'string', description: 'Reuse to resume the same request instead of creating a new video.' },
      },
      anyOf: [{ required: ['prompt'] }, { required: ['task_id'] }, { required: ['canvas_id', 'card_id'] }],
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
        refresh: { type: 'boolean', default: false, description: 'Resume a paused task or retry extraction. Never resubmits the prompt.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'download_video',
    description: `Copy only a verified cloud-upload MP4 from a completed task into the export directory (${outputDir}). Only a file name may be chosen, not a directory.`,
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
    response = await fetchGateway(`${base}${endpoint}`, { method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'Gateway request timed out' : `Gateway is not reachable at ${base}; run "npm start" first`);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) throw Object.assign(new Error(json?.error?.message || `Gateway returned HTTP ${response.status}`), { diagnostic: json?.error });
  return json;
}

function summary(job) {
  const video = job.videos?.find(isCloudVideo);
  return {
    task_id: job.task_id, status: job.status, phase: job.phase ?? null,
    prompt: job.prompt, duration: job.duration, ratio: job.ratio,
    provider:job.provider,requested_model: job.requested_model, model_verification:job.model_verification,cancellation:job.cancellation || null,message: job.message || null, mode: job.mode,
    frames: (job.frames || []).map(({ role, width, height, bytes, sha256 }) => ({ role, width, height, bytes, sha256 })),
    error: job.error || null, next_action: job.next_action || null, timings_ms: job.timings_ms || {}, delivery: job.delivery || null,
    ...(job.warnings?.length ? { warnings: job.warnings } : {}),
    ...(video ? {
      video_id: video.id, source_kind: video.source_kind, source_verification: video.source_verification, width: video.width, height: video.height, video_duration: video.duration,
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
  const remaining = () => Math.max(1, deadline - Date.now());
  let job = await request('GET', `/v1/videos/tasks/${taskId}`, null, remaining());
  if (needsCloudExtraction(job)) job = await request('GET', `/v1/videos/tasks/${taskId}?refresh=1`, null, remaining());
  while (followsVideoTask(job) && Date.now() < deadline) {
    progress(job);
    const seconds = Math.max(1, Math.min(30, Math.floor((deadline - Date.now()) / 1000)));
    job = await request('GET', `/v1/videos/tasks/${taskId}?wait_seconds=${seconds}`, null, remaining());
    if (job.status === 'unknown' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining())));
  }
  return job;
}

async function generateAndWait(args, progress) {
  const timeout = Math.max(10, Math.min(3600, Number(args.timeout_seconds) || 900));
  const deadline = Date.now() + timeout * 1000;
  const key = args.idempotency_key || randomUUID();
  let job;
  let frames;
  if (args.task_id) {
    job = await request('GET', `/v1/videos/tasks/${validTaskId(args.task_id)}`);
  } else if (args.canvas_id || args.card_id) {
    if (!args.canvas_id || !args.card_id) throw new Error('canvas_id and card_id are both required');
    if (['prompt','first_frame','last_frame','first_frame_path','last_frame_path','model','duration','ratio','mode'].some(k => args[k] !== undefined)) throw new Error('A canvas scene uses saved inputs; edit it with compose_video_scene, then generate without overrides');
    try { job = await request('POST', `/v1/canvases/${encodeURIComponent(args.canvas_id)}/video-scenes/${encodeURIComponent(args.card_id)}/generate`, {}); }
    catch (error) {
      if (!error.diagnostic) error.diagnostic = { code: 'canvas_response_unknown', message: 'Canvas generation response interrupted; retry this canvas_id + card_id, not a new scene.',
        submitted: 'unknown', canvas_id: args.canvas_id, card_id: args.card_id, next_action: 'resume_same_scene' };
      throw error;
    }
  } else {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt is required');
    frames = await prepareVideoFrames(args);
    try { job = await request('POST', '/v1/videos/generations', {
    provider: 'doubao-desktop', prompt: args.prompt, model: args.model || 'Seedance 2.0 Fast',
    duration: Number(args.duration ?? 5), ratio: args.ratio || '16:9', ...frames,
    idempotency_key: key, async: true,
    }, Math.max(1, Math.min(150_000, deadline - Date.now()))); } catch (error) { throw resumableVideoError(error, taskIdForKey(key)); }
  }
  if (!job?.task_id) throw new Error('Gateway did not return a task_id');
  if (args.wait !== false) {
    try { job = await waitFor(job.task_id, deadline, progress); }
    catch (error) { throw resumableVideoError(error, job.task_id); }
  }
  const result = summary(job);
  if (args.canvas_id) { result.canvas_id = args.canvas_id; result.card_id = args.card_id; result.canvas_url = `${base}/canvas.html?id=${encodeURIComponent(args.canvas_id)}`; }
  if (followsVideoTask(job) && args.wait !== false) {
    result.timed_out = true;
    result.next_step = 'Call get_video_status with this task_id to keep waiting; do not resubmit.';
  }
  return result;
}

async function downloadVideo(args) {
  const taskId = validTaskId(args.task_id);
  const job = await waitFor(taskId, Date.now() + 120_000, () => {});
  const video = job.videos?.find(isCloudVideo);
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

async function generateImage(args, progress) { return generateImageAndWait(args, progress); }

async function callTool(name, args = {}, progress) {
  const spec=tools.find(tool=>tool.name===name);
  if(spec) for(const key of Object.keys(args)) if(!(key in spec.inputSchema.properties)) throw Object.assign(new Error(`Unsupported argument ${key}; inspect tools/list for accepted parameters`),{diagnostic:{code:'invalid_argument',message:`Unsupported argument ${key}`,submitted:false}});
  if(name==='manage_workflow') {
    const action={preflight:preflightWorkflow,prepare:prepareWorkflow,run:runWorkflow,status:workflowStatus,pause:cancelWorkflow,export:input=>exportWorkflow(input,path.join(outputDir,'workflows'))}[args.action];
    if(!action)throw Object.assign(new Error('Unknown workflow action'),{diagnostic:{code:'invalid_workflow',submitted:false}});
    return action(args);
  }
  if (name === 'upload_frame') return uploadFrame(args.path);
  if (name === 'list_media') {
    const directory = args.directory || 'generated';
    if (!['uploads','generated'].includes(directory)) throw new Error('directory must be uploads or generated');
    const result = await request('GET', `/v1/media?dir=${directory}&limit=${Math.max(1, Math.min(100, Number(args.limit)||30))}`);
    return { images: result.images || [] };
  }
  if (name === 'get_canvas') return request('GET', args.canvas_id ? `/v1/canvases/${encodeURIComponent(args.canvas_id)}/video-scenes` : '/v1/canvases');
  if (name === 'compose_video_scene') {
    const frames = await prepareVideoFrames(args);
    if (!args.canvas_id && args.card_id) throw new Error('card_id requires canvas_id');
    const key=args.idempotency_key || randomUUID();
    try {
      const canvasId = args.canvas_id || (await request('POST', '/v1/canvases', { title: args.title || 'Agent 视频镜头',idempotency_key:key })).id;
      const result = await request('POST', `/v1/canvases/${encodeURIComponent(canvasId)}/video-scenes`, { ...args, ...frames,idempotency_key:key });
      return { ...result,idempotency_key:key,canvas_url: `${base}/canvas.html?id=${encodeURIComponent(canvasId)}`, next_step: 'Review the scene, then call generate_and_wait with canvas_id and card_id. No video has been submitted yet.' };
    } catch(error) {if(!error.diagnostic)error.diagnostic={code:'compose_response_unknown',message:'Retry the same preparation UUID and inputs',idempotency_key:key,submitted:false};throw error;}
  }
  if(name==='get_image_capabilities') return imageRequest(`/v1/images/capabilities${args.probe?'?probe=1':''}`);
  if(name==='cancel_task') {
    if(!['video','image'].includes(args.kind))throw Error('kind must be video or image');
    return args.kind==='image' ? imageSummary(await imageRequest(`/v1/images/jobs/${encodeURIComponent(args.task_id)}/cancel`,{method:'POST',body:'{}'})) : summary(await request('POST',`/v1/videos/tasks/${validTaskId(args.task_id)}/cancel`,{}));
  }
  if (name === 'check_video_connection') return request('GET', '/v1/videos/readiness?refresh=1');
  if (name === 'generate_image') return generateImage(args, progress);
  if (name === 'generate_and_wait') return generateAndWait(args, progress);
  if (name === 'get_image_status') {
    if (!/^[0-9a-f-]{36}$/.test(String(args.task_id))) throw new Error('Invalid image task_id');
    const seconds = Math.max(0, Math.min(60, Number(args.wait_seconds) || 0));
    return imageSummary(await imageRequest(`/v1/images/jobs/${args.task_id}?wait_seconds=${seconds}${args.refresh ? '&refresh=1' : ''}`, {}, (seconds + 30) * 1000));
  }
  if (name === 'get_video_status') {
    const seconds = Math.max(0, Math.min(60, Number(args.wait_seconds) || 0));
    return summary(await request('GET', `/v1/videos/tasks/${validTaskId(args.task_id)}?wait_seconds=${seconds}${args.refresh ? "&refresh=1" : ""}`, null, (seconds + 30) * 1000));
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
      const diagnostic = error.diagnostic || { code: 'gateway_error', message: error.message };
      return send({ id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(diagnostic) }], structuredContent: { error: diagnostic } } });
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
