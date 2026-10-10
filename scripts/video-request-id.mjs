import { createHash } from 'node:crypto';

export const taskIdForKey = key => createHash('sha256').update(`doubao-desktop:${key}`).digest('hex');

export async function fetchGateway(url, options) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, options); }
    catch (error) {
      if (options.method !== 'GET' || options.signal?.aborted || attempt >= 5) throw error;
      await new Promise((resolve, reject) => {
        const signal = options.signal;
        const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(done, Math.min(2000, 500 * 2 ** attempt));
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}

// A lost HTTP response does not prove that the upstream mutation failed.
export function resumableVideoError(error, taskId) {
  if (error.diagnostic) return error;
  error.diagnostic = {
    code: 'gateway_response_unknown', message: '网关响应中断，任务编号已保留；请继续查询同一个任务并核对客户端。',
    submitted: 'unknown', retryable: false, task_id: taskId, next_action: 'query_same_task',
  };
  return error;
}
