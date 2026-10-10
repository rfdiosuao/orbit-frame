import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { readFrames, frameWarnings, frameSummary } from './video-frames.js';
import { submitEnterpriseVideo, inspectEnterpriseRun, recoverEnterpriseVideo,
  confirmEnterpriseVideoAsk, requestEnterpriseCloudDelivery } from './enterprise-video-client.js';
import { requireVideoReadiness } from './video-readiness.js';
import { videoDiagnostic, videoError } from './video-errors.js';
import { canWatchVideoJob, createExtractionQueue, createVideoTaskStepper, reassessVideoReferenceFailure } from './video-task-runtime.js';
import { logger } from './logger.js';
import { createWatcherLease } from './video-watcher-lease.js';
import { selectCloudVideos } from './video-delivery.js';
import { continueCloudDeliveryOnce } from './video-cloud-continuation.js';
import { followsVideoTask } from '../public/video-task-state.js';
import { validateVideoDuration } from './video-models.js';
import { cancelEnterpriseRun } from './task-cancellation.js';
import { safeSubmissionError, persistOriginalVideoReceipt, videoSubmissionPolicy } from './video-submission.js';

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
const diagnosticFor = job => job.error || (job.status === 'unknown' && !job.runId
  ? videoDiagnostic('submit_unknown', { submitted: 'unknown', retryable: false }) : null);
const publicJob = job => ({
  id: job.id, provider: 'doubao-desktop', status: job.status, phase: phaseOf(job),
  conversation_id: job.conversationId || null, run_id: job.runId || null,
  requested_model: job.requestedModel, model_verification: 'requested_only',
  cancellation:job.cancellation || null,
  reference_failure:job.reference_failure || null,
  failure_history: job.failureHistory || [], recovery_history: job.recoveryHistory || [],
  submission_diagnostic: job.submissionDiagnostic || null, submission_receipt: job.submissionReceipt || null,
  delivery: job.delivery || null, videos: job.videos || [], pending: (job.pending || []).filter(item => !item.clarifyId || !(job.confirmedIds || []).includes(item.clarifyId)),
  message: job.message || null, created_at: job.createdAt, updated_at: job.updatedAt,
  prompt: job.prompt || null, duration: job.options?.duration || null, ratio: job.options?.ratio || null,
  mode: job.options?.mode || 'text_to_video', frames: job.frames || [], warnings: job.warnings || [],
  error: diagnosticFor(job), next_action: diagnosticFor(job)?.next_action || null,
  last_checked_at: job.lastCheckedAt || null, phase_started_at: job.phaseStartedAt || null,
  timings_ms: job.timings || {}, observed_phases: job.observedPhases || [],
});
const fileFor = id => path.join(dir, `${id}.json`);

