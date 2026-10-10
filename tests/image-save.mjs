import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const media = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-images-')));
process.env.ORBIT_FRAME_MEDIA_DIR = media;
const { saveGeneratedImages, generatedImageDir } = await import('../src/image-save.js');
const { readFrames } = await import('../src/video-frames.js');

function png(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
}

test('saves generated images into the media directory, usable as a first frame', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(png(1024, 1024));
  try {
    const [image] = await saveGeneratedImages(['https://p3-flow-imagex-sign.byteimg.com/a.png']);
    assert.equal(path.dirname(image.file), generatedImageDir);
    assert.deepEqual([image.width, image.height, image.type], [1024, 1024, 'image/png']);
    const [frame] = await readFrames('image_to_video', { first_frame: { path: image.media_path } });
    assert.equal(frame.width, 1024);
  } finally { globalThis.fetch = original; }
});

test('rejects non-HTTPS URLs and non-image content', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>not an image</html>');
  try {
    await assert.rejects(saveGeneratedImages(['http://example.com/a.png']), /HTTPS/);
    await assert.rejects(saveGeneratedImages(['https://example.com/a.png']), /not a PNG/);
  } finally { globalThis.fetch = original; }
});
