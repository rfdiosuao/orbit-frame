import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const media = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-frame-upload-'));
process.env.ORBIT_FRAME_MEDIA_DIR = media;
const { createApp } = await import('../src/gateway.js');
const { config } = await import('../src/config.js');
const { readFrames } = await import('../src/video-frames.js');

function png(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12);
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
}

test('authenticated browser frames round-trip and feed first/last roles in order', async () => {
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/octet-stream' };
  try {
    assert.equal((await fetch(base + '/v1/videos/frames', { method: 'POST', body: png(1280, 720) })).status, 401);
    const frames = [];
    for (const image of [png(1280, 720), png(720, 1280)]) {
      const response = await fetch(base + '/v1/videos/frames', { method: 'POST', headers, body: image });
      assert.equal(response.status, 201);
      const saved = await response.json(); frames.push(saved);
      assert.match(saved.path, /^uploads\/[0-9a-f-]{36}\.png$/);
      assert.ok(!JSON.stringify(saved).includes(media));
      assert.equal((await fs.stat(path.join(media, saved.path))).mode & 0o777, 0o600);
      assert.equal((await fetch(base + saved.preview_url)).status, 401);
      const preview = await fetch(base + saved.preview_url, { headers });
      assert.equal(preview.headers.get('content-type'), 'image/png');
      assert.equal(preview.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), image);
    }
    const read = await readFrames('first_last_frame', { first_frame: frames[0], last_frame: frames[1] });
    assert.deepEqual(read.map(frame => [frame.role, frame.width, frame.height]), [['first_frame', 1280, 720], ['last_frame', 720, 1280]]);
    for (const body of [Buffer.from('<svg></svg>'), png(200, 200), png(3000, 400), png(7000, 4000)]) {
      assert.equal((await fetch(base + '/v1/videos/frames', { method: 'POST', headers, body })).status, 400);
    }
    assert.equal((await fetch(base + '/v1/videos/frames', { method: 'POST', headers, body: Buffer.alloc(20 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await fetch(base + '/v1/videos/frames/not-a-file.png', { headers })).status, 404);
  } finally {
    server.close(); server.closeAllConnections(); await fs.rm(media, { recursive: true, force: true });
  }
});