async function save(job) {
  const previous = await load(job.id);
  const phase = phaseOf(job);
  job.observedPhases ||= [];
  if (phase && !job.observedPhases.includes(phase)) job.observedPhases.push(phase);
  const changed = !previous || JSON.stringify([previous.status, phaseOf(previous), previous.error, previous.pending, previous.videos, previous.message, previous.delivery]) !==
    JSON.stringify([job.status, phaseOf(job), job.error, job.pending, job.videos, job.message, job.delivery]);
  if (!previous || phaseOf(previous) !== phaseOf(job)) job.phaseStartedAt = new Date().toISOString();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  job.updatedAt = new Date().toISOString();
  const temp = `${fileFor(job.id)}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(job), { mode: 0o600 });
  await fs.rename(temp, fileFor(job.id));
  if (changed) jobEvents.emit(job.id, publicJob(job));
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
  const invalid = message => Object.assign(new Error(message), {invalid:true,submitted:false,httpStatus:400,code:'invalid_request'});
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 20_000) throw invalid('prompt must be 1 to 20000 characters');
  const requestedModel = String(body.model || 'Seedance 2.0 Fast');
  if (requestedModel.length > 100) throw invalid('model must be at most 100 characters');
  const duration = Number(body.duration ?? body.seconds ?? 5);
  const ratio = String(body.ratio || body.aspect_ratio || '16:9');
  try { validateVideoDuration(requestedModel, duration); } catch (error) { throw invalid(error.message); }
  if (!['16:9', '9:16', '1:1', '4:3', '3:4'].includes(ratio)) throw invalid('ratio must be 16:9, 9:16, 1:1, 4:3 or 3:4');
  const mode = String(body.mode || 'text_to_video');
  const frames = await readFrames(mode, body);
  const options = { model: requestedModel, duration, ratio, ...(frames.length ? { mode } : {}) };
  // Text-only requests keep the original fingerprint so existing idempotency keys still match.
  const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, ...options,
    ...(frames.length ? { frames: frames.map(frame => [frame.role, frame.sha256]) } : {}) })).digest('hex');
  const key = body.idempotency_key ? String(body.idempotency_key) : '';
  if (key.length > 256) throw invalid('idempotency_key is too long');
  const id = key ? createHash('sha256').update(`doubao-desktop:${key}`).digest('hex') : randomUUID();
  return serialize(id, async () => {
    const existing = await load(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw invalid('idempotency_key is already used for a different request');
      return publicJob(existing);
    }
    const job = { id, fingerprint, prompt, requestedModel, options, autoConfirm: true, status: 'submitting',
      frames: frames.map(frameSummary), warnings: frameWarnings(frames, ratio),
      videos: [], pending: [], confirmedIds: [], confirmationAttemptedIds: [],
      submissionStarted: false, initialWaitDone: false, createdAt: new Date().toISOString() };
    // Reject before persisting a task when it is certain no upstream send occurred.
    await requireVideoReadiness();
    const attachments = [];
    try {
      // Upload private copies of the validated bytes, named by role, so the
      // source file cannot change between validation and upload.
      if (frames.length) {
        const jobFrames = path.join(framesDir, id);
        await fs.mkdir(jobFrames, { recursive: true, mode: 0o700 });
        for (const frame of frames) {
          const file = path.join(jobFrames, `${frame.role}.${frame.ext}`);
          await fs.writeFile(file, frame.data, { mode: 0o600 });
          attachments.push(file);
        }
      }
      await save(job); // A crash after this point must never silently resend.
    } catch { throw videoError('local_storage_error', { submitted: false, retryable: true }); }
    const started = Date.now();
    // Persist the mutation boundary before sending. Legacy records without this
    // field stay uncertain; only an explicit false proves that nothing was sent.
    job.submissionStarted = true;
    try { await save(job); }
    catch { throw videoError('local_storage_error', { submitted: false, retryable: true }); }
    try {
      const receipt = await submitEnterpriseVideo(prompt, options, attachments, {
        onReceipt: receipt => persistOriginalVideoReceipt(job, receipt, save),
        onPhase: async phase => {
          job.submissionDiagnostic = { policy: videoSubmissionPolicy, phase, observed_at: new Date().toISOString(),
            task_id: job.id, prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
            frame_hashes: job.frames.map(f => ({ role: f.role, sha256: f.sha256 })) };
          await save(job);
        },
      });
      await persistOriginalVideoReceipt(job, receipt, save);
      job.status = 'running';
    } catch (error) {
      try { await persistOriginalVideoReceipt(job, error.receipt || error.result || error, save); } catch {}
      job.submissionDiagnostic = safeSubmissionError(error, job);
      const accepted = Boolean(job.conversationId && job.runId);
      job.status = accepted ? 'running' : job.submissionDiagnostic.submitted === false ? 'failed' : 'unknown';
      job.error = videoDiagnostic(accepted ? 'connection_lost' : 'submit_unknown',
        { submitted: job.submissionDiagnostic.submitted, retryable: false });
      job.message = job.error.message;
    }
    job.timings = { submit_ms: Date.now() - started };
    await save(job);
    if (watchable(job)) wakeEnterpriseVideoWatcher();
    return publicJob(job);
  });
}

let libraryCache = null;
export async function listEnterpriseVideoJobs({ limit = 100, before = '' } = {}) {
  let stamp;
  try { stamp = String((await fs.stat(dir, { bigint: true })).mtimeNs); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (libraryCache?.stamp !== stamp || Date.now() - libraryCache.at > 5000) {
    const names = await fs.readdir(dir);
    const jobs = await Promise.all(names.filter(name => /^(?:[0-9a-f-]{36}|[0-9a-f]{64})\.json$/.test(name))
      .map(name => load(name.slice(0, -5)).catch(() => null)));
    libraryCache = { stamp, at: Date.now(), jobs: jobs.filter(Boolean).sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.id.localeCompare(a.id)) };
  }
  const start = before ? libraryCache.jobs.findIndex(job => job.id === before) + 1 : 0;
  if (before && start === 0) return [];
  return libraryCache.jobs.slice(start, start + Math.max(1, Math.min(101, Number(limit) || 100))).map(job => ({
      task_id: job.id, status: job.status, prompt: job.prompt ? String(job.prompt).slice(0, 160) : null,
      duration: job.options?.duration || null, ratio: job.options?.ratio || null,
      created_at: job.createdAt || null, updated_at: job.updatedAt || null,
      delivery: job.delivery || null, videos: (job.videos || []).map(video => ({ id: video.id, width: video.width, height: video.height, duration: video.duration, source_kind: video.source_kind, source_verification: video.source_verification })),
    }));
}

const isActive = job => ['submitting', 'running'].includes(job.status);
const watchable = canWatchVideoJob;

export async function getEnterpriseVideoJob(id, { waitMs = 0 } = {}) {
  // Reads local state only; the background watcher talks to Doubao.
  let job = await load(id);
  if (!job) return null;
  // Status GETs cannot reset the watcher's polling backoff.
  if (watchable(job) && !watcherTimer && !watcherBusy) wakeEnterpriseVideoWatcher();
  if (!waitMs || !followsVideoTask(job)) return publicJob(job);
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 540_000));
  while (followsVideoTask(job) && Date.now() < deadline) {
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
  const current = await load(id);
  if (!current) return null;
  if (extraction.has(id)) return publicJob(current);
  return serialize(id, async () => {
    const job = await load(id);
    if (job && (job.status === 'failed' && job.error?.code === 'reference_unreadable' || job.readOnlyRecovery && !terminalStatuses.includes(job.status))) {
      await reassessVideoReferenceFailure(job, { inspect: inspectEnterpriseRun, extraction, save });
      return publicJob(job);
    }
    if (job.conversationId && job.runId && (!terminalStatuses.includes(job.status) || job.status === 'completed' && job.delivery?.policy !== 'cloud_only')) {
      job.readFailures = 0;
      job.nextPollAt = null;
      job.monitorStartedAt = new Date().toISOString();
      await stepJob(job);
      if (watchable(job)) wakeEnterpriseVideoWatcher();
    }
    return publicJob(job);
  });
}

export async function cancelEnterpriseVideoJob(id,{cancel=cancelEnterpriseRun}={}) {
  return serialize(id,async()=>{
    const job=await load(id);if(!job)return null;
    if(terminalStatuses.includes(job.status)) {job.cancellation={state:job.status==='completed'?'already_completed':job.status,accepted:false,confirmed:true};await save(job);return publicJob(job);}
    job.cancellation={state:'requested',accepted:false,confirmed:false,requested_at:new Date().toISOString()};await save(job);
    if(!job.conversationId || !job.runId) {job.cancellation.state='unknown';await save(job);return publicJob(job);}
    let result;try {result=await cancel(job.conversationId,job.deliveryRunId || job.runId);}catch {result={state:'unknown',accepted:false,confirmed:false};}
    job.cancellation={...job.cancellation,...result};
    if(result.confirmed && result.state==='cancelled') {job.status='cancelled';job.phase=null;job.pending=[];}
    await save(job);return publicJob(job);
  });
}

const extraction = createExtractionQueue(async (id, state) => {
  await serialize(id, async () => {
    const job = await load(id);
    if (!job || terminalStatuses.includes(job.status)) return;
    const started = Date.now();
    job.delivery = selectCloudVideos(state.videos).delivery;
    try {
      const result = await recoverEnterpriseVideo(job.conversationId, job.runId, { state,
        expect: job.options?.duration ? { duration: job.options.duration, ratio: job.options.ratio } : null,
        onPhase: async phase => { job.phase = phase; await save(job); } });
      if (await continueCloudDeliveryOnce(job, state, result, { request: requestEnterpriseCloudDelivery, save })) {
        // Reference reassessment itself was read-only. Once the existing file
        // has a persisted delivery-only run, monitor that run normally; it
        // cannot auto-confirm a new generation and the intent prevents resend.
        if (job.readOnlyRecovery && job.deliveryRunId) { job.readOnlyRecovery = false; await save(job); }
        if (watchable(job)) wakeEnterpriseVideoWatcher(); return;
      }
      job.status = result.status;
      job.videos = result.videos.map(({ file, ...video }) => video);
      job.pending = []; job.delivery = result.delivery; job.error = result.error || null; job.message = result.error?.message || null;
    } catch {
      job.status = state.videos?.length ? 'extraction_failed' : 'video_missing';
      job.error = videoDiagnostic('extraction_failed', { submitted: true, retryable: true });
      job.message = job.error.message;
    }
    job.timings ||= {}; job.timings.extract_and_validate_ms = Date.now() - started;
    job.phase = null; await save(job);
  });
}, { onError: (_error, id) => logger.error('video extraction worker failed', { task_id: id }) });

const stepJob = createVideoTaskStepper({ inspect: inspectEnterpriseRun, confirm: confirmEnterpriseVideoAsk, extraction, save, cancel: cancelEnterpriseRun });

let watcherTimer = null;
let watcherBusy = false;
let watcherWake = false;
const claimWatcher = createWatcherLease(dir);

async function watchTick() {
  watcherTimer = null;
  if (watcherBusy) { watcherWake = true; return; }
  watcherBusy = true;
  let next = 5000;
  try {
    if (!await claimWatcher()) return;
    let names = [];
    try { names = await fs.readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const jobs = (await Promise.all(names.filter(name => /^(?:[0-9a-f-]{36}|[0-9a-f]{64})\.json$/.test(name))
      .map(name => load(name.slice(0, -5)).catch(() => null)))).filter(Boolean);
    for (const candidate of jobs) {
      if (candidate.status === 'submitting' && !active.has(candidate.id)) {
        const lock = `${fileFor(candidate.id)}.lock`;
        const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        let alive = false;
        if (owner?.pid) { try { process.kill(owner.pid, 0); alive = true; } catch {} }
        if (!alive) await serialize(candidate.id, async () => {
          const job = await load(candidate.id);
          if (job?.status !== 'submitting') return;
          const unsent = job.submissionStarted === false;
          job.status = unsent ? 'failed' : 'unknown';
          job.error = videoDiagnostic(unsent ? 'local_storage_error' : 'submit_unknown', { submitted: unsent ? false : 'unknown', retryable: unsent });
          job.message = unsent ? '网关在提交前中断，此请求尚未发送；可重新准备生成。'
            : '网关在提交期间重启，结果未确认；请在豆包客户端核对，会保留原请求且不会自动重发。';
          await save(job);
        });
        continue;
      }
      if (!watchable(candidate) || extraction.has(candidate.id) || candidate.nextPollAt > Date.now()) continue;
      await serialize(candidate.id, async () => {
        const job = await load(candidate.id);
        if (job && watchable(job)) await stepJob(job);
      }).catch(() => logger.error('video watcher step failed', { task_id: candidate.id }));
    }
    const watching = jobs.filter(watchable);
    if (watching.length) {
      const youngest = Math.min(...watching.map(job => Date.now() - new Date(job.createdAt).getTime()));
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
