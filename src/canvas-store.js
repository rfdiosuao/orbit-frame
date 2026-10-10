// Infinite-canvas documents. Each canvas is one JSON file; cards reference
// video tasks by task_id and images by media path, so generated media stays
// owned by the existing job and media stores.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { config } from './config.js';
import { validateVideoDuration } from './video-models.js';

const dir = path.join(config.dataDir, 'canvases');
const canvasId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const itemId = /^[A-Za-z0-9_-]{1,40}$/;
const mediaPath = /^(?:uploads|generated)\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,139}$/;
const previewUrl = /^\/v1\/(?:videos\/frames|media\/(?:uploads|generated))\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,139}$/;
const taskId = /^(?:[0-9a-f-]{36}|[0-9a-f]{64})$/;
const ratioPattern = /^\d{1,2}:\d{1,2}$/;
const limits = { cards: 500, edges: 1000, bytes: 2 * 1024 * 1024 };
const locks = new Map();

const invalid = message => Object.assign(new Error(message), { invalid: true });
const fileFor = id => path.join(dir, `${id}.json`);

function num(value, min, max, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${name} is out of range`);
  return Math.round(n * 100) / 100;
}
function text(value, max, name) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} must be text up to ${max} characters`);
  return value;
}
function pick(value, allowed, name) {
  if (!allowed.includes(value)) throw invalid(`${name} must be one of ${allowed.join(', ')}`);
  return value;
}
function optional(value, pattern, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid(`${name} is invalid`);
  return value;
}

function cleanAsset(asset) {
  if (asset == null) return null;
  if (typeof asset.path !== 'string' || !mediaPath.test(asset.path) || asset.path.includes('..')) throw invalid('asset.path is invalid');
  if (typeof asset.preview_url !== 'string' || !previewUrl.test(asset.preview_url)) throw invalid('asset.preview_url is invalid');
  const metadata = {};
  for (const key of ['asset_id', 'provider', 'requested_model', 'source_task_id', 'source_request_id']) {
    if (asset[key]) metadata[key] = text(asset[key], 200, `asset.${key}`);
  }
  if (asset.sha256) metadata.sha256 = optional(asset.sha256, /^[0-9a-f]{64}$/, 'asset.sha256');
  if (asset.bytes != null) metadata.bytes = Math.trunc(num(asset.bytes, 1, 100 * 1024 * 1024, 'asset.bytes'));
  if (asset.model_verification) metadata.model_verification = pick(asset.model_verification, ['requested_only', 'server_reported', 'mismatch', 'not_applicable'], 'model verification');
  if (Array.isArray(asset.parent_assets)) metadata.parent_assets = asset.parent_assets.slice(0, 8).map(parent => ({
    asset_id: text(parent.asset_id, 200, 'parent asset id'), path: optional(parent.path, mediaPath, 'parent path'),
    sha256: optional(parent.sha256, /^[0-9a-f]{64}$/, 'parent hash') }));
  return { ...metadata, ...(asset.name ? { name: text(asset.name, 140, 'asset name') } : {}), path: asset.path, preview_url: asset.preview_url,
    width: Math.trunc(num(asset.width, 1, 20000, 'asset.width')), height: Math.trunc(num(asset.height, 1, 20000, 'asset.height')) };
}

