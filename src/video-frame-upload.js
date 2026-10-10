import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { config } from './config.js';
import { validateFrameData, readFrames } from './video-frames.js';

export async function storeUploadedFrame(data) {
  const info = validateFrameData(data);
  await fs.mkdir(config.mediaDir, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(config.mediaDir);
  const uploads = path.join(root, 'uploads');
  await fs.mkdir(uploads, { recursive: true, mode: 0o700 });
  const actual = await fs.realpath(uploads);
  if (!actual.startsWith(root + path.sep)) throw new Error('Invalid frame upload directory');
  const name = `${randomUUID()}.${info.ext}`;
  await fs.writeFile(path.join(actual, name), data, { mode: 0o600, flag: 'wx' });
  const sha256 = createHash('sha256').update(data).digest('hex');
  const asset={ asset_id: `sha256:${sha256}`, sha256, provider: 'local-upload', model_verification: 'not_applicable', path: `uploads/${name}`, ...info, bytes: data.length,
    preview_url: `/v1/videos/frames/${name}` };
  await fs.writeFile(path.join(actual,name)+'.meta.json',JSON.stringify(asset),{mode:0o600,flag:'wx'});
  return asset;
}

export async function readUploadedFrame(name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/.test(name)) return null;
  try {
    const [frame] = await readFrames('image_to_video', { first_frame: { path: `uploads/${name}` } });
    return frame;
  } catch (error) {
    if (error.invalid || error.code === 'ENOENT') return null;
    throw error;
  }
}
