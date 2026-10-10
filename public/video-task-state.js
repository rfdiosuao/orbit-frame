// Shared by the gateway and its clients. A temporary observation failure
// remains watchable while the existing Doubao run is being recovered.
export function followsVideoTask(job) {
  return Boolean(job && (['submitting', 'running'].includes(job.status) ||
    job.status === 'unknown' && (job.run_id || job.runId) &&
    ['connection_lost', 'cdp_timeout', 'login_required', 'status_unknown'].includes(job.error?.code)));
}

// Historical videos require explicit re-extraction before export.
export function isCloudVideo(video) {
  return Boolean(video && ['cloud_upload_original', 'cloud_attachment'].includes(video.source_kind) &&
    video.source_verification === 'matched_upload_path_and_size');
}
export const needsCloudExtraction = job => job?.status === 'completed' && job.delivery?.policy !== 'cloud_only';