function cleanCard(card) {
  if (!card || typeof card !== 'object') throw invalid('card must be an object');
  if (typeof card.id !== 'string' || !itemId.test(card.id)) throw invalid('card.id is invalid');
  const type = pick(card.type, ['note', 'image', 'video'], 'card.type');
  const base = { id: card.id, type, x: num(card.x, -1e6, 1e6, 'card.x'), y: num(card.y, -1e6, 1e6, 'card.y'),
    ...(card.w == null ? {} : { w: Math.round(num(card.w, 160, 960, 'card.w')) }) };
  if (type === 'note') return { ...base, text: text(card.text, 20_000, 'note text') };
  const common = { prompt: text(card.prompt, 20_000, 'prompt'), error: text(card.error, 300, 'error'),
    ratio: card.ratio == null ? '16:9' : optional(card.ratio, ratioPattern, 'ratio') };
  if (type === 'image') {
    return { ...base, ...common, provider: text(card.provider, 60, 'image provider') || 'doubao-desktop', model: text(card.model, 60, 'model') || 'Seedream 4.5',
      reference_images: (Array.isArray(card.reference_images) ? card.reference_images.slice(0, 8) : []).map(cleanAsset),
      status: pick(card.status || 'draft', ['draft', 'generating', 'ready', 'failed', 'unknown', 'cancelled'], 'image status'),
      image_job: optional(card.image_job, canvasId, 'image_job'),
      frame_owner: optional(card.frame_owner, itemId, 'frame_owner'),
      image_phase: card.image_phase == null ? null : pick(card.image_phase, ['submitting', 'generating', 'downloading', 'ready'], 'image_phase'),
      image_started_at: text(card.image_started_at, 40, 'image_started_at'),
      assets: Array.isArray(card.assets) ? card.assets.slice(0, 8).map(cleanAsset) : [], asset: cleanAsset(card.asset) };
  }
  const duration = Number(card.duration ?? 5);
  const model = text(card.model, 60, 'model') || 'Seedance 2.0 Fast';
  try { validateVideoDuration(model, duration); } catch (error) { throw invalid(error.message); }
  return { ...base, ...common, model, duration,
    input_frames: (Array.isArray(card.input_frames) ? card.input_frames.slice(0, 2) : []).map(frame => ({ role: pick(frame.role, ['first_frame', 'last_frame'], 'input frame role'), asset: cleanAsset(frame.asset) })),
    request_key: optional(card.request_key, canvasId, 'request_key'),
    compose_key: optional(card.compose_key, canvasId, 'compose_key'),
    compose_fingerprint: optional(card.compose_fingerprint, /^[0-9a-f]{64}$/, 'compose_fingerprint'),
    task_id: optional(card.task_id, taskId, 'task_id') };
}

function cleanDocument(doc) {
  if (!doc || typeof doc !== 'object') throw invalid('canvas must be an object');
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  if (cards.length > limits.cards) throw invalid(`a canvas holds at most ${limits.cards} cards`);
  if (edges.length > limits.edges) throw invalid(`a canvas holds at most ${limits.edges} connections`);
  const clean = cards.map(cleanCard);
  const byId = new Map(clean.map(card => [card.id, card]));
  if (byId.size !== clean.length) throw invalid('card ids must be unique');
  const seenEdges = new Set(), filled = new Set();
  const cleanEdges = edges.map(edge => {
    if (typeof edge?.id !== 'string' || !itemId.test(edge.id) || seenEdges.has(edge.id)) throw invalid('edge.id is invalid');
    seenEdges.add(edge.id);
    const role = pick(edge.role, ['first_frame', 'last_frame', 'prompt', 'derived'], 'edge.role');
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to || from === to) throw invalid('edge must connect two different cards');
    if (role !== 'derived') {
      if (to.type !== 'video' || from.type !== (role === 'prompt' ? 'note' : 'image')) throw invalid('video inputs require a note for prompt or an image for frames');
      if (filled.has(`${to.id}:${role}`)) throw invalid('a video card takes one source per input slot');
      filled.add(`${to.id}:${role}`);
    }
    return { id: edge.id, from: from.id, to: to.id, role };
  });
  const viewport = doc.viewport || {};
  return {
    title: text(doc.title, 80, 'title').trim() || '未命名画布',
    viewport: { x: num(viewport.x ?? 0, -1e7, 1e7, 'viewport.x'), y: num(viewport.y ?? 0, -1e7, 1e7, 'viewport.y'),
      zoom: num(viewport.zoom ?? 1, 0.02, 4, 'viewport.zoom') },
    cards: clean, edges: cleanEdges,
  };
}

