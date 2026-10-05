import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const media = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-media-')));
const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-outside-')));
process.env.ORBIT_FRAME_MEDIA_DIR = media;
const { imageInfo, readFrames, frameWarnings } = await import('../src/video-frames.js');

function png(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
}
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19); sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}
function webpX(width, height) {
  const data = Buffer.alloc(30); data.write('RIFF', 0, 'ascii'); data.write('WEBP', 8, 'ascii'); data.write('VP8X', 12, 'ascii');
  data.writeUIntLE(width - 1, 24, 3); data.writeUIntLE(height - 1, 27, 3);
  return data;
}

test('reads image dimensions from content', () => {
  assert.deepEqual(imageInfo(png(1280, 720)), { type: 'image/png', ext: 'png', width: 1280, height: 720 });
  assert.deepEqual(imageInfo(jpeg(720, 1280)), { type: 'image/jpeg', ext: 'jpg', width: 720, height: 1280 });
  assert.deepEqual(imageInfo(webpX(1024, 1024)), { type: 'image/webp', ext: 'webp', width: 1024, height: 1024 });
  assert.equal(imageInfo(Buffer.from('<svg></svg>')), null);
});

test('accepts frames inside the media directory in role order', async () => {
  await fs.writeFile(path.join(media, 'first.png'), png(1280, 720));
  await fs.writeFile(path.join(media, 'last.jpg'), jpeg(1280, 720));
  const frames = await readFrames('first_last_frame', { first_frame: { path: 'first.png' }, last_frame: { path: path.join(media, 'last.jpg') } });
  assert.deepEqual(frames.map(frame => frame.role), ['first_frame', 'last_frame']);
  assert.match(frames[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(frameWarnings(frames, '16:9'), []);
  assert.equal(frameWarnings(frames, '9:16').length, 2);
});

test('rejects paths outside the media directory, including symlinks', async () => {
  await fs.writeFile(path.join(outside, 'secret.png'), png(1280, 720));
  await fs.symlink(path.join(outside, 'secret.png'), path.join(media, 'link.png'));
  for (const spec of [{ path: path.join(outside, 'secret.png') }, { path: '../' + path.basename(outside) + '/secret.png' }, { path: 'link.png' }]) {
    await assert.rejects(readFrames('image_to_video', { first_frame: spec }), error => error.invalid && /media directory/.test(error.message));
  }
});

test('rejects wrong modes, missing or unused frames, non-images and bad sizes', async () => {
  await fs.writeFile(path.join(media, 'note.png'), 'not an image');
  await fs.writeFile(path.join(media, 'tiny.png'), png(200, 200));
  await fs.writeFile(path.join(media, 'strip.png'), png(3000, 400));
  const cases = [
    ['video_to_video', {}], ['image_to_video', {}], ['text_to_video', { first_frame: { path: 'first.png' } }],
    ['image_to_video', { first_frame: { path: 'first.png' }, last_frame: { path: 'first.png' } }],
    ['image_to_video', { first_frame: { path: 'note.png' } }], ['image_to_video', { first_frame: { path: 'tiny.png' } }],
    ['image_to_video', { first_frame: { path: 'strip.png' } }], ['image_to_video', { first_frame: { path: 'missing.png' } }],
  ];
  for (const [mode, body] of cases) await assert.rejects(readFrames(mode, body), error => error.invalid === true, mode);
  assert.deepEqual(await readFrames('text_to_video', {}), []);
});
