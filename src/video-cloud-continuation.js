import { videoDiagnostic } from './video-errors.js';

// Persist the delivery-only intent before a mutation. Even a lost ACK or
// process restart must never trigger a second cloud upload continuation.
export async function continueCloudDeliveryOnce(job, state, result, { request, save }) {
  const expectedDuration=Number(job.options?.duration);
  const [rw,rh]=String(job.options?.ratio||'').split(':').map(Number);
  // A completed native video card can prove that the original run produced a
  // clip, while still being ineligible for download. Request only its original
  // cloud/file delivery, once, after checking its identity and saved parameters.
  const completeCard=state.status==='completed' && expectedDuration>0 && rw>0 && rh>0 &&
    state.videos?.some(video=>video.kind==='creation' && /^\d{8,24}$/.test(String(video.creationId||'')) &&
      /^[a-zA-Z0-9_-]{8,100}$/.test(String(video.vid||'')) && video.width>0 && video.height>0 &&
      Math.abs(Number(video.duration)-expectedDuration)<=0.25 &&
      Math.abs((video.width/video.height)/(rw/rh)-1)<=0.05);
  if (result.status !== 'video_missing' || !(state.videos?.some(video => video.kind === 'file') || completeCard) || job.deliveryAttempted) return false;
  job.deliveryAttempted = true; job.phase = 'extracting'; await save(job);
  try {
    const receipt = await request(job.conversationId);
    if (receipt.conversationId !== job.conversationId || !/^\d{12,24}$/.test(String(receipt.runId))) throw new Error('Invalid delivery receipt');
    job.deliveryRunId = receipt.runId; job.status = 'running'; job.phase = 'extracting';
    job.monitorStartedAt = new Date().toISOString(); job.message = '正在将已生成视频补交云盘，不会重新生成。'; job.error = null;
  } catch {
    job.status = 'unknown'; job.phase = null;
    job.error = videoDiagnostic('delivery_unknown', { submitted: true, retryable: false }); job.message = job.error.message;
  }
  await save(job); return true;
}
