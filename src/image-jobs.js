// Background image generation, so a canvas card survives page reloads while
// Doubao renders. Results are saved under media/generated; a job left
// "running" by a previous gateway process is reported as interrupted.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { saveGeneratedImages } from './image-save.js';
import { readFrame } from './video-frames.js';
import { imageProviderSettings } from './image-providers.js';
import { cancelEnterpriseRun } from './task-cancellation.js';

const jobId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const imageJobReferencePolicy = 'library_reference_bytes_v2';
const active = new Map();
const saves = new Map();
let recoveryGenerate = null;
const events = new EventEmitter().setMaxListeners(0);
const invalid = message => Object.assign(new Error(message), { invalid: true });
const dir = () => path.join(config.dataDir, 'image-jobs');
const fileFor = id => path.join(dir(), `${id}.json`);

const publicJob = job => ({ id: job.id, status: job.status, prompt: job.prompt, model: job.model, ratio: job.ratio,
  phase: job.phase || (job.status === 'completed' ? 'ready' : null),
  conversation_id: job.conversationId || null, run_id: job.runId || null,
  provider:job.provider || null, requested_model:job.model, model_verification:job.model_verification || (job.provider === 'doubao-desktop' ? 'requested_only' : null),
  provider_task_id:job.providerTaskId || null,provider_request_id:job.providerRequestId || null,
  reference_images:job.reference_images || [], cancellation:job.cancellation || null,
  reference_failure:job.reference_failure || null,
  images: job.images || [], message: job.message || null, created_at: job.created_at, updated_at: job.updated_at });

async function save(job) {
  const prior = saves.get(job.id) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => saveNow(job));
  saves.set(job.id,next);
  try { await next; } finally { if(saves.get(job.id)===next) saves.delete(job.id); }
}

async function saveNow(job) {
  const previous=await load(job.id);
  if (previous?.cancellation) {
    job.cancellation = previous.cancellation.confirmed || previous.cancellation.state === 'unsupported'
      ? previous.cancellation : {...previous.cancellation,...job.cancellation};
  }
  if (previous?.status === 'cancelled' && previous.cancellation?.confirmed) {job.status='cancelled';job.phase=null;}
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  job.updated_at = new Date().toISOString();
  const temp = `${fileFor(job.id)}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(job), { mode: 0o600 });
  await fs.rename(temp, fileFor(job.id));
  events.emit(job.id, publicJob(job));
}

async function load(id) {
  if (!jobId.test(String(id))) return null;
  try { return JSON.parse(await fs.readFile(fileFor(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// `generate(body)` resolves to { images: [signed URL, ...] }.
export async function startImageJob(body, generate) {
  const referenceFields = ['images', 'image', 'referenceImages', 'referenceList'];
  const nonempty = value => Array.isArray(value) ? value.length > 0 : value != null && value !== '';
  if (referenceFields.some(field => nonempty(body?.[field])) || Array.isArray(body?.input) && body.input.some(item => nonempty(item?.image_url) || nonempty(item?.image))) {
    throw invalid('参考图请使用 reference_images 中的已上传素材 path，不接受会被忽略的图片参数；未提交生成。');
  }
  if (body.reference_images != null && !Array.isArray(body.reference_images)) throw invalid('reference_images must be an array');
  const references=body.reference_images || [];
  if (references.length > 8) throw invalid('最多 8 张参考图');
  if (references.length && !['doubao-desktop','openai-compatible'].includes(body.provider)) throw invalid('此生图服务不支持参考图；未提交生成。');
  let frames;try {frames=await Promise.all(references.map((spec,index)=>readFrame(`reference_${index+1}`,spec)));}catch(error){throw invalid('参考图不可读：'+error.message);}
  if(body.provider && !['doubao-desktop','openai-compatible'].includes(body.provider)) throw invalid('未知生图服务；未提交');
  if (body.provider === 'openai-compatible') {
    const settings=await imageProviderSettings();
    if (!settings.base_url || !settings.api_key) throw invalid('外部生图服务尚未配置；未提交');
    if (frames.length && !settings.edit_enabled) throw invalid('外部服务未启用参考图编辑；未提交');
  }
  const prompt = String(body?.prompt || '').trim();
  if (!prompt || prompt.length > 4000) throw invalid('prompt must be 1 to 4000 characters');
  const model = String(body.model || (body.provider==='openai-compatible'?(await imageProviderSettings()).model:'Seedream 4.5'));
  if(!model || model.length>100) throw invalid('模型名称需为 1 到 100 字符');
  const ratio = String(body.ratio || '1:1');
  if (!['1:1', '16:9', '9:16', '4:3', '3:4'].includes(ratio)) throw invalid('ratio must be a supported aspect ratio');
  const id = body.idempotency_key || randomUUID();
  const fingerprint=createHash('sha256').update(JSON.stringify({prompt,model,ratio,provider:body.provider || null,refs:frames.map(f=>f.sha256)})).digest('hex');
  if (!jobId.test(String(id))) throw invalid('idempotency_key must be a UUID');
  const existing = await load(id);
  if (existing) {
    if (existing.fingerprint ? existing.fingerprint !== fingerprint : frames.length || existing.prompt !== prompt || existing.model !== model || existing.ratio !== ratio || (existing.provider || null) !== (body.provider || null)) throw invalid('同一请求编号不能用于不同图片参数');
    return publicJob(existing);
  }
  const now = new Date().toISOString();
  const job = { id, fingerprint, pid: process.pid, provider: body.provider || null, phase: 'submitting', status: 'running', prompt, model, ratio, images: [],
    reference_images:frames.map((frame,index)=>({ ...(typeof references[index] === 'object'?references[index]:{}),path:typeof references[index] === 'string' ? references[index] : references[index].path,asset_id:`sha256:${frame.sha256}`,sha256:frame.sha256,width:frame.width,height:frame.height,bytes:frame.bytes })),
    created_at: now, updated_at: now };
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  const temp = `${fileFor(id)}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(job), { mode: 0o600 });
  try { await fs.link(temp, fileFor(id)); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = await load(id);
    if (current.fingerprint !== fingerprint) throw invalid('同一请求编号不能用于不同图片参数');
    return publicJob(current);
  } finally { await fs.rm(temp, { force: true }); }
  const referenceDir=path.join(dir(),id+'-references');
  try {
    job.reference_files=[];
    if(frames.length) await fs.mkdir(referenceDir,{recursive:true,mode:0o700});
    for(const [index,frame] of frames.entries()) {const file=path.join(referenceDir,`reference-${index+1}.${frame.ext}`);await fs.writeFile(file,frame.data,{mode:0o600});job.reference_files.push(file);}
    await save(job);
  } catch {job.status='failed';job.message='参考图本地保存失败；未提交';await save(job);throw invalid(job.message);}
  executeImageJob(job, generate, false);
  return publicJob(job);
}

