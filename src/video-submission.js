import { createHash } from 'node:crypto';

export const videoSubmissionPolicy = 'original_ack_checkpoint_v1';
const proof = Symbol('video_submission_boundary');
const phases = new Set(['queued', 'attachment_upload', 'attachment_encode', 'context_preparation', 'upstream_send', 'acknowledged', 'finished']);
const validId = value => /^\d{12,24}$/.test(String(value || ''));
const hash = value => createHash('sha256').update(String(value)).digest('hex');

export function safeSubmissionError(error, job, at = new Date().toISOString()) {
  const knownCodes = ['timeout', 'cdp_timeout', 'incomplete_stream', 'exception', 'receipt_conflict', 'receipt_persistence_failed', 'attachment_draft_present', 'attachment_cleanup_unscoped'];
  const knownNames = ['Error', 'TypeError', 'AbortError', 'TimeoutError'];
  const message = String(error?.message || '');
  const category = /attachments did not finish uploading within \d+ ms/.test(message) ? 'attachment_upload_timeout'
    : /composer already contains draft attachments/.test(message) ? 'attachment_draft_present'
    : /attachment drop target was not found/.test(message) ? 'attachment_target_missing'
    : /Cannot identify the staged attachments safely|Composer attachments changed|upload identifiers are not ready|could not encode every attachment/.test(message) ? 'attachment_identity_not_ready'
    : /CDP client is not connected|CDP is unavailable/.test(message) ? 'cdp_unavailable'
    : /did not identify the accepted turn|did not assign a conversation id/.test(message) ? 'ack_not_identified'
    : error?.code === 'receipt_conflict' ? 'receipt_conflict'
    : error?.code === 'receipt_persistence_failed' ? 'receipt_persistence_failed' : 'unclassified_submission_error';
  const boundary = error?.[proof];
  return { policy: videoSubmissionPolicy, code: knownCodes.includes(error?.code) ? error.code : 'unknown_error',
    name: knownNames.includes(error?.name) ? error.name : 'Error', category,
    phase: phases.has(boundary?.phase) ? boundary.phase : 'unknown',
    send_invoked: boundary ? boundary.sendInvoked : 'unknown',
    submitted: job.conversationId && job.runId ? true : boundary?.sendInvoked === false ? false : 'unknown',
    task_id: job.id, prompt_sha256: hash(job.prompt || ''),
    frame_hashes: (job.frames || []).map(f => ({ role: f.role, sha256: f.sha256 })), observed_at: at };
}

export async function persistOriginalVideoReceipt(job, receipt, save, at = new Date().toISOString()) {
  if (!validId(receipt?.conversationId) || !validId(receipt?.runId)) return false;
  const conversationId = String(receipt.conversationId), runId = String(receipt.runId);
  if ((job.conversationId && job.conversationId !== conversationId) || (job.runId && job.runId !== runId)) {
    throw Object.assign(new Error('Original receipt conflict'), { code: 'receipt_conflict' });
  }
  if (job.conversationId && job.runId) return true;
  job.conversationId = conversationId; job.runId = runId;
  job.submissionReceipt = { conversation_id: conversationId, run_id: runId, received_at: at, policy: videoSubmissionPolicy };
  try { await save(job); } catch {
    // Keep the first valid ACK in memory even if persistence fails. The outer
    // submission catch must never turn an accepted run back into ID-less unknown.
    throw Object.assign(new Error('Original receipt persistence failed'), { code: 'receipt_persistence_failed' });
  }
  return true;
}

// Dependencies are the installed SDK's public upload/context/protocol methods.
// One send at most; no retry. High-level createConversation currently hides
// onReceipt, so this adapter uses the same protocol with its public ACK hook.
export async function performVideoSubmission(instruction, attachments, hooks, operations) {
  let phase = 'queued', sendInvoked = false, firstReceipt, snapshot, files;
  let checkpoints = Promise.resolve(), checkpointFailure;
  const setPhase = async next => { phase = next; await hooks.onPhase?.(next); };
  const accept = receipt => {
    if (!validId(receipt?.conversationId) || !validId(receipt?.runId)) return checkpoints;
    const pair = { conversationId: String(receipt.conversationId), runId: String(receipt.runId) };
    if (firstReceipt && (firstReceipt.conversationId !== pair.conversationId || firstReceipt.runId !== pair.runId)) {
      checkpointFailure ||= Object.assign(new Error('Original receipt conflict'), { code: 'receipt_conflict' }); return checkpoints;
    }
    const first = !firstReceipt;
    if (first) { firstReceipt = pair; phase = 'acknowledged'; }
    checkpoints = checkpoints.then(async () => {
      // Job ACK comes first. SDK cache errors (including rejected Promises)
      // cannot erase it or escape as unhandled callback rejections.
      if (first) { await hooks.onReceipt?.(pair); await hooks.onPhase?.('acknowledged'); }
      try { await operations.storeReceipt?.(receipt); } catch {
        throw Object.assign(new Error('Original receipt persistence failed'), { code: 'receipt_persistence_failed' });
      }
    }).catch(error => { checkpointFailure ||= error; });
    return checkpoints;
  };
  try {
    if (attachments.length) {
      await setPhase('attachment_upload');
      files = await operations.upload(attachments);
      await setPhase('attachment_encode'); snapshot = await operations.encode(files);
    }
    await setPhase('context_preparation'); const context = await operations.context();
    await setPhase('upstream_send'); sendInvoked = true;
    let result;
    try { result = await operations.send(instruction, context, snapshot?.blocks, accept); }
    catch (error) { accept(error.receipt || error.result || error); throw error; }
    accept(result); await checkpoints;
    if (checkpointFailure) throw checkpointFailure;
    if (!firstReceipt) throw new Error('Doubao did not identify the accepted turn');
    await setPhase('finished');
    return { ...firstReceipt, status: result.status || 'running' };
  } catch (error) {
    await checkpoints;
    const failure = checkpointFailure || error;
    failure[proof] = { phase, sendInvoked };
    if (firstReceipt) failure.receipt = firstReceipt;
    throw failure;
  } finally {
    // Cleanup never hides an accepted run or causes a retry. Upload failure
    // cleanup is handled by the scoped upload adapter before encode exists.
    try {
      if (snapshot) await operations.cleanup(snapshot);
      else if (files) await operations.cleanupFiles?.(files);
    } catch {}
  }
}
