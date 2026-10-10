// CLI/MCP read the explicitly supplied local file and send its bytes to the
// authenticated upload endpoint. The gateway never gains arbitrary file access.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import { validateFrameData } from '../src/video-frames.js';
import { fetchGateway } from './video-request-id.mjs';

const invalid = message => Object.assign(new Error(message), { diagnostic: {
  code: 'invalid_frame', message, submitted: false, retryable: true,
} });

export function inferVideoMode(mode, first, last) {
  const chosen = !mode || mode === 'auto'
    ? last ? 'first_last_frame' : first ? 'image_to_video' : 'text_to_video' : mode;
  if (!['text_to_video', 'image_to_video', 'first_last_frame'].includes(chosen)) throw invalid('Unsupported video mode');
  if (last && !first) throw invalid('A last frame requires a first frame');
  if (chosen === 'text_to_video' && (first || last)) throw invalid('text_to_video cannot ignore supplied images; omit mode or use auto');
  if (chosen !== 'text_to_video' && !first) throw invalid('first_frame is required');
  if (chosen === 'first_last_frame' && !last) throw invalid('last_frame is required');
  if (chosen === 'image_to_video' && last) throw invalid('Two images require first_last_frame; omit mode or use auto');
  return chosen;
}

function framePath(spec, role) {
  const raw = typeof spec === 'string' ? spec : spec?.path;
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw invalid(`${role}: a local image path is required`);
  if (/^[a-z]+:\/\//i.test(raw)) throw invalid(`${role}: use a local file, not a URL`);
  return raw;
}

async function readLocalFrame(spec, role) {
  const raw = framePath(spec, role);
  const mediaRelative = /^(uploads|generated)\//.test(raw);
  const resolved = path.resolve(mediaRelative ? config.mediaDir : process.cwd(), raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
  let stat;
  try { stat = await fs.stat(resolved); } catch { throw invalid(`${role}: image file does not exist: ${raw}`); }
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw invalid(`${role}: choose a regular image file no larger than 20 MB`);
  const data = await fs.readFile(resolved);
  let info;
  try { info = validateFrameData(data, role); } catch (error) { throw invalid(error.message); }
  const real = await fs.realpath(resolved), root = await fs.realpath(config.mediaDir).catch(() => null);
  const relative = root && real.startsWith(root + path.sep) ? path.relative(root, real).split(path.sep).join('/') : null;
  const metadata=relative ? await fs.readFile(real+'.meta.json','utf8').then(JSON.parse).catch(()=>({})) : {};
  return { data, info, metadata, name: path.basename(raw).slice(0, 140), sha256: createHash('sha256').update(data).digest('hex'),
    // Only directly addressable library assets can skip upload. Other files
    // inside mediaDir still need a stable upload reference for canvas previews.
    media_path: relative && /^(uploads|generated)\/[\w.-]+$/.test(relative) ? relative : null };
}

async function uploadBytes(frame) {
  const response = await fetchGateway(`http://127.0.0.1:${config.port}/v1/videos/frames`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/octet-stream' },
    body: frame.data, signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw invalid(result.error?.message || `Image upload failed: HTTP ${response.status}`);
  return result;
}

async function store(frame, upload = uploadBytes) {
  const asset = frame.media_path ? { path: frame.media_path, ...frame.info, bytes: frame.data.length,
    preview_url: frame.media_path.startsWith('uploads/') ? `/v1/videos/frames/${path.basename(frame.media_path)}` : `/v1/media/${frame.media_path}` }
    : await upload(frame);
  return { ...asset, ...frame.metadata, path:asset.path,preview_url:asset.preview_url,width:frame.info.width,height:frame.info.height,bytes:frame.data.length,
    name: frame.name, asset_id:`sha256:${frame.sha256}`,sha256: frame.sha256 };
}

export async function uploadFrame(spec) {
  return store(await readLocalFrame(spec, 'frame'));
}

export async function prepareVideoFrames(args, { upload } = {}) {
  if (args.first_frame != null && args.first_frame_path != null || args.last_frame != null && args.last_frame_path != null) throw invalid('Use either first_frame or first_frame_path (and likewise for last_frame), not both');
  const first = args.first_frame ?? args.first_frame_path;
  const last = args.last_frame ?? args.last_frame_path;
  const mode = inferVideoMode(args.mode, first != null, last != null);
  // Validate every image before uploading anything or submitting generation.
  const files = await Promise.all([['first_frame', first], ['last_frame', last]].filter(([,spec]) => spec != null)
    .map(async ([role,spec]) => [role, await readLocalFrame(spec, role)]));
  const result = { mode };
  for (const [role, file] of files) result[role] = await store(file, upload);
  return result;
}

export async function prepareImageReferences(args) {
  if (args.reference_images != null && args.reference_image_paths != null) throw invalid('Use reference_images or reference_image_paths, not both');
  for (const name of ['images','image','referenceImages','referenceList','input']) if(args[name] != null) throw invalid(`Unsupported ${name}; use reference_image_paths`);
  const refs=args.reference_image_paths ?? args.reference_images ?? [];
  if(!Array.isArray(refs) || refs.length > 8) throw invalid('reference_image_paths must contain at most 8 local files');
  const files=await Promise.all(refs.map((spec,index)=>readLocalFrame(spec,`reference_${index+1}`)));
  return Promise.all(files.map(file=>store(file)));
}
