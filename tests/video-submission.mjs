import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistOriginalVideoReceipt, performVideoSubmission, safeSubmissionError } from '../src/video-submission.js';
import { scopedCleanupSnapshots, scopedUploadClient, nativeAttachmentWaitState, nativeVideoAttachmentBlocks } from '../src/video-attachment-upload.js';

const ack = { conversationId: '38446319722095618', runId: '58056564311676930' };
const original = () => ({ id: 'a'.repeat(64), prompt: 'original scene', frames: [{ role: 'first_frame', sha256: 'b'.repeat(64) }],
  options: { model: 'Seedance 2.5', duration: 10, ratio: '9:16', mode: 'image_to_video' } });
const operations = extra => ({ context: async () => ({ runtime: 'cloud' }), cleanup: async () => {}, ...extra });

test('arbitrary error fields, stack and signed links never enter submission diagnostics', () => {
  const error = Object.assign(new Error('secret-token https://example.invalid/file?signature=secret'), { name: 'secret-name', code: 'secret-code', stack: 'secret-stack', requestBody: { token: 'secret' } });
  const result = safeSubmissionError(error, original());
  assert.equal(result.phase, 'unknown'); assert.equal(result.submitted, 'unknown');
  assert.equal(result.code, 'unknown_error'); assert.equal(result.name, 'Error');
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('https:'));
  assert.match(result.prompt_sha256, /^[a-f0-9]{64}$/); assert.equal(result.frame_hashes[0].sha256, 'b'.repeat(64));
  assert.equal(safeSubmissionError(Error('Doubao attachments did not finish uploading within 60000 ms'), original()).category, 'attachment_upload_timeout');
});

test('first ACK is persisted while the stream is pending and survives a later stream error', async () => {
  const job = original(), saved = [], instruction = 'original image instruction', paths = Object.freeze(['/private/first_frame.png']);
  const blocks = Object.freeze([{ original: true }]), files = Object.freeze([{ name: 'first_frame.png', size: 123 }]);
  const frameBefore = JSON.stringify(job.frames), optionsBefore = JSON.stringify(job.options);
  let rejectStream, streamStarted, calls = 0, cleanup = 0;
  const started = new Promise(resolve => { streamStarted = resolve; });
  const run = performVideoSubmission(instruction, paths, { onReceipt: r => persistOriginalVideoReceipt(job, r, async j => saved.push(structuredClone(j))) }, operations({
    upload: async received => { assert.equal(received, paths); return files; },
    encode: async received => { assert.equal(received, files); return { blocks }; },
    send: async (message, context, received, onReceipt) => {
      calls++; assert.equal(message, instruction); assert.equal(received, blocks); onReceipt(ack); streamStarted();
      return new Promise((resolve, reject) => { rejectStream = reject; });
    }, cleanup: async () => { cleanup++; },
  }));
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.length, 1); assert.equal(saved[0].runId, ack.runId);
  rejectStream(Object.assign(Error('secret network error'), { code: 'incomplete_stream' }));
  await assert.rejects(run, error => {
    assert.equal(error.receipt.runId, ack.runId); assert.equal(safeSubmissionError(error, job).submitted, true);
    assert.equal(safeSubmissionError(error, job).phase, 'acknowledged'); return true;
  });
  assert.equal(calls, 1); assert.equal(cleanup, 1);
  assert.equal(JSON.stringify(job.frames), frameBefore); assert.equal(JSON.stringify(job.options), optionsBefore);
});

test('ACK persistence conflicts never replace the original run', async () => {
  const job = original(); let saves = 0;
  await persistOriginalVideoReceipt(job, ack, async () => { saves++; });
  await persistOriginalVideoReceipt(job, ack, async () => { saves++; });
  await assert.rejects(persistOriginalVideoReceipt(job, { ...ack, runId: '58056564311676931' }, async () => { saves++; }), { code: 'receipt_conflict' });
  assert.equal(job.runId, ack.runId); assert.equal(saves, 1);
});

