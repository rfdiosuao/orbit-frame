import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const { config } = await import('../src/config.js');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-image-recovery-'));
config.dataDir = temp;
const { startImageJob, getImageJob, resumeImageJobs } = await import('../src/image-jobs.js');

test('a live owner in another process remains running; a dead owner is uncertain without overwriting its file', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const id = randomUUID(), folder = path.join(temp, 'image-jobs');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.json`);
  const job = { id, pid: child.pid, status: 'running', prompt: 'TEST_ONLY', images: [] };
  try {
    await fs.writeFile(file, JSON.stringify(job));
    assert.equal((await getImageJob(id)).status, 'running');
    const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed;
    assert.equal((await getImageJob(id)).status, 'unknown');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'running');
  } finally { if (child.exitCode === null) child.kill(); await fs.rm(file, { force: true }); }
});

test('concurrent retries share one image submission and cannot reuse its key with changed input', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => release = resolve);
  const generate = async () => { calls++; await gate; throw new Error('TEST_ONLY_STOP'); };
  const input = { prompt: 'TEST_ONLY_IDEMPOTENCY', idempotency_key: randomUUID() };
  const jobs = await Promise.all([startImageJob(input, generate), startImageJob(input, generate)]);
  assert.equal(jobs[0].id, jobs[1].id); assert.equal(calls, 1);
  await assert.rejects(startImageJob({ ...input, prompt: 'different' }, generate), /同一请求编号/);
  await assert.rejects(startImageJob({ ...input, provider: 'doubao-desktop' }, generate), /同一请求编号/);
  await assert.rejects(startImageJob({ prompt: 'TEST_ONLY', ratio: '0:0' }, generate), /ratio/);
  release();
  const result = await getImageJob(jobs[0].id, { waitMs: 1000 });
  assert.equal(result.status, 'failed'); assert.equal(calls, 1);

});


test('unsupported references fail before creating or submitting a background image job', async () => {
  let calls = 0;
  const generate = async () => { calls++; throw new Error('TEST_ONLY'); };
  for (const refs of [ { images: ['ref.png'] }, { image: { url: 'ref.png' } }, { reference_images: ['ref.png'] }, { referenceImages: ['ref.png'] }, { referenceList: ['ref.png'] }, { input: [{ image_url: { url: 'ref.png' } }] }, { input: [{ image: 'ref.png' }] } ]) {
    const id = randomUUID();
    await assert.rejects(startImageJob({ prompt: 'TEST_ONLY', provider: 'doubao-desktop', idempotency_key: id, ...refs }, generate), error => error.invalid && /参考图/.test(error.message));
    assert.equal(await getImageJob(id), null);
  }
  assert.equal(calls, 0);
  const accepted = await startImageJob({ prompt: 'TEST_ONLY', provider: 'doubao-desktop', images: [], image: '', reference_images: [], referenceImages: [], referenceList: [], input: [{ text: 'TEST_ONLY' }] }, generate);
  const result = await getImageJob(accepted.id, { waitMs: 1000 });
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
});

test('accepted enterprise image jobs persist their receipt and resume the same run after owner death', async () => {
 const id=randomUUID(), receipt={conversationId:'38445132156657666',runId:'58004820066283010'};
 const input={prompt:'TEST_ONLY_RECEIPT',provider:'doubao-desktop',idempotency_key:id};
 let release;const gate=new Promise(r=>release=r);
 await startImageJob(input, async (_,callbacks)=>{await callbacks.onReceipt(receipt);await gate;throw Object.assign(new Error('TEST_ONLY_INTERRUPTION'),{uncertain:true});});
 let job;for(let i=0;i<20;i++){job=await getImageJob(id,{waitMs:50});if(job.run_id)break;}
 assert.equal(job.run_id,receipt.runId); release();
 for(let i=0;i<20;i++){job=await getImageJob(id,{waitMs:50});if(job.status==='unknown')break;}
 assert.equal(job.status,'unknown');
 const file=path.join(temp,'image-jobs',`${id}.json`);const saved=JSON.parse(await fs.readFile(file));saved.pid=2147483647;await fs.writeFile(file,JSON.stringify(saved));
 let called=0;
 await resumeImageJobs(async (_,callbacks)=>{called++;assert.deepEqual(callbacks.receipt,receipt);throw Object.assign(new Error('TEST_ONLY_STOP'),{uncertain:true});});
 for(let i=0;i<20;i++){job=await getImageJob(id,{waitMs:50});if(called&&job.status==='unknown')break;}
 assert.equal(called,1);assert.equal(job.run_id,receipt.runId);
});
after(async()=>{await fs.rm(temp,{recursive:true,force:true});});