async function executeImageJob(job, generate, persist = true) {
  if (active.has(job.id)) return;
  const controller=new AbortController();active.set(job.id,{controller}); job.pid = process.pid; job.status = 'running'; job.phase = job.runId ? 'generating' : 'submitting'; job.message = null;
  try {
    if (persist) await save(job);
    const result = await generate({ prompt: job.prompt, model: job.model, ratio: job.ratio, style: '默认', stream: false, provider: job.provider,reference_files:job.reference_files || [],idempotency_key:job.id }, {
      signal:controller.signal,
      receipt: job.conversationId && job.runId ? { conversationId: job.conversationId, runId: job.runId } : null,
      onReceipt: async receipt => {
        if(receipt.conversationId) {job.conversationId=receipt.conversationId;job.runId=receipt.runId;}
        if(receipt.providerRequestId) job.providerRequestId=receipt.providerRequestId;
        if(receipt.providerTaskId) job.providerTaskId=receipt.providerTaskId;
        job.phase='generating';await save(job);
        if(job.conversationId && job.runId && job.cancellation?.requested_at && !job.cancellation.confirmed && !job.cancellation.attempted_at) await cancelImageJob(job.id,{cancel:active.get(job.id)?.cancel || cancelEnterpriseRun});
      },
      onPhase: async phase => { job.phase = phase; await save(job); },
    });
    controller.signal.throwIfAborted();
    const urls = (result?.images || []).filter(url => typeof url === 'string' || Buffer.isBuffer(url));
    if (!urls.length) throw new Error('豆包没有返回图片，请稍后重试。');
    job.phase = 'downloading'; await save(job);
    job.model_verification=result.response_model ? result.response_model === job.model ? 'server_reported' : 'mismatch' : 'requested_only';
    job.images = (await saveGeneratedImages(urls,undefined,{provider:job.provider,requested_model:job.model,model_verification:job.model_verification,source_task_id:job.id,source_request_id:job.providerRequestId || null,
      parent_assets:(job.reference_images || []).map(({asset_id,path,sha256})=>({asset_id,path,sha256}))})).map(({file,media_path,...image}) => ({...image,path:media_path,preview_url:`/v1/media/generated/${path.basename(file)}`}));
    job.status = 'completed'; job.phase = 'ready';
  } catch (error) {
    if (error.reference_failure) job.reference_failure=error.reference_failure;
    if (error.cancellation) job.cancellation=error.cancellation;
    job.status = ['failed','cancelled'].includes(error.upstream_status) ? error.upstream_status : error.uncertain || error.submitted !== false && job.conversationId && job.runId ? 'unknown' : 'failed'; job.phase = null;
    job.message = error.uncertain || error.reference_failure ? error.message : '图片生成或保存未完成，请核对原任务后继续查询。';
  } finally { await save(job).catch(() => {}); active.delete(job.id); }
}