test('SDK private receipt-store failure still checkpoints the ACK on the original job', async () => {
  const job = original();
  await assert.rejects(performVideoSubmission('original', [], { onReceipt: r => persistOriginalVideoReceipt(job, r, async () => {}) }, operations({
    storeReceipt: async () => { throw Error('secret disk detail'); },
    send: async (message, context, blocks, onReceipt) => { onReceipt(ack); return ack; },
  })), { code: 'receipt_persistence_failed' });
  assert.equal(job.runId, ack.runId); assert.equal(job.submissionReceipt.run_id, ack.runId);
});

test('receipt callback returns an awaitable checkpoint and a failed job save preserves ACK in memory', async () => {
  const job = original(); let cacheCalls = 0, saves = 0;
  await assert.rejects(performVideoSubmission('original', [], { onReceipt: r => persistOriginalVideoReceipt(job, r, async () => { saves++; throw Error('disk full'); }) }, operations({
    storeReceipt: async () => { cacheCalls++; },
    send: async (message, context, blocks, onReceipt) => {
      const checkpoint = onReceipt(ack); assert.equal(typeof checkpoint?.then, 'function'); await checkpoint;
      assert.equal(job.runId, ack.runId); throw Error('later stream failure');
    },
  })), error => { assert.equal(error.code, 'receipt_persistence_failed'); assert.equal(error.receipt.runId, ack.runId); return true; });
  assert.equal(saves, 1); assert.equal(cacheCalls, 0);
});

test('a proven pre-send upload failure is distinct from an unknown send and neither retries', async () => {
  let sends = 0;
  const send = async () => { sends++; throw Error('connection vanished before ACK'); };
  await assert.rejects(performVideoSubmission('original', ['/private/frame.png'], {}, operations({ upload: async () => { throw Error('Doubao attachments did not finish uploading within 60000 ms'); }, send })), error => {
    const diagnostic = safeSubmissionError(error, original());
    assert.equal(diagnostic.submitted, false); assert.equal(diagnostic.phase, 'attachment_upload'); assert.equal(diagnostic.send_invoked, false); return true;
  });
  assert.equal(sends, 0);
  await assert.rejects(performVideoSubmission('original', [], {}, operations({ send })), error => {
    const diagnostic = safeSubmissionError(error, original());
    assert.equal(diagnostic.submitted, 'unknown'); assert.equal(diagnostic.phase, 'upstream_send'); return true;
  });
  assert.equal(sends, 1);
});

test('encoding failure cleans only the current upload and does not send', async () => {
  const files = [{ name: 'first_frame.png', size: 123 }]; let cleaned = 0;
  await assert.rejects(performVideoSubmission('original', ['first_frame.png'], {}, operations({
    upload: async () => files, encode: async () => { throw Error('Cannot identify the staged attachments safely'); },
    cleanupFiles: async received => { assert.equal(received, files); cleaned++; }, send: async () => assert.fail('must not send'),
  })));
  assert.equal(cleaned, 1);
});

test('timeout global draft clearing is blocked; scoped cleanup excludes unrelated or ambiguous attachments', () => {
  let evaluated = 0; const client = scopedUploadClient({ evaluate: () => { evaluated++; } });
  assert.throws(() => client.evaluate("delete-btn-any; new MouseEvent('click', {})"), { code: 'attachment_cleanup_unscoped' });
  client.evaluate('read attachment status'); assert.equal(evaluated, 1);
  const files = [{ name: 'first_frame.png', size: 123 }], params = { chatId: 'draft', skillType: 'test' };
  const owned = { name: 'first_frame.png', size: 123, localKey: 'owned' }, user = { name: 'user.png', size: 456, localKey: 'user' };
  assert.deepEqual(scopedCleanupSnapshots({ groups: [{ params, items: [owned, user] }] }, files), [{ params, localKeys: ['owned'] }]);
  assert.deepEqual(scopedCleanupSnapshots({ groups: [{ params, items: [owned, { ...owned, localKey: 'ambiguous' }, user] }] }, files), []);
});

