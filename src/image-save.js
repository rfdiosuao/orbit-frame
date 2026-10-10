// Saves images returned by /v1/images/generations to local files so agents get
// paths instead of signed URLs. Defaults to the media directory, so a saved
// image can be used directly as a video first_frame / last_frame.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';
import { imageInfo } from './video-frames.js';

const maxBytes = 30 * 1024 * 1024;
export const generatedImageDir = path.join(config.mediaDir, 'generated');

export async function saveGeneratedImages(urls, dir = generatedImageDir, metadata = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const tag = randomBytes(3).toString('hex');
  const saved = [];
  for (const [index, raw] of urls.entries()) {
    let data;
    if (Buffer.isBuffer(raw)) data = raw;
    else {
      const url = new URL(raw);
      if (url.protocol !== 'https:') throw new Error('Image URL is not HTTPS');
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Image exceeds 30 MB');
      const chunks=[];let count=0;
      for await (const chunk of response.body) {
        count += chunk.length;
        if(count>maxBytes) throw new Error('Image exceeds 30 MB');
        chunks.push(chunk);
      }
      data = Buffer.concat(chunks);
    }
    if (data.length > maxBytes) throw new Error('Image exceeds 30 MB');
    const info = imageInfo(data);
    if (!info) throw new Error('Downloaded content is not a PNG, JPEG or WebP image');
    const file = path.join(dir, `image-${stamp}-${tag}-${index + 1}.${info.ext}`);
    await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
    const sha256=createHash('sha256').update(data).digest('hex');
    const image={ ...metadata, asset_id:`sha256:${sha256}`,sha256,file,width:info.width,height:info.height,type:info.type,bytes:data.length,
      ...(file.startsWith(config.mediaDir + path.sep) ? { media_path:path.relative(config.mediaDir,file) } : {}) };
    await fs.writeFile(file+'.meta.json',JSON.stringify({...image,file:undefined}),{mode:0o600});
    saved.push(image);
  }
  return saved;
}

const mediaName = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,139}$/;

// Reads an image from media/uploads or media/generated; anything else, any
// symlink escape or any non-image content resolves to null.
export async function readMediaImage(sub, name) {
  if (!['uploads', 'generated'].includes(sub) || !mediaName.test(String(name))) return null;
  const media = await fs.realpath(config.mediaDir).catch(() => null);
  const root = await fs.realpath(path.join(config.mediaDir, sub)).catch(() => null);
  if (!media || !root || path.dirname(root) !== media) return null;
  const real = await fs.realpath(path.join(root, name)).catch(() => null);
  if (!real || path.dirname(real) !== root) return null;
  const data = await fs.readFile(real);
  const info = imageInfo(data);
  return info ? { data, type: info.type } : null;
}

// Newest images in media/uploads or media/generated, for the canvas asset drawer.
export async function listMediaImages(sub, limit = 60) {
  if (!['uploads', 'generated'].includes(sub)) return [];
  const root = path.join(config.mediaDir, sub);
  let names;
  try { names = await fs.readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = (await Promise.all(names.filter(name => mediaName.test(name) && /\.(png|jpe?g|webp)$/i.test(name))
    .map(async name => { const stat = await fs.lstat(path.join(root, name)).catch(() => null); return stat?.isFile() ? { name, mtime: stat.mtimeMs } : null; })))
    .filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, Math.min(200, limit)));
  const images = [];
  for (const file of files) {
    const handle = await fs.open(path.join(root, file.name), 'r').catch(() => null);
    if (!handle) continue;
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(512 * 1024), 0, 512 * 1024, 0);
      const info = imageInfo(buffer.subarray(0, bytesRead));
      if (info) {
        const metadata=await fs.readFile(path.join(root,file.name)+'.meta.json','utf8').then(JSON.parse).catch(()=>({}));
        images.push({ ...metadata, path: `${sub}/${file.name}`, preview_url: `/v1/media/${sub}/${file.name}`,
          width: info.width, height: info.height, modified_at: new Date(file.mtime).toISOString() });
      }
    } finally { await handle.close(); }
  }
  return images;
}
