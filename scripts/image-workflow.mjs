import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { fetchGateway } from './video-request-id.mjs';
import { prepareImageReferences } from './frame-workflow.mjs';

export async function imageRequest(endpoint, options = {}, timeout = 90_000) {
  const response = await fetchGateway(`http://127.0.0.1:${config.port}${endpoint}`, { ...options,
    headers: { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(Math.max(1, timeout)) });
  const json = await response.json();
  if (!response.ok && response.status !== 202) throw Object.assign(new Error(json?.error?.message || `Image gateway HTTP ${response.status}`),{
    diagnostic:{code:json?.error?.type || 'image_gateway_error',message:json?.error?.message || `Image gateway HTTP ${response.status}`,submitted:json?.error?.submitted ?? ([400,401,403,404,422,429].includes(response.status) ? false : 'unknown'),http_status:response.status}});
  return json;
}
export function imageSummary(job) {
  return { ...job, task_id: job.id,
    images: (job.images || []).map(image => ({ ...image,
      file: path.join(config.mediaDir, image.path), media_path: image.path })) };
}
export async function generateImageAndWait(args, progress = () => {}) {
  const seconds = Math.max(1, Math.min(3600, Number(args.timeout_seconds) || 600)), deadline = Date.now() + seconds * 1000;
  const key = args.task_id || args.idempotency_key || randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) throw Object.assign(new Error('Image task/request ID must be a UUID'),{diagnostic:{code:'invalid_request',submitted:false}});
  const references=args.task_id ? [] : await prepareImageReferences(args);
  if(!args.task_id && (!args.prompt?.trim() || args.prompt.length > 4000)) throw Object.assign(new Error('图片提示词需为 1 到 4000 字符'),{diagnostic:{code:'invalid_request',submitted:false}});
  let job;
  try {
    job = args.task_id ? await imageRequest(`/v1/images/jobs/${encodeURIComponent(key)}?refresh=1`)
      : await imageRequest('/v1/images/jobs', { method: 'POST', body: JSON.stringify({ provider: args.provider || 'doubao-desktop', prompt: args.prompt, model: args.model || (args.provider === 'openai-compatible' ? undefined : 'Seedream 4.5'), ratio: args.ratio || '1:1', reference_images:references,idempotency_key: key }) }, Math.min(150_000, seconds * 1000));
    while (job.status === 'running' && Date.now() < deadline) {
      progress({ id: key, status: job.status, phase: job.phase });
      job = await imageRequest(`/v1/images/jobs/${encodeURIComponent(key)}?wait_seconds=${Math.max(0, Math.min(25, Math.floor((deadline - Date.now()) / 1000)))}`, {}, deadline - Date.now());
      if (job.status === 'running') await new Promise(r => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))));
    }
  } catch (error) {
    if(error.diagnostic) {error.diagnostic.task_id=key;throw error;}
    return { task_id: key, id: key, status: 'unknown', images: [], message: '图片请求结果暂时无法确认，请使用原 task_id 查询，不要重新提交。' };
  }
  const result = imageSummary(job);
  if (job.status === 'running') { result.timed_out = true; result.message = '等待超时，查询原 task_id 可以继续等待。'; }
  return result;
}
export async function copyImageExports(images, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(config.mediaDir), saved = [];
  for (const image of images) {
    const file = await fs.realpath(image.file);
    if (!file.startsWith(root + path.sep)) throw new Error('Image source must stay in the media directory');
    const output = path.join(destination, path.basename(file));
    if (output !== file) await fs.copyFile(file, output, fs.constants.COPYFILE_EXCL);
    saved.push({ ...image, file: output });
  }
  return saved;
}