test('a broken preview can finish waiting only when the original file encodes on its original draft', async () => {
  const dom = { files: [], images: [{ loaded: false }], progressing: false, status: '' };
  const files = [{ name: 'first_frame.png', size: 123, type: 'image/png' }];
  const encoded = { params: { chatId: 'original' }, localKeys: ['owned'], blocks: [{ content: { attachment_block: { attachments: [{}] } } }] };
  const ready = await nativeAttachmentWaitState(dom, files, async received => { assert.equal(received, files); return encoded; }, 'original');
  assert.equal(ready.images[0].loaded, true); assert.equal(dom.images[0].loaded, false);
  for (const [state, encode] of [[dom, async () => { throw Error('identifiers not ready'); }],
    [{ ...dom, progressing: true }, async () => encoded], [{ ...dom, status: '上传失败' }, async () => encoded],
    [dom, async () => ({ ...encoded, params: { chatId: 'other' } })],
    [dom, async () => ({ ...encoded, blocks: [] })], [dom, async () => ({ ...encoded, localKeys: [] })]]) {
    assert.deepEqual(await nativeAttachmentWaitState(state, files, encode, 'original'), state);
  }
  assert.equal((await nativeAttachmentWaitState({ ...dom, images: [{ loaded: true }] }, files,
    async () => { throw Error('identifiers not ready'); }, 'original')).images[0].loaded, false);
});

test('native encoding rejects role type changes and ambiguous owned keys', async () => {
  const files = [{ name: 'first_frame.png', size: 123, type: 'image/png' }];
  const snapshot = { params: { chatId: 'original' }, localKeys: ['owned'], blocks: [] };
  for (const type of ['file', undefined]) {
    let calls = 0;
    await assert.rejects(nativeVideoAttachmentBlocks({ evaluate: async () => ++calls === 1 ? snapshot : [type] }, files), /Composer attachments changed/);
  }
  await assert.rejects(nativeVideoAttachmentBlocks({ evaluate: async () => ({ ...snapshot, localKeys: [] }) }, files), /Cannot identify/);
});

test('the job entry point returns a saved unknown for the same key without readiness, submission or state rewriting', async () => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { createHash } = await import('node:crypto');
  process.env.DOUBAO_CDP_ENDPOINT = 'http://127.0.0.1:0';
  const { config } = await import('../src/config.js');
  const previous = config.dataDir, dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-submit-once-'));
  config.dataDir = dir;
  try {
    const { startEnterpriseVideoJob } = await import('../src/enterprise-video-jobs.js');
    const body = { prompt: 'offline original fixture', model: 'Seedance 2.5', duration: 10, ratio: '9:16', idempotency_key: 'offline-original-once' };
    const id = createHash('sha256').update(`doubao-desktop:${body.idempotency_key}`).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify({ prompt: body.prompt, model: body.model, duration: body.duration, ratio: body.ratio })).digest('hex');
    const file = path.join(dir, 'enterprise-video-jobs', id+'.json');
    await fs.mkdir(path.dirname(file));
    const saved = JSON.stringify({ id, fingerprint, status: 'unknown', submissionStarted: true, videos: [], error: { code: 'submit_unknown', submitted: 'unknown', retryable: false } });
    await fs.writeFile(file, saved);
    for (let i=0; i<2; i++) assert.equal((await startEnterpriseVideoJob(body)).status, 'unknown');
    await assert.rejects(startEnterpriseVideoJob({ ...body, duration: 20 }), { code: 'invalid_request' });
    assert.equal(await fs.readFile(file, 'utf8'), saved);
  } finally { config.dataDir = previous; await fs.rm(dir, { recursive: true, force: true }); }
});
