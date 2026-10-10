import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const media = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-canvas-media-')));
process.env.ORBIT_FRAME_MEDIA_DIR = media;
process.env.DOUBAO_CDP_ENDPOINT = 'http://127.0.0.1:0';
const { config } = await import('../src/config.js');
config.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-canvas-data-'));
const { createCanvas, getCanvas, saveCanvas, listCanvases, deleteCanvas } = await import('../src/canvas-store.js');
const { startImageJob, getImageJob } = await import('../src/image-jobs.js');
const { listMediaImages } = await import('../src/image-save.js');
const { createApp } = await import('../src/gateway.js');
after(() => Promise.all([fs.rm(config.dataDir, { recursive: true, force: true }), fs.rm(media, { recursive: true, force: true })]));

function png(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
}
const image = { id: 'img1', type: 'image', x: 0, y: 0, status: 'ready', prompt: '', ratio: '16:9',
  asset: { path: 'uploads/a.png', preview_url: '/v1/videos/frames/a.png', width: 1280, height: 720 } };
const video = { id: 'vid1', type: 'video', x: 400, y: 0, prompt: '狐狸奔跑', duration: 6, ratio: '16:9' };
const note = { id: 'note1', type: 'note', x: 0, y: 300, text: '首帧柔和过渡到尾帧' };

test('persists separate prompt and frame connections and rejects crossed or duplicate prompt roles', async () => {
  const doc = await createCanvas({ cards: [note, image, video], edges: [
    { id: 'p1', from: note.id, to: video.id, role: 'prompt' },
    { id: 'f1', from: image.id, to: video.id, role: 'first_frame' },
  ] });
  const loaded = await getCanvas(doc.id);
  assert.equal(loaded.edges.length, 2);
  assert.equal(loaded.cards.find(card => card.id === note.id).text, note.text);
  for (const edges of [
    [{ id: 'p1', from: image.id, to: video.id, role: 'prompt' }],
    [{ id: 'f1', from: note.id, to: video.id, role: 'first_frame' }],
    [{ id: 'p1', from: note.id, to: video.id, role: 'prompt' }, { id: 'p2', from: note.id, to: video.id, role: 'prompt' }],
  ]) await assert.rejects(saveCanvas(doc.id, { version: doc.version, cards: [note, image, video], edges }), error => error.invalid);
});

test('creates, saves with version checks and lists canvases', async () => {
  const doc = await createCanvas({ title: '测试画布' });
  assert.equal(doc.version, 1);
  const saved = await saveCanvas(doc.id, { version: 1, title: '改名', cards: [image, video],
    edges: [{ id: 'e1', from: 'img1', to: 'vid1', role: 'first_frame' }], viewport: { x: 10, y: 20, zoom: 0.5 } });
  assert.equal(saved.version, 2);
  assert.equal((await getCanvas(doc.id)).cards.length, 2);
  await assert.rejects(saveCanvas(doc.id, { version: 1, cards: [] }), error => error.conflict && error.current.version === 2);
  assert.ok((await listCanvases()).some(item => item.id === doc.id && item.title === '改名' && item.cards === 2));
  assert.equal(await saveCanvas('not-a-uuid', { version: 1 }), null);
});

test('video model and Seedance 2.5 duration survive save and reload without widening Fast bounds', async () => {
  const doc = await createCanvas({ cards: [{ ...video, model: 'Seedance 2.5', duration: 30 }] });
  const loaded = await getCanvas(doc.id);
  assert.equal(loaded.cards[0].model, 'Seedance 2.5');
  assert.equal(loaded.cards[0].duration, 30);
  const saved = await saveCanvas(doc.id, { version: doc.version, cards: loaded.cards });
  assert.equal(saved.cards[0].model, 'Seedance 2.5');
  assert.equal(saved.cards[0].duration, 30);
  for (const card of [{ ...video, duration: 30 }, { ...video, model: 'Seedance 2.0 Fast', duration: 30 }, { ...video, model: 'Seedance 2.5', duration: 3 }]) {
    await assert.rejects(createCanvas({ cards: [card] }), error => error.invalid && /duration/.test(error.message));
  }
  const legacy = await createCanvas({ cards: [video] });
  assert.equal(legacy.cards[0].model, 'Seedance 2.0 Fast');
});

test('rejects unsafe or inconsistent canvas content', async () => {
  const doc = await createCanvas({});
  const bad = [
    { cards: [{ ...image, asset: { ...image.asset, path: '../../.env' } }] },
    { cards: [{ ...image, asset: { ...image.asset, path: '/etc/hosts' } }] },
    { cards: [{ ...image, asset: { ...image.asset, preview_url: 'https://evil.example/x.png' } }] },
    { cards: [{ ...image, type: 'script' }] },
    { cards: [image, { ...image }] },
    { cards: [image, video], edges: [{ id: 'e1', from: 'vid1', to: 'img1', role: 'first_frame' }] },
    { cards: [image, video], edges: [{ id: 'e1', from: 'img1', to: 'vid1', role: 'first_frame' }, { id: 'e2', from: 'img1', to: 'vid1', role: 'first_frame' }] },
    { cards: [image], edges: [{ id: 'e1', from: 'img1', to: 'missing', role: 'derived' }] },
    { cards: [{ ...video, duration: 99 }] },
    { cards: [{ ...video, task_id: 'not a task' }] },
  ];
  for (const body of bad) await assert.rejects(saveCanvas(doc.id, { version: 1, ...body }), error => error.invalid === true, JSON.stringify(body).slice(0, 80));
  assert.equal((await getCanvas(doc.id)).version, 1, 'rejected saves change nothing');
});

