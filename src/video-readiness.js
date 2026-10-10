import { withApp, resolveApp } from 'doubao-cli/src/app.mjs';
import { cdpStatus, findChatTarget, CdpClient } from 'doubao-cli/src/cdp.mjs';
import { APP_MODULE_BOOTSTRAP } from 'doubao-cli/src/app-modules.mjs';
import { boundedCdp, classifyVideoError, videoDiagnostic, videoError } from './video-errors.js';

// Pure interpretation is shared by the live probe and compatibility tests.
export function interpretVideoReadiness(state) {
  if (!state.connected) return videoDiagnostic('client_unavailable', { ready: false });
  if (!state.hasSession) return videoDiagnostic('login_required', { ready: false });
  if (!state.chatReady) return videoDiagnostic('client_not_ready', { ready: false });
  if (!state.compatible) return videoDiagnostic('client_incompatible', { ready: false });
  return { ready: true, code: 'ready', message: '客户端已连接，可提交视频任务。', next_action: 'generate',
    auth_status: 'local_session_present', generation_permission: 'not_probed',model_verification:'requested_only',
    capabilities:{requested_models:['Seedance 2.0 Fast','Seedance 2.5'],modes:['text_to_video','image_to_video','first_last_frame'],duration_seconds:{'Seedance 2.0 Fast':[1,15],'Seedance 2.5':[4,30]},ratios:['16:9','9:16','1:1','4:3','3:4'],reference_support:'request_supported_permission_not_probed'} };
}

export function createReadinessProbe(probe, { ttlMs = 5000, now = Date.now } = {}) {
  let cached, inflight;
  return async ({ force = false } = {}) => {
    if (inflight) return inflight;
    if (!force && cached && now() - cached.at < ttlMs) return cached.value;
    inflight = Promise.resolve().then(probe).catch(error =>
      videoDiagnostic(classifyVideoError(error), { ready: false })).then(value => {
      const result = { ...value, checked_at: new Date(now()).toISOString() };
      cached = { at: now(), value: result }; return result;
    }).finally(() => { inflight = null; });
    return inflight;
  };
}

async function probe() {
  return withApp(resolveApp('doubao'), async () => {
    const status = await cdpStatus();
    if (!status.available) return interpretVideoReadiness({ connected: false });
    let client;
    try {
      const target = await findChatTarget(undefined, 1500);
      client = new CdpClient(target.webSocketDebuggerUrl);
      await boundedCdp(() => client.connect(), () => client.close(), 3000);
      const state = await boundedCdp(() => client.evaluate(`(async () => {
        const uid = localStorage.getItem('flow_tea_user_id');
        const state = { connected: true, hasSession: Boolean(uid && uid !== '0'),
          chatReady: Boolean(document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]')), compatible: false };
        if (window['@flow-web/desktop:stable']) {
          try {
            ${APP_MODULE_BOOTSTRAP}
            const req = await new Promise(resolve => window['@flow-web/desktop:stable'].push([['orbit_probe_' + crypto.randomUUID()], {}, resolve]));
            state.compatible = Boolean(appModule(req, 'stores'));
          } catch {}
        }
        return state;
      })()`), () => client.close(), 3000);
      return interpretVideoReadiness(state);
    } catch (error) {
      const code = /no Doubao chat page/i.test(error.message) ? 'client_not_ready' : classifyVideoError(error);
      return videoDiagnostic(code, { ready: false, ...(code === 'cdp_timeout' || code === 'connection_lost'
        ? { message: '豆包客户端检查失败或超时，尚未提交，请重新检查连接。' } : {}) });
    } finally { client?.close(); }
  });
}

export const getVideoReadiness = createReadinessProbe(probe);
export async function requireVideoReadiness() {
  const state = await getVideoReadiness({ force: true });
  if (!state.ready) throw videoError(state.code, { message: state.message, submitted: false, retryable: true, next_action: state.next_action });
  return state;
}
