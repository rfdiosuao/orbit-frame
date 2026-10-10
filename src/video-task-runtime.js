import { classifyVideoError, videoDiagnostic } from './video-errors.js';

export const canWatchVideoJob = job => Boolean(!job.readOnlyRecovery && job.conversationId && job.runId &&
  (job.status === 'running' || job.status === 'waiting_input' && job.autoConfirm === true || job.status === 'unknown' &&
    ['connection_lost', 'cdp_timeout', 'login_required', 'status_unknown'].includes(job.error?.code)));

// Only an explicit refresh can reconsider this local reference rejection.
// It observes the immutable original run, with no confirmations, cancellation,
// generation or delivery messages. A completed MP4 never overrides a real
// reference failure. Preserve the rejected observation before changing state.
export async function reassessVideoReferenceFailure(job, { inspect, extraction, save, now = Date.now }) {
  if (!job.conversationId || !job.runId || !job.frames?.length ||
    !(job.status === 'failed' && job.error?.code === 'reference_unreadable' || job.readOnlyRecovery)) return false;
  if (extraction.has(job.id)) return true;
  const at = new Date(now()).toISOString();
  if (job.status === 'failed' && job.error?.code === 'reference_unreadable') {
    job.failureHistory ||= [];
    job.failureHistory.push({ observed_at: job.lastCheckedAt || job.updatedAt || at, preserved_at: at,
      status: job.status, error: { ...job.error }, reference_failure: job.reference_failure ? { ...job.reference_failure } : null,
      conversation_id: job.conversationId, run_id: job.runId,
      cancellation: job.cancellation ? { ...job.cancellation } : null });
  }
  job.recoveryHistory ||= [];
  const review = { requested_at: at, policy: 'read_only_original_run', outcome: 'observing' };
  job.recoveryHistory.push(review);
  await save(job);
  let state;
  try { state = await inspect(job.conversationId, job.runId, { fresh: true, deliveryRunId: null }); }
  catch (error) {
    review.outcome = 'observation_failed'; review.code = classifyVideoError(error);
    review.checked_at = new Date(now()).toISOString(); await save(job); return true;
  }
  review.checked_at = new Date(now()).toISOString(); review.upstream_status = state.status;
  job.lastCheckedAt = review.checked_at;
  if (state.reference_failure || state.status !== 'completed') {
    review.outcome = state.reference_failure ? 'reference_failure_still_present' : 'original_run_not_completed';
    if (state.reference_failure) {
      job.status = 'failed'; job.phase = null; job.reference_failure = state.reference_failure;
      job.error = videoDiagnostic('reference_unreadable', { submitted: true, retryable: false }); job.message = job.error.message;
    }
    await save(job); return true;
  }
  review.outcome = 'reference_rejection_cleared_extracting';
  job.readOnlyRecovery = true; job.reference_failure = null;
  job.status = 'running'; job.phase = 'extracting'; job.pending = [];
  job.error = null; job.message = '原任务已重新核验，正在提取已有云盘视频；不重新生成或补交。';
  await save(job);
  extraction.add(job.id, state);
  return true;
}

export function createExtractionQueue(run, { concurrency = 2, onError = () => {} } = {}) {
  const entries = new Map(), pending = [];
  let running = 0;
  const idleWaiters = [];
  const pump = () => {
    while (running < concurrency && pending.length) {
      const id = pending.shift(), state = entries.get(id);
      running++;
      Promise.resolve().then(() => run(id, state)).catch(error => onError(error, id)).finally(() => {
        entries.delete(id); running--; pump();
        if (!entries.size) idleWaiters.splice(0).forEach(resolve => resolve());
      });
    }
  };
  return {
    has: id => entries.has(id),
    add(id, state) {
      if (entries.has(id)) return;
      entries.set(id, state); pending.push(id); queueMicrotask(pump);
    },
    idle: () => entries.size ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(),
  };
}