export async function cancelImageJob(id, {cancel=cancelEnterpriseRun} = {}) {
  const job=await load(id);if(!job) return null;
  if(active.has(id)) active.get(id).cancel=cancel;
  if(['completed','failed','cancelled'].includes(job.status)) {job.cancellation={state:job.status === 'completed' ? 'already_completed' : job.status,accepted:false,confirmed:true};await save(job);return publicJob(job);}
  job.cancellation={...job.cancellation,state:'requested',accepted:false,confirmed:false,requested_at:job.cancellation?.requested_at || new Date().toISOString()};await save(job);
  if(job.provider !== 'doubao-desktop') {job.cancellation.state='unsupported';await save(job);return publicJob(job);}
  if(!job.conversationId || !job.runId) {job.cancellation.state='unknown';await save(job);return publicJob(job);}
  job.cancellation.attempted_at=new Date().toISOString();await save(job);
  let result;try {result=await cancel(job.conversationId,job.runId);}catch {result={state:'unknown',accepted:false,confirmed:false};}
  const latest=await load(id);latest.cancellation={...job.cancellation,...result};
  if(result.state==='cancelled' && result.confirmed) {latest.status='cancelled';latest.phase=null;active.get(id)?.controller.abort();}
  else if(result.state==='already_completed' && latest.status !== 'completed') latest.cancellation.state='already_completed';
  await save(latest);return publicJob(latest);
}

export async function resumeImageJobs(generate) {
  recoveryGenerate = generate;
  const names = await fs.readdir(dir()).catch(() => []);
  for (const name of names.filter(n => jobId.test(n.slice(0, -5)) && n.endsWith('.json'))) {
    const job = await load(name.slice(0, -5));
    if (job?.provider !== 'doubao-desktop' || !job.conversationId || !job.runId || !['running', 'unknown'].includes(job.status)) continue;
    let alive = false;
    try { process.kill(job.pid, 0); alive = true; } catch {}
    if (!alive) executeImageJob(job, generate);
  }
}

export async function getImageJob(id, { waitMs = 0, refresh = false } = {}) {
  let job = await load(id);
  if (!job) return null;
  if (refresh && job.provider === 'doubao-desktop' && job.conversationId && job.runId && !active.has(id) && (['unknown', 'failed'].includes(job.status) || job.status === 'completed' && job.images?.some(image => Math.min(image.width, image.height) < 300)) && recoveryGenerate) {
    executeImageJob(job, recoveryGenerate); job.status = 'running';
  }
  if (job.status === 'running') {
    let alive = Number.isInteger(job.pid) && job.pid > 0;
    if (alive) { try { process.kill(job.pid, 0); } catch (error) { alive = error.code === 'EPERM'; } }
    if (!alive) {
      // The synchronous upstream has no resumable run id. Do not overwrite
      // another instance's work or silently generate the same image again.
      return publicJob({ ...job, status: 'unknown', message: '原图片任务进程已退出，结果暂时无法确认。请先核对豆包，再决定是否重新生成。' });
    }
  }
  if (job.status === 'running' && waitMs > 0) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); events.off(id, done); resolve(); };
      const timer = setTimeout(done, Math.min(waitMs, 60_000));
      events.on(id, done);
    });
    job = await load(id);
  }
  return publicJob(job);
}
