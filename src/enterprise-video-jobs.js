import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { readFrames, frameWarnings, frameSummary } from './video-frames.js';
import { submitEnterpriseVideo, inspectEnterpriseRun, recoverEnterpriseVideo,
  confirmEnterpriseVideoAsk, waitEnterpriseRun } from './enterprise-video-client.js';

const dir = path.join(config.dataDir, 'enterprise-video-jobs');
const active = new Map();
const framesDir = path.join(config.dataDir, 'enterprise-video-frames');
const terminalStatuses = ['completed', 'failed', 'cancelled'];
// Emits `<task id>` with the public job on every saved change.
export const jobEvents = new EventEmitter().setMaxListeners(0);
export const videoPhases = ['submitted', 'generating', 'awaiting_confirmation', 'extracting', 'validating', 'ready'];
function phaseOf(job) {
  if (job.status === 'submitting') return 'submitted';
  if (job.status === 'completed') return 'ready';
  if (job.status === 'waiting_input') return 'awaiting_confirmation';
  if (job.status === 'running') return job.phase || (job.conversationId ? 'generating' : 'submitted');
  return null;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const publicJob = job => ({
  id: job.id, provider: 'doubao-desktop', status: job.status, phase: phaseOf(job),
  conversation_id: job.conversationId || null, run_id: job.runId || null,
  requested_model: job.requestedModel, model_verification: 'requested_only',
  videos: job.videos || [], pending: (job.pending || []).filter(item => !item.clarifyId || !(job.confirmedIds || []).includes(item.clarifyId)),
  message: job.message || null, created_at: job.createdAt, updated_at: job.updatedAt,
  prompt: job.prompt || null, duration: job.options?.duration || null, ratio: job.options?.ratio || null,
  mode: job.options?.mode || 'text_to_video', frames: job.frames || [], warnings: job.warnings || [],
});
const fileFor = id => path.join(dir, `${id}.json`);

async function save(job) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  job.updatedAt = new Date().toISOString();
  const temp = `${fileFor(job.id)}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(job), { mode: 0o600 });
  await fs.rename(temp, fileFor(job.id));
  jobEvents.emit(job.id, publicJob(job));
}

async function load(id) {
  if (!/^(?:[0-9a-f-]{36}|[0-9a-f]{64})$/.test(String(id))) return null;
  try { return JSON.parse(await fs.readFile(fileFor(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function serialize(id, work) {
  const previous = active.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => withFileLock(id, work));
  active.set(id, next);
  next.finally(() => { if (active.get(id) === next) active.delete(id); }).catch(() => {});
  return next;
}

async function withFileLock(id, work) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = `${fileFor(id)}.lock`;
  const token = randomUUID();
  for (let tries = 0; tries < 3000; tries++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      try { return await work(); }
      finally {
        const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (owner?.token === token) await fs.rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => null);
      const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      let dead = false;
      if (owner?.pid) {
        try { process.kill(owner.pid, 0); }
        catch (check) { dead = check.code === 'ESRCH'; }
      }
      if (stat && (dead || !owner && Date.now() - stat.mtimeMs > 30_000)) {
        const stale = `${lock}.stale.${randomUUID()}`;
        await fs.rename(lock, stale).then(() => fs.rm(stale, { recursive: true, force: true })).catch(() => {});
      }
      await sleep(200);
    }
  }
  throw new Error('Video job is busy; retry with the same task ID');
}

export async function startEnterpriseVideoJob(body) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 20_000) throw new Error('prompt must be 1 to 20000 characters');
  const requestedModel = String(body.model || 'Seedance 2.0 Fast');
  const duration = Number(body.duration ?? body.seconds ?? 5);
  const ratio = String(body.ratio || body.aspect_ratio || '16:9');
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error('duration must be 1 to 15 seconds');
  if (!/^\d{1,2}:\d{1,2}$/.test(ratio)) throw new Error('ratio must be like 16:9');
  const mode = String(body.mode || 'text_to_video');
  const frames = await readFrames(mode, body);
  const options = { model: requestedModel, duration, ratio, ...(frames.length ? { mode } : {}) };
  // Text-only requests keep the original fingerprint so existing idempotency keys still match.
  const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, ...options,
    ...(frames.length ? { frames: frames.map(frame => [frame.role, frame.sha256]) } : {}) })).digest('hex');
  const key = body.idempotency_key ? String(body.idempotency_key) : '';
  if (key.length > 256) throw new Error('idempotency_key is too long');
  const id = key ? createHash('sha256').update(`doubao-desktop:${key}`).digest('hex') : randomUUID();
  return serialize(id, async () => {
    const existing = await load(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('idempotency_key is already used for a different request');
      return publicJob(existing);
    }
    const job = { id, fingerprint, prompt, requestedModel, options, autoConfirm: true, status: 'submitting',
      frames: frames.map(frameSummary), warnings: frameWarnings(frames, ratio),
      videos: [], pending: [], confirmedIds: [], confirmationAttemptedIds: [],
      initialWaitDone: false, createdAt: new Date().toISOString() };
    await save(job); // A crash after this point must never silently resend.
    try {
      // Upload private copies of the validated bytes, named by role, so the
      // source file cannot change between validation and upload.
      const attachments = [];
      if (frames.length) {
        const jobFrames = path.join(framesDir, id);
        await fs.mkdir(jobFrames, { recursive: true, mode: 0o700 });
        for (const frame of frames) {
          const file = path.join(jobFrames, `${frame.role}.${frame.ext}`);
          await fs.writeFile(file, frame.data, { mode: 0o600 });
          attachments.push(file);
        }
      }
      const receipt = await submitEnterpriseVideo(prompt, options, attachments);
      job.conversationId = receipt.conversationId;
      job.runId = receipt.runId;
      job.status = 'running';
    } catch (error) {
      job.conversationId = error.result?.conversationId || error.conversationId || null;
      job.runId = error.result?.runId || error.runId || null;
      job.status = 'unknown';
      job.message = job.runId ? '提交已被接受；请用会话和 run ID 恢复查询。' : '提交结果未确认；为避免重复生成，未自动重发。';
    }
    await save(job);
    if (watchable(job)) wakeEnterpriseVideoWatcher();
    return publicJob(job);
  });
}

export async function listEnterpriseVideoJobs() {
  let names;
  try { names = await fs.readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const jobs = await Promise.all(names.filter(name => /^(?:[0-9a-f-]{36}|[0-9a-f]{64})\.json$/.test(name))
    .map(name => load(name.slice(0, -5)).catch(() => null)));
  return jobs.filter(Boolean).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 100).map(job => ({
      task_id: job.id, status: job.status, prompt: job.prompt ? String(job.prompt).slice(0, 160) : null,
      duration: job.options?.duration || null, ratio: job.options?.ratio || null,
      created_at: job.createdAt || null, updated_at: job.updatedAt || null,
      videos: (job.videos || []).map(video => ({ id: video.id, width: video.width, height: video.height, duration: video.duration })),
    }));
}

const isActive = job => ['submitting', 'running'].includes(job.status);
const watchable = job => job.status === 'running' && job.conversationId && job.runId;

export async function getEnterpriseVideoJob(id, { waitMs = 0 } = {}) {
  // Reads local state only; the background watcher talks to Doubao.
  let job = await load(id);
  if (!job) return null;
  if (watchable(job)) wakeEnterpriseVideoWatcher();
  if (!waitMs || !isActive(job)) return publicJob(job);
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 540_000));
  while (isActive(job) && Date.now() < deadline) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); jobEvents.off(id, done); resolve(); };
      const timer = setTimeout(done, Math.min(5000, deadline - Date.now()));
      jobEvents.on(id, done);
    });
    job = await load(id);
  }
  return publicJob(job);
}

// Manual "query again": one immediate Doubao read, also for paused states.
export async function refreshEnterpriseVideoJob(id) {
  if (!await load(id)) return null;
  return serialize(id, async () => {
    const job = await load(id);
    if (job.conversationId && job.runId && !terminalStatuses.includes(job.status)) {
      job.readFailures = 0;
      await stepJob(job);
      if (watchable(job)) wakeEnterpriseVideoWatcher();
    }
    return publicJob(job);
  });
}

async function readFailed(job, message) {
  job.readFailures = (job.readFailures || 0) + 1;
  // Transient CDP blips keep the watcher going; repeated failures pause it.
  if (job.readFailures >= 3) { job.status = 'unknown'; job.message = message; }
  await save(job);
}

// One observation of Doubao for a job that has conversation/run IDs.
async function stepJob(job) {
  if (!job.initialWaitDone) {
    try {
      const first = await waitEnterpriseRun(job.conversationId, job.runId, 8000);
      job.initialWaitDone = ['waiting_input', 'completed', 'failed', 'cancelled'].includes(first.status);
    } catch (error) {
      if (error.code !== 'timeout') return readFailed(job, '无法确认任务状态；可用会话和 run ID 继续查询。');
    }
  }
  let state;
  try { state = await inspectEnterpriseRun(job.conversationId, job.runId); }
  catch { return readFailed(job, '暂时无法读取任务状态；请稍后按任务 ID 继续查询。'); }
  job.readFailures = 0;
  job.pending = state.pending.map(item => ({ kind: item.kind, messageId: item.messageId,
    blockId: item.blockId, clarifyId: item.clarifyId,
    questionIds: item.questions?.map(q => q.question_id) || [] }))
    .filter(item => !item.clarifyId || !job.confirmedIds.includes(item.clarifyId));
  if (state.status === 'completed') {
    job.status = 'running';
    try {
      const result = await recoverEnterpriseVideo(job.conversationId, job.runId, { state,
        expect: job.options?.duration ? { duration: job.options.duration, ratio: job.options.ratio } : null,
        onPhase: async phase => { job.phase = phase; await save(job); } });
      job.status = result.status;
      job.videos = result.videos.map(({ file, ...video }) => video);
      job.pending = [];
    } catch {
      job.status = state.videos.length ? 'extraction_failed' : 'video_missing';
      job.message = '任务已完成，但视频文件提取或校验失败。';
    }
    job.phase = null;
    return save(job);
  }
  if (['failed', 'cancelled'].includes(state.status)) {
    job.status = state.status;
    job.message = state.message?.slice(0, 300) || null;
    return save(job);
  }
  if (state.status === 'waiting_input') {
    job.phase = 'awaiting_confirmation';
    const attempted = job.confirmationAttemptedIds;
    const result = job.autoConfirm
      ? await confirmEnterpriseVideoAsk(job.conversationId, job.runId, job.options, attempted,
        async clarifyId => { attempted.push(clarifyId); await save(job); })
      : { confirmed: false };
    if (result.confirmed) {
      job.confirmedIds.push(result.clarifyId);
      job.pending = job.pending.filter(item => !job.confirmedIds.includes(item.clarifyId));
      job.status = job.pending.length ? 'waiting_input' : 'running';
    } else if (job.pending.some(item => !item.clarifyId || !job.confirmedIds.includes(item.clarifyId))) {
      job.status = job.pending.some(item => attempted.includes(item.clarifyId)) ? 'unknown' : 'waiting_input';
    } else job.status = 'running'; // Only the confirmed ask may remain stale.
    if (job.status === 'running') job.phase = 'generating';
  } else {
    job.status = state.status === 'unknown' ? 'unknown' : 'running';
    job.phase = 'generating';
  }
  return save(job);
}

let watcherTimer = null;
let watcherBusy = false;
let watcherWake = false;

async function watchTick() {
  watcherTimer = null;
  if (watcherBusy) { watcherWake = true; return; }
  watcherBusy = true;
  let next = 30_000;
  try {
    let names = [];
    try { names = await fs.readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const jobs = (await Promise.all(names.filter(name => /^(?:[0-9a-f-]{36}|[0-9a-f]{64})\.json$/.test(name))
      .map(name => load(name.slice(0, -5)).catch(() => null)))).filter(job => job && watchable(job));
    for (const candidate of jobs) {
      await serialize(candidate.id, async () => {
        const job = await load(candidate.id);
        if (job && watchable(job)) await stepJob(job);
      }).catch(() => {});
    }
    if (jobs.length) {
      const youngest = Math.min(...jobs.map(job => Date.now() - new Date(job.createdAt).getTime()));
      next = youngest < 60_000 ? 2000 : youngest < 300_000 ? 5000 : 10_000;
    }
  } catch { /* Keep watching; the next tick retries. */ }
  finally {
    watcherBusy = false;
    schedule(watcherWake ? 0 : next);
    watcherWake = false;
  }
}

function schedule(ms) {
  clearTimeout(watcherTimer);
  watcherTimer = setTimeout(watchTick, ms);
  watcherTimer.unref?.();
}

// Starts (or nudges) the background watcher that advances running jobs.
export function wakeEnterpriseVideoWatcher() {
  if (watcherBusy) { watcherWake = true; return; }
  schedule(0);
}

export async function recoverEnterpriseVideoJob(conversationId, runId) {
  if (!/^\d{12,24}$/.test(String(conversationId)) || !/^\d{12,24}$/.test(String(runId))) {
    throw new Error('Invalid conversation_id or run_id');
  }
  const id = createHash('sha256').update(`recover:${conversationId}:${runId}`).digest('hex');
  return serialize(id, async () => {
    let job = await load(id);
    if (!job) {
      job = { id, fingerprint: id, requestedModel: null, options: {}, autoConfirm: false, status: 'running',
        conversationId, runId, videos: [], pending: [], confirmedIds: [], confirmationAttemptedIds: [],
        initialWaitDone: true, createdAt: new Date().toISOString() };
      await save(job);
    }
    if (watchable(job)) wakeEnterpriseVideoWatcher();
    return publicJob(job);
  });
}
