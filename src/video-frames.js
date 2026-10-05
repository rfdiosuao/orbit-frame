// Reference frames for image_to_video and first_last_frame. Paths must stay
// inside the media directory so an agent cannot make the gateway read
// arbitrary local files; images are checked by content, not by extension.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';

export const frameRoles = {
  text_to_video: [],
  image_to_video: ['first_frame'],
  first_last_frame: ['first_frame', 'last_frame'],
};
const maxBytes = 20 * 1024 * 1024;
const invalid = message => Object.assign(new Error(message), { invalid: true });

export function imageInfo(data) {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a &&
    data.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'image/png', ext: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 9 < data.length;) {
      if (data[at] !== 0xff) return null;
      const marker = data[at + 1];
      if (marker === 0xff) { at++; continue; }
      if (marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) { at += 2; continue; }
      const length = data.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'image/jpeg', ext: 'jpg', width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    const webp = (width, height) => ({ type: 'image/webp', ext: 'webp', width, height });
    if (chunk === 'VP8 ') return webp(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L') {
      return webp(1 + (((data[22] & 0x3f) << 8) | data[21]),
        1 + (((data[24] & 0x0f) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6)));
    }
    if (chunk === 'VP8X') return webp(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
  }
  return null;
}

async function readFrame(role, spec) {
  const raw = typeof spec === 'string' ? spec : spec?.path;
  if (typeof raw !== 'string' || !raw.trim()) throw invalid(`${role}.path is required`);
  const root = await fs.realpath(config.mediaDir).catch(() => null);
  if (!root) throw invalid(`media directory does not exist: ${config.mediaDir}`);
  const real = await fs.realpath(path.resolve(root, raw)).catch(() => null);
  if (!real) throw invalid(`${role} image does not exist`);
  if (!real.startsWith(root + path.sep)) throw invalid(`${role} must be inside the media directory ${root}`);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw invalid(`${role} is not a regular file`);
  if (stat.size > maxBytes) throw invalid(`${role} image must be at most 20 MB`);
  const data = await fs.readFile(real);
  const info = imageInfo(data);
  if (!info) throw invalid(`${role} must be a PNG, JPEG or WebP image`);
  const { width, height } = info;
  if (Math.min(width, height) < 300 || Math.max(width, height) > 6000) throw invalid(`${role} image must be 300 to 6000 pixels per side`);
  if (width / height < 0.4 || width / height > 2.5) throw invalid(`${role} aspect ratio must be between 2:5 and 5:2`);
  return { role, data, ...info, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

// Validates the frames a mode requires; frames for other roles are rejected
// rather than silently ignored.
export async function readFrames(mode, body) {
  const roles = frameRoles[mode];
  if (!roles) throw invalid(`mode must be one of ${Object.keys(frameRoles).join(', ')}`);
  for (const role of ['first_frame', 'last_frame']) {
    if (!roles.includes(role) && body[role] != null) throw invalid(`${role} is not used by mode ${mode}`);
  }
  const frames = [];
  for (const role of roles) frames.push(await readFrame(role, body[role]));
  return frames;
}

export function frameWarnings(frames, ratio) {
  const [w, h] = ratio.split(':').map(Number);
  const target = w / h;
  const warnings = [];
  for (const frame of frames) {
    if (Math.abs(frame.width / frame.height / target - 1) > 0.05) {
      warnings.push(`${frame.role} is ${frame.width}×${frame.height}, which does not match ${ratio}; Doubao may crop or pad it.`);
    }
  }
  if (frames.length === 2 && Math.abs((frames[0].width / frames[0].height) / (frames[1].width / frames[1].height) - 1) > 0.05) {
    warnings.push('first_frame and last_frame have different aspect ratios.');
  }
  return warnings;
}

export const frameSummary = frame => ({ role: frame.role, type: frame.type, width: frame.width,
  height: frame.height, bytes: frame.bytes, sha256: frame.sha256 });