async function load(id) {
  if (!canvasId.test(String(id))) return null;
  try { return JSON.parse(await fs.readFile(fileFor(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function write(doc) {
  const data = JSON.stringify(doc);
  if (Buffer.byteLength(data) > limits.bytes) throw invalid('canvas is larger than 2 MB');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${fileFor(doc.id)}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, data, { mode: 0o600 });
  await fs.rename(temp, fileFor(doc.id));
}

function serialize(id, work) {
  const run = (locks.get(id) || Promise.resolve()).catch(() => {}).then(work);
  locks.set(id, run);
  run.finally(() => { if (locks.get(id) === run) locks.delete(id); }).catch(() => {});
  return run;
}

export async function listCanvases() {
  let names;
  try { names = await fs.readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const docs = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => load(name.slice(0, -5)).catch(() => null)));
  return docs.filter(Boolean).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map(doc => ({ id: doc.id, title: doc.title, updated_at: doc.updated_at, cards: doc.cards.length }));
}

export async function createCanvas(body = {}) {
  const cleaned=cleanDocument(body),key=body.idempotency_key;
  if(key && !canvasId.test(key)) throw invalid('canvas creation key must be a UUID');
  const hex=key && createHash('sha256').update('canvas:'+key).digest('hex');
  const id=hex ? `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}` : randomUUID();
  const fingerprint=createHash('sha256').update(JSON.stringify(cleaned)).digest('hex');
  return serialize(id,async()=>{
    const existing=await load(id);
    if(existing) {if(existing.create_fingerprint !== fingerprint) throw invalid('同一画布创建编号不能用于不同参数');return existing;}
    const now=new Date().toISOString();
    const doc={id,version:1,created_at:now,updated_at:now,...cleaned,...(key?{create_key:key,create_fingerprint:fingerprint}:{})};
    await write(doc);return doc;
  });
}

export const getCanvas = load;

// Semantic scene operations share the same lock and validation as browser
// saves. They only mutate the intended cards, preserving unrelated edits.
export async function mutateCanvas(id, change) {
  if (!canvasId.test(String(id))) return null;
  return serialize(id, async () => {
    const current = await load(id);
    if (!current) return null;
    const next = await change(structuredClone(current));
    const doc = { ...current, ...cleanDocument(next), version: current.version + 1, updated_at: new Date().toISOString() };
    await write(doc);
    return doc;
  });
}

// Removes only the canvas document; media files and video tasks are kept.
export async function deleteCanvas(id) {
  if (!canvasId.test(String(id))) return false;
  return serialize(id, async () => {
    try { await fs.rm(fileFor(id)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
}

// Optimistic concurrency: a save must name the version it was based on, so
// two open tabs cannot silently overwrite each other.
export async function saveCanvas(id, body = {}) {
  if (!canvasId.test(String(id))) return null;
  return serialize(id, async () => {
    const current = await load(id);
    if (!current) return null;
    if (Number(body.version) !== current.version) {
      throw Object.assign(new Error('canvas was changed elsewhere'), { conflict: true, current });
    }
    const cleaned = cleanDocument(body);
    for (const previous of current.cards.filter(card => card.type === 'video' && (card.task_id || card.request_key))) {
      const next = cleaned.cards.find(card => card.id === previous.id);
      if (!next) continue; // Removing a card does not cancel or rewrite its task.
      const fields = ['type', 'prompt', 'model', 'duration', 'ratio', 'input_frames', 'request_key', 'task_id'];
      if (fields.some(key => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null))) throw invalid('已提交镜头的输入和任务编号已冻结，不能修改；请复制为新镜头。');
      const inputs = edges => edges.filter(edge => edge.to === previous.id && edge.role !== 'derived').map(({from,role}) => [from,role]).sort();
      if (JSON.stringify(inputs(current.edges)) !== JSON.stringify(inputs(cleaned.edges))) throw invalid('已提交镜头的输入连线不能修改。');
    }
    const doc = { ...current, ...cleaned, version: current.version + 1, updated_at: new Date().toISOString() };
    await write(doc);
    return doc;
  });
}