export function createVideoTaskStepper({ inspect, confirm, extraction, save, cancel, now = Date.now }) {
  return async job => {
    if (extraction.has(job.id)) return;
    const began = new Date(job.monitorStartedAt || job.createdAt).getTime();
    if (Number.isFinite(began) && now() - began > 3600_000) {
      job.status = 'unknown'; job.error = videoDiagnostic('monitoring_expired', { submitted: true, retryable: true });
      job.message = job.error.message; return save(job);
    }
    job.confirmedIds ||= []; job.confirmationAttemptedIds ||= [];
    const started = now();
    let state;
    try { state = await inspect(job.conversationId, job.generationRunId || job.runId, { confirmationOptions: job.options, confirmedIds: job.confirmedIds, deliveryRunId: job.deliveryRunId || null }); }
    catch (error) {
      job.readFailures = (job.readFailures || 0) + 1;
      job.error = videoDiagnostic(classifyVideoError(error), { retryable: true, submitted: true });
      job.message = job.error.message;
      if (job.readFailures >= 3) job.status = 'unknown';
      job.nextPollAt = now() + Math.min(60_000, 2000 * 2 ** job.readFailures);
      return save(job);
    }
    job.timings ||= {}; job.timings.last_status_read_ms = Math.max(0, now() - started);
    job.lastCheckedAt = new Date(now()).toISOString();
    job.readFailures = 0; job.nextPollAt = null; job.error = null; job.message = null;
    if (job.frames?.length && state.reference_failure) {
      job.reference_failure = state.reference_failure;
      job.status = 'failed'; job.phase = null; job.pending = [];
      job.error = videoDiagnostic('reference_unreadable', { submitted: true, retryable: false });
      job.message = job.error.message;
      await save(job); // Reject delivery even if cancellation loses its ACK.
      if (cancel && !['completed', 'failed', 'cancelled'].includes(state.status)) {
        job.cancellation = { state: 'requested', accepted: false, confirmed: false, requested_at: new Date(now()).toISOString() };
        await save(job);
        try { Object.assign(job.cancellation, await cancel(job.conversationId, job.deliveryRunId || job.generationRunId || job.runId)); }
        catch { job.cancellation.state = 'unknown'; }
        await save(job);
      }
      return;
    }
    job.pending = (state.pending || []).map(item => ({ kind: item.kind, messageId: item.messageId,
      blockId: item.blockId, clarifyId: item.clarifyId, questionIds: item.questions?.map(q => q.question_id) || [] }))
      .filter(item => !item.clarifyId || !job.confirmedIds.includes(item.clarifyId));
    if (state.textConfirmation) { state.status = 'waiting_input'; job.pending.push({kind:'text_confirmation', clarifyId:state.textConfirmation.id, messageId:state.textConfirmation.messageId}); }
    if (state.status === 'completed') {
      job.status = 'running'; job.phase = 'extracting';
      await save(job);
      extraction.add(job.id, state); // Media work never holds up another task's CDP observation.
      return;
    }
    if (['failed', 'cancelled'].includes(state.status)) {
      job.status = state.status; job.phase = null;
      job.message = '豆包任务未完成，请在客户端查看本次会话。';
      return save(job);
    }
    if (state.status === 'waiting_input') {
      job.phase = 'awaiting_confirmation';
      let result;
      try {
        result = job.autoConfirm && !job.deliveryRunId ? await confirm(job.conversationId, job.generationRunId || job.runId, job.options,
          job.confirmationAttemptedIds, async id => { job.confirmationAttemptedIds.push(id); await save(job); },
          async receipt => { if (receipt.conversationId !== job.conversationId || !/^\d{12,24}$/.test(String(receipt.runId))) throw Error('Invalid confirmation receipt'); job.generationRunId = String(receipt.runId); await save(job); }) : { confirmed: false };
      } catch (error) {
        // An attempted mutation is never automatically repeated after a disconnect.
        job.status = 'unknown'; job.error = videoDiagnostic('confirmation_unknown', { submitted: true, retryable: false });
        job.message = job.error.message; return save(job);
      }
      if (result.confirmed) {
        if (result.runId) job.generationRunId = result.runId;
        job.confirmedIds.push(result.clarifyId);
        job.pending = job.pending.filter(item => !job.confirmedIds.includes(item.clarifyId));
        job.status = job.pending.length ? 'waiting_input' : 'running';
      } else if (job.pending.length) {
        job.status = job.pending.some(item => job.confirmationAttemptedIds.includes(item.clarifyId)) ? 'unknown' : 'waiting_input';
        if (job.status === 'unknown') { job.error = videoDiagnostic('confirmation_unknown', { submitted: true, retryable: false }); job.message = job.error.message; }
      } else job.status = 'running';
      if (job.status === 'running') job.phase = 'generating';
    } else {
      job.status = state.status === 'unknown' ? 'unknown' : 'running'; job.phase = 'generating';
      if (job.status === 'unknown') { job.error = videoDiagnostic('status_unknown', { submitted: true, retryable: true }); job.message = job.error.message; job.nextPollAt = now() + 30_000; }
    }
    if (job.deliveryRunId && job.status === 'running') {
      job.phase = 'extracting'; job.message = '正在将已生成视频补交云盘，不会重新生成。';
    }
    return save(job);
  };
}