test('canvas API needs the key; media routes accept the local media cookie only for media', async () => {
  await fs.mkdir(path.join(media, 'generated'), { recursive: true });
  await fs.writeFile(path.join(media, 'generated', 'image-test.png'), png(640, 360));
  await fs.writeFile(path.join(media, 'secret.png'), png(640, 360));
  await fs.symlink(path.join(media, 'secret.png'), path.join(media, 'generated', 'link.png'));
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${config.localApiKey}` };
  try {
    assert.equal((await fetch(`${base}/v1/canvases`)).status, 401);
    const created = await fetch(`${base}/v1/canvases`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"title":"API"}' });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const stale = await fetch(`${base}/v1/canvases/${id}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"version":7}' });
    assert.equal(stale.status, 409);

    assert.equal((await fetch(`${base}/v1/media/generated/image-test.png`)).status, 401);
    const access = await fetch(`${base}/api/local-access`, { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
    const cookie = access.headers.get('set-cookie');
    assert.match(cookie, /orbit_media=[0-9a-f]{64}.*HttpOnly.*SameSite=Strict/i);
    const pair = cookie.split(';')[0];
    const ok = await fetch(`${base}/v1/media/generated/image-test.png`, { headers: { Cookie: pair } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    for (const bad of ['link.png', '..%2Fsecret.png', 'missing.png']) {
      assert.equal((await fetch(`${base}/v1/media/generated/${bad}`, { headers: { Cookie: pair } })).status, 404, bad);
    }
    assert.equal((await fetch(`${base}/v1/media/etc/hosts`, { headers: { Cookie: pair } })).status, 404);
    assert.equal((await fetch(`${base}/v1/canvases`, { headers: { Cookie: pair } })).status, 401, 'cookie never opens the API');
  } finally { server.close(); server.closeAllConnections(); }
});

test('keeps card width and image job ids, and deletes only the canvas file', async () => {
  const doc = await createCanvas({});
  const job = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const saved = await saveCanvas(doc.id, { version: 1, cards: [{ ...image, w: 420, status: 'generating', image_job: job, asset: null }] });
  assert.equal(saved.cards[0].w, 420);
  assert.equal(saved.cards[0].image_job, job);
  await assert.rejects(saveCanvas(doc.id, { version: 2, cards: [{ ...image, w: 5000 }] }), error => error.invalid);
  await assert.rejects(saveCanvas(doc.id, { version: 2, cards: [{ ...image, image_job: '../x' }] }), error => error.invalid);
  assert.equal(await deleteCanvas(doc.id), true);
  assert.equal(await getCanvas(doc.id), null);
  assert.equal(await deleteCanvas(doc.id), false);
});

test('large canvas overview zoom is persisted while unusably small zoom is rejected',async()=>{
  const doc=await createCanvas({viewport:{x:0,y:0,zoom:0.03}});assert.equal((await getCanvas(doc.id)).viewport.zoom,0.03);
  await assert.rejects(saveCanvas(doc.id,{...doc,viewport:{x:0,y:0,zoom:0.001}}),error=>error.invalid);
});

test('background image jobs save results locally and report failures', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(png(1024, 1024));
  try {
    const started = await startImageJob({ prompt: '金色小狐狸', ratio: '1:1' }, async () => ({ images: ['https://p3-flow-imagex-sign.byteimg.com/a.png', 'https://p3-flow-imagex-sign.byteimg.com/b.png'] }));
    assert.equal(started.status, 'running');
    let done;
    do { done = await getImageJob(started.id, { waitMs: 5000 }); } while (done.status === 'running');
    assert.equal(done.status, 'completed');
    assert.equal(done.images.length, 2);
    assert.match(done.images[0].path, /^generated\/image-.+\.png$/);
    assert.match(done.images[0].preview_url, /^\/v1\/media\/generated\//);
    const listed = await listMediaImages('generated');
    assert.ok(listed.some(item => item.path === done.images[0].path && item.width === 1024));

    const failing = await startImageJob({ prompt: 'x' }, async () => { throw new Error('额度不足'); });
    assert.equal((await getImageJob(failing.id, { waitMs: 5000 })).status, 'failed');
    await assert.rejects(startImageJob({ prompt: '' }, async () => ({})), error => error.invalid);
    await assert.rejects(startImageJob({ prompt: 'x', ratio: 'wide' }, async () => ({})), error => error.invalid);
  } finally { globalThis.fetch = original; }
});

test('a job left running by an earlier gateway process is reported as uncertain', async () => {
  const id = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
  await fs.mkdir(path.join(config.dataDir, 'image-jobs'), { recursive: true });
  await fs.writeFile(path.join(config.dataDir, 'image-jobs', `${id}.json`), JSON.stringify({ id, pid: -1, status: 'running', prompt: 'x', images: [] }));
  const job = await getImageJob(id);
  assert.equal(job.status, 'unknown');
  assert.match(job.message, /无法确认/);
});


test('image job API rejects unsupported reference fields before creating jobs', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${config.localApiKey}`, 'Content-Type': 'application/json' };
  const before = await fs.readdir(path.join(config.dataDir, 'image-jobs')).catch(() => []);
  try {
    for (const refs of [{ images: ['ref.png'] }, { image: 'ref.png' }, { reference_images: ['ref.png'] }, { referenceImages: ['ref.png'] }, { referenceList: ['ref.png'] }, { input: [{ image_url: { url: 'ref.png' } }] }, { input: [{ image: 'ref.png' }] }]) {
      const response = await fetch(base + '/v1/images/jobs', { method: 'POST', headers, body: JSON.stringify({ provider: 'doubao-desktop', prompt: 'TEST_ONLY_NO_GENERATION', ...refs }) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /参考图/);
    }
    assert.deepEqual(await fs.readdir(path.join(config.dataDir, 'image-jobs')).catch(() => []), before);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
