import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { imageInfo } from './video-frames.js';

const invalid = message => Object.assign(new Error(message), { invalid: true, submitted: false });
const settingsFile = () => path.join(config.dataDir, 'image-provider.json');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null;
export async function imageProviderSettings() {
  const saved = await fs.readFile(settingsFile(), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  return { ...saved, api_key: process.env.ORBIT_IMAGE_API_KEY || saved.api_key, base_url: process.env.ORBIT_IMAGE_BASE_URL || saved.base_url };
}
export async function saveImageProviderSettings(body) {
  const current = await imageProviderSettings();
  let url; try { url = new URL(body.base_url || current.base_url); } catch { throw invalid('请填写生图服务 API 地址'); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw invalid('生图地址需为 HTTPS 或本机 HTTP 地址，不能包含密钥或查询参数');
  const api_key = body.api_key || current.api_key;
  if (typeof api_key !== 'string' || !api_key.trim() || api_key.length > 4096) throw invalid('请在本机配置服务密钥');
  const model = String(body.model || current.model || 'gpt-image-2.5');
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(model)) throw invalid('模型名称无效');
  const next = { base_url: url.toString().replace(/\/$/, ''), api_key, model, edit_enabled: body.edit_enabled ?? current.edit_enabled ?? true, timeout_seconds: Math.max(30, Math.min(1800, Number(body.timeout_seconds || current.timeout_seconds || 900))) };
  await fs.mkdir(config.dataDir, {recursive:true,mode:0o700});
  const temp = `${settingsFile()}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(next), {mode:0o600});await fs.rename(temp, settingsFile());
  return imageCapabilities();
}
export async function imageCapabilities({ probe = false } = {}) {
  const settings = await imageProviderSettings();
  const external = { id:'openai-compatible', label:'外部生图服务', configured: Boolean(settings.base_url && settings.api_key),
    base_url: settings.base_url || '', requested_model:settings.model || null, models: settings.model ? [settings.model] : [], supports_generate:true, supports_edit:settings.edit_enabled === true,
    task_query_supported:false, cancellation_supported:false, permission:'not_probed', model_verification:'requested_only' };
  if (probe && external.configured) {
    try {
      const response = await fetch(`${settings.base_url}/models`, {headers:{Authorization:`Bearer ${settings.api_key}`}, signal:AbortSignal.timeout(10_000),redirect:'error'});
      const json = await response.json();
      external.connected = response.ok;
      if (response.ok) {
        external.discovered_models=(json.data || []).map(item => safeId(item.id)).filter(Boolean);
        external.models=[...new Set([settings.model,...external.discovered_models.filter(model=>/image|seedream|flux|sdxl|dall.?e/i.test(model))].filter(Boolean))];
      }
      external.requested_model_available = Boolean(external.discovered_models?.includes(settings.model));
    } catch { external.connected = false; external.error = '外部生图服务暂时不可读'; }
  }
  return { providers:[{id:'doubao-desktop',label:'豆包客户端',configured:true,models:['Seedream 5.0 Lite','Seedream 5.0','Seedream 4.5','Seedream 4.0'],supports_generate:true,supports_edit:true,
    task_query_supported:true,cancellation_supported:true,permission:'not_probed',model_verification:'requested_only'},external] };
}

// OpenAI-compatible Images API: multipart bytes for edits, JSON for generation.
// The synchronous API has no standard task-query or cancellation endpoint.
export async function generateCompatibleImage(body, { onReceipt = async () => {}, signal } = {}) {
  const settings = await imageProviderSettings();
  if (!settings.base_url || !settings.api_key) throw invalid('外部生图服务尚未配置');
  const refs = body.reference_files || [];
  if (refs.length && !settings.edit_enabled) throw invalid('该服务未启用参考图编辑；未提交');
  const size = { '1:1':'1024x1024','16:9':'2048x1152','9:16':'1152x2048','4:3':'1536x1152','3:4':'1152x1536' }[body.ratio];
  const payload = {model:body.model || settings.model,prompt:body.prompt,n:1,size,response_format:'b64_json'};
  const headers = {Authorization:`Bearer ${settings.api_key}`, 'Idempotency-Key':body.idempotency_key};
  let requestBody;
  if (refs.length) {
    requestBody = new FormData();
    for (const [key,value] of Object.entries(payload)) requestBody.append(key,String(value));
    for (const file of refs) {
      const bytes = await fs.readFile(file), info = imageInfo(bytes);
      if (!info) throw invalid('参考图不是 PNG、JPEG 或 WebP；未提交');
      requestBody.append(refs.length === 1 ? 'image' : 'image[]',new Blob([bytes],{type:info.type}),path.basename(file));
    }
  } else {headers['Content-Type']='application/json';requestBody=JSON.stringify(payload);}
  let response;
  const timeout = AbortSignal.timeout((settings.timeout_seconds || 900)*1000);
  try { response = await fetch(`${settings.base_url}/images/${refs.length ? 'edits' : 'generations'}`,{method:'POST',headers,body:requestBody,redirect:'error',signal:signal ? AbortSignal.any([signal,timeout]) : timeout}); }
  catch { throw Object.assign(new Error('外部生图请求响应中断；请核查原请求，不会自动重发'),{uncertain:true}); }
  const requestId = safeId(response.headers.get('x-request-id') || response.headers.get('request-id'));
  let json;
  try { json = await response.json(); } catch { throw Object.assign(new Error('外部服务响应无法解析；请核查原请求'),{uncertain:true}); }
  const receipt={providerRequestId:requestId,providerTaskId:safeId(json.task_id),responseModel:safeId(json.model || json.data?.[0]?.model)};
  await onReceipt(receipt);
  if (!response.ok) throw Object.assign(new Error(`外部生图服务返回 HTTP ${response.status}`), {uncertain:[408,502,503,504].includes(response.status),submitted:![400,401,403,404,422,429].includes(response.status)});
  if (response.status === 202 || !json.data?.length) throw Object.assign(new Error('外部服务未交付图片；原请求已保留，需在服务端核查'),{uncertain:true});
  const images = json.data.slice(0,8).map(item => {
    if (item.b64_json) {
      if (typeof item.b64_json !== 'string' || item.b64_json.length > 42 * 1024 * 1024) throw Object.assign(new Error('外部图片超过 30 MB，原请求已保留'),{uncertain:true});
      return Buffer.from(item.b64_json,'base64');
    }
    return item.url;
  }).filter(Boolean);
  if (!images.length) throw Object.assign(new Error('外部服务没有返回图片字节'),{uncertain:true});
  return {images,response_model:receipt.responseModel};
}
