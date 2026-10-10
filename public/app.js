import { videoDurationRange, validateVideoDuration } from '/video-models.js';
import { setupApiExamples } from '/api-examples.js';
import { setupAgentPrompt } from '/agent-prompt.js';
import { setupVideoFrames } from '/video-frames-ui.js';
import { followsVideoTask, isCloudVideo, needsCloudExtraction } from '/video-task-state.js';
import { initPointerFX, runSplash } from '/heang/index.js';

const $ = id => document.getElementById(id);
const ACTIVE_KEY = 'orbit_frame_active_task';
const SAVED_KEY = 'doubao_local_api_key';
let localConnection = null;
const terminal = new Set(['completed', 'failed', 'cancelled', 'video_missing']);
const paused = new Set(['waiting_input', 'unknown', 'extraction_failed', 'video_missing', 'failed', 'cancelled']);
const retryable = new Set(['waiting_input', 'unknown', 'extraction_failed', 'video_missing']);
const statusText = {
  submitting: ['正在提交', '请求已发出，等待任务确认。'],
  running: ['画面正在路上', '视频正在生成；完成后会自动出现在这里。'],
  waiting_input: ['需要进一步确认', '任务等待输入，请查看任务信息并在豆包客户端处理。'],
  unknown: ['状态暂时无法确认', '请稍后重新查询这个任务；不会重复提交。'],
  extraction_failed: ['视频提取未完成', '任务已结束，但文件提取或校验失败。请重新查询。'],
  video_missing: ['未找到视频文件', '任务已结束，但未取得有效视频。可以重新查询以再次提取。'],
  failed: ['生成未完成', '此任务失败。可以查看任务信息后再决定是否重新创作。'],
  cancelled: ['任务已取消', '这个任务没有生成视频。'],
  completed: ['视频已完成', '现在可以预览和下载 MP4。'],
};
let apiKey = '';
let currentTask = null;
let currentBlobUrl = null;
let pollTimer = null;
let elapsedTimer = null;
let requestBusy = false;
let queryFailures = 0;
let generationBusy = false;
let framePicker = null;
let history = [];
let historyCursor = null, historyBusy = false, historyRevision = 0;
let streamAbort = null;
let streamUnsupported = false;
let lastStatus = null;
const phaseText = {
  extracting: ['正在提取视频', '豆包已生成完成，正在下载 MP4。'],
  validating: ['正在校验文件', '正在检查 MP4 尺寸与时长，马上可以预览。'],
};
const phases = [
  ['submitted', '已提交'], ['generating', '豆包生成中'], ['awaiting_confirmation', '等待确认'],
  ['extracting', '提取视频'], ['validating', '文件校验'], ['ready', '可预览'],
];

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function saveActive(value) { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(value)); } catch {} }
function removeActive() { try { localStorage.removeItem(ACTIVE_KEY); } catch {} }
function getKey() { return apiKey || ''; }
function setNotice(message, error = false) { $('formNotice').textContent = message; $('formNotice').classList.toggle('error', error); }
function setView(view) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  document.querySelectorAll('.nav-link[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  if (view === 'library') loadHistory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function toDate(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function titleFor(item) { return item.prompt?.trim().slice(0, 33) || `视频作品 · ${toDate(item.created_at) || '未命名'}`; }
function statusLabel(status) { return statusText[status]?.[0] || '正在确认状态'; }
function secondsBetween(value) { const t = new Date(value).getTime(); return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 1000)) : 0; }
function formatElapsed(n) { const m = Math.floor(n / 60); return m ? `${m} 分 ${n % 60} 秒` : `${n} 秒`; }
function activeDraft() { return readJSON(ACTIVE_KEY); }
// `/?task=<id>` opens one task, e.g. from the MCP preview_url.
function linkedTask() { const id = new URLSearchParams(location.search).get('task') || ''; return /^(?:[0-9a-f-]{36}|[0-9a-f]{64})$/.test(id) ? id : ''; }
function validVideo(video) { return video && /^[0-9a-f]{32,64}$/i.test(String(video.id || '')); }

async function api(path, options = {}) {
  if (!getKey()) throw new Error('请先到连接设置输入本地服务密钥。');
  let response;
  try { response = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(path.includes('/generations') ? 180_000 : 15_000), headers: { Authorization: `Bearer ${getKey()}`, ...options.headers } }); }
  catch (error) { throw new Error(error.name === 'TimeoutError' ? '网关响应超时，请继续查询原任务。' : '网关连接暂时中断，请稍后重试。'); }
  const data = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) {
    const message = response.status === 401 ? '密钥无效。请在连接设置中检查。' : data?.error?.message || `请求失败（${response.status}）`;
    throw Object.assign(new Error(message), { status: response.status, diagnostic: data?.error });
  }
  return data;
}
function showStage(kind) {
  $('previewEmpty').hidden = kind !== 'empty';
  $('previewLoading').hidden = kind !== 'loading';
  $('videoPlayer').hidden = kind !== 'video';
}
function clearVideo() {
  $('videoPlayer').pause();
  $('videoPlayer').removeAttribute('src');
  $('videoPlayer').load();
  currentBlobUrl = null;
  $('downloadButton').disabled = true;
}
function setBadge(text) { $('previewBadge').textContent = text; }
function taskInfo(job) {
  $('taskDetails').hidden = false;
  $('taskIdText').textContent = `任务 ID：${job.task_id || ''}`;
  $('taskMessageText').textContent = [job.message, job.error?.code ? `诊断：${job.error.code}` : '',
    job.timings_ms?.submit_ms != null ? `提交耗时：${(job.timings_ms.submit_ms / 1000).toFixed(1)} 秒` : ''].filter(Boolean).join(' · ');
  $('retryButton').hidden = !retryable.has(job.status) && !needsCloudExtraction(job);
  if (job.status === 'unknown' && !job.run_id) $('retryButton').hidden = true;
  $('finishTrackingButton').hidden = !(job.status === 'unknown' && !job.run_id);
  $('retryButton').textContent = needsCloudExtraction(job) ? '重新提取云盘版本 ↗' : job.next_action === 'retry_extraction' ? '重新提取视频 ↗' : '继续查询原任务 ↗';
}
function startElapsed(job) {
  clearInterval(elapsedTimer);
  const draft = activeDraft();
  const began = job.created_at || (draft?.taskId === job.task_id ? draft.createdAt : null);
  const tick = () => { $('elapsedTime').textContent = `已等待 ${formatElapsed(secondsBetween(began))}`; };
  tick(); elapsedTimer = setInterval(tick, 1000);
}
function stopElapsed() { clearInterval(elapsedTimer); elapsedTimer = null; }
// Fast right after submit, slower while Doubao renders, slowest for long jobs.
function pollDelay(job) {
  const age = secondsBetween(job?.created_at || activeDraft()?.createdAt);
  return age < 20 ? 1500 : age < 180 ? 6000 : 12000;
}
function schedulePoll(job) { clearTimeout(pollTimer); pollTimer = setTimeout(() => queryTask(job.task_id), pollDelay(job)); }
function stopStream() { streamAbort?.abort(); streamAbort = null; }
// SSE over fetch so the key stays in the Authorization header, not the URL.
async function watchTask(job) {
  stopStream();
  const controller = new AbortController();
  streamAbort = controller;
  let watchdog;
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 45000); };
  arm();
  try {
    const response = await fetch(`/v1/videos/tasks/${encodeURIComponent(job.task_id)}/events`, { headers: { Authorization: `Bearer ${getKey()}` }, signal: controller.signal });
    if (!response.ok || !response.body) { streamUnsupported = response.status !== 401; throw new Error('stream unavailable'); }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (data && streamAbort === controller) await showTask(JSON.parse(data), { poll: false });
      }
    }
  } catch { /* Fall back to polling below. */ }
  finally { clearTimeout(watchdog); }
  if (streamAbort !== controller) return;
  streamAbort = null;
  if (followsVideoTask(currentTask) && currentTask.task_id === job.task_id) schedulePoll(currentTask);
}
function renderPhases(job) {
  const list = $('phaseSteps');
  const current = phases.findIndex(([key]) => key === job.phase);
  list.hidden = current < 0;
  list.replaceChildren(...phases.map(([key, label], index) => {
    const item = document.createElement('li');
    item.textContent = label;
    item.className = key === job.phase ? 'current' : job.observed_phases?.includes(key) ? 'done' : '';
    if (index === current) item.setAttribute('aria-current', 'step');
    return item;
  }));
}

async function loadVideo(video) {
  if (!validVideo(video)) throw new Error('任务没有可用的视频文件。');
  const source = `/v1/videos/files/${encodeURIComponent(video.id)}`;
  if (currentBlobUrl === source) return;
  clearVideo();
  // local-access has already established the HttpOnly media cookie. Native
  // playback requests ranges instead of buffering the entire MP4 in memory.
  currentBlobUrl = source;
  $('videoPlayer').preload = 'metadata';
  $('videoPlayer').src = source;
  showStage('video');
  $('downloadButton').disabled = false;
}
async function showTask(job, { poll = true } = {}) {
  currentTask = job;
  clearTimeout(pollTimer);
  const status = job.status || 'unknown';
  const [headline, description] = (status === 'running' && phaseText[job.phase]) || statusText[status] || ['正在确认状态', '可以稍后重新查询。'];
  $('previewLoading').classList.toggle('is-paused', paused.has(status) || status === 'completed');
  const draft = activeDraft();
  $('previewName').textContent = titleFor({ prompt: job.prompt || (draft?.taskId === job.task_id ? draft.prompt : ''), created_at: job.created_at || draft?.createdAt });
  const ownDraft = draft?.taskId === job.task_id ? draft : null;
  $('previewDetail').textContent = [job.duration || ownDraft?.duration ? `${job.duration || ownDraft.duration} 秒` : '', job.ratio || ownDraft?.ratio || '', 'MP4', isCloudVideo(job.videos?.[0]) ? '云盘上传版本' : ''].filter(Boolean).join(' · ');
  setBadge(headline);
  taskInfo(job);
  renderPhases(job);
  const changed = lastStatus !== status;
  lastStatus = status;
  if (changed && !['running', 'submitting'].includes(status)) loadHistory();
  $('loadingTitle').textContent = headline;
  $('loadingDescription').textContent = description;
  if (status === 'completed' && Array.isArray(job.videos) && job.videos.some(validVideo)) {
    stopElapsed();
    try { await loadVideo(job.videos.find(validVideo)); $('downloadButton').disabled = !isCloudVideo(job.videos.find(validVideo)); setNotice(isCloudVideo(job.videos.find(validVideo)) ? '云盘上传版本已完成，可以预览与下载。' : '这是旧版提取的文件。请点“重新提取云盘版本”，再下载。'); if (activeDraft()?.taskId === job.task_id) removeActive(); }
    catch (error) { showStage('loading'); $('loadingTitle').textContent = '视频读取失败'; $('loadingDescription').textContent = error.message; $('retryButton').hidden = false; setNotice(error.message, true); }
  } else {
    clearVideo(); showStage('loading'); startElapsed(job);
    if (status === 'completed') { $('loadingTitle').textContent = '未找到有效视频'; $('loadingDescription').textContent = '任务标记为完成，但没有可用的 MP4 文件。'; $('retryButton').hidden = true; }
    if (paused.has(status)) { if (!followsVideoTask(job)) stopElapsed(); $('loadingDescription').textContent = job.message || description; setNotice(job.message || description, true); }
    else setNotice('任务已接收。页面刷新后仍可继续查看同一个任务。');
    if (terminal.has(status) && activeDraft()?.taskId === job.task_id) removeActive();
    if (poll && followsVideoTask(job)) { if (streamUnsupported) schedulePoll(job); else watchTask(job); }
  }
  generationBusy = false;
  $('generateButton').disabled = false;
  $('generateButton').innerHTML = '生成视频 <span aria-hidden="true">↗</span>';
}
async function queryTask(id, { manual = false } = {}) {
  if (requestBusy || !id) return;
  requestBusy = true;
  clearTimeout(pollTimer);
  if (manual) { queryFailures = 0; stopStream(); $('retryButton').disabled = true; setNotice('正在查询原任务，不会重新提交。'); }
  try {
    // Only a manual retry of a paused task asks the gateway to re-read Doubao.
    const refresh = manual && currentTask?.task_id === id && (retryable.has(currentTask.status) || needsCloudExtraction(currentTask));
    const job = await api(`/v1/videos/tasks/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`);
    queryFailures = 0;
    await showTask(job, { poll: manual || !streamAbort });
  } catch (error) {
    clearTimeout(pollTimer);
    $('retryButton').hidden = false;
    $('taskDetails').hidden = false;
    $('loadingTitle').textContent = '查询暂时中断';
    $('loadingDescription').textContent = '任务仍可恢复。检查连接后重新查询。';
    $('previewLoading').classList.add('is-paused');
    showStage('loading'); stopElapsed(); setNotice(error.message, true);
    queryFailures++;
    if (currentTask?.task_id === id && followsVideoTask(currentTask) &&
        ![400, 401, 403, 404].includes(error.status) && queryFailures <= 6) {
      $('loadingDescription').textContent = '正在自动重连并查询原任务，不会重新提交生成。';
      pollTimer = setTimeout(() => queryTask(id), Math.min(12000, 1000 * 2 ** queryFailures));
    }
  } finally { requestBusy = false; $('retryButton').disabled = false; }
}
async function submitVideo(event) {
  event.preventDefault();
  if (generationBusy || requestBusy) return;
  const prompt = $('videoPrompt').value.trim();
  const duration = Number($('videoDuration').value);
  const model = $('videoModel').value;
  const ratio = document.querySelector('input[name=ratio]:checked')?.value || '16:9';
  if (!prompt) { setNotice('请先写下想生成的画面。', true); $('videoPrompt').focus(); return; }
  try { validateVideoDuration(model, duration); } catch { const { min, max } = videoDurationRange(model); setNotice(`视频时长请输入 ${min} 到 ${max} 秒。`, true); $('videoDuration').focus(); return; }
  if (!getKey()) await applyKey();
  if (generationBusy || requestBusy) return;
  if (!getKey()) { setNotice('自动连接失败，请在连接设置中重新连接。', true); setView('settings'); $('apiKey').focus(); return; }
  let draft = activeDraft();
  if (draft?.taskId) { setNotice('已有任务需要先确认状态。正在查询原任务，不会重新提交。', true); await queryTask(draft.taskId, { manual: true }); return; }
  let frames;
  try { frames = framePicker.request(); }
  catch (error) { setNotice(error.message, true); return; }
  const draftFrames = draft ? { mode: draft.mode || 'text_to_video', ...(draft.first_frame ? { first_frame: draft.first_frame } : {}), ...(draft.last_frame ? { last_frame: draft.last_frame } : {}) } : null;
  if (draft && !draft.taskId && (draft.prompt !== prompt || (draft.model || 'Seedance 2.0 Fast') !== model || draft.duration !== duration || draft.ratio !== ratio || JSON.stringify(draftFrames) !== JSON.stringify(frames))) {
    setNotice('上一次提交结果未确认。请保持原提示词与设置重试同一次请求。', true);
    return;
  }
  if (!draft || draft.taskId || draft.prompt !== prompt || (draft.model || 'Seedance 2.0 Fast') !== model || draft.duration !== duration || draft.ratio !== ratio) {
    draft = { key: crypto.randomUUID(), prompt, model, duration, ratio, ...frames, frameAssets: framePicker.assets(), createdAt: new Date().toISOString(), taskId: null };
    saveActive(draft);
  }
  generationBusy = true; $('generateButton').disabled = true; $('generateButton').textContent = '正在提交…';
  $('previewLoading').classList.remove('is-paused');
  setNotice('正在提交；如连接中断，重试会沿用同一个请求。');
  clearVideo(); showStage('loading'); setBadge('正在提交'); $('loadingTitle').textContent = '正在提交'; $('loadingDescription').textContent = '等待服务确认任务。'; startElapsed({ created_at: draft.createdAt });
  try {
    const job = await api('/v1/videos/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'doubao-desktop', model, duration, ratio, prompt, ...frames, async: true, idempotency_key: draft.key }) });
    if (!job?.task_id) throw new Error('服务没有返回任务 ID。请使用相同设置重试。');
    draft.taskId = job.task_id; saveActive(draft);
    await showTask({ ...job, prompt, duration, ratio, created_at: draft.createdAt });
    loadHistory();
  } catch (error) {
    generationBusy = false; $('generateButton').disabled = false;
    const notSubmitted = error.diagnostic?.submitted === false;
    if (notSubmitted) removeActive();
    setBadge(notSubmitted ? '尚未提交' : '需要确认');
    $('generateButton').innerHTML = notSubmitted ? '检查后生成视频 <span aria-hidden="true">↗</span>' : '重试同一次提交 <span aria-hidden="true">↗</span>';
    $('loadingTitle').textContent = notSubmitted ? '尚未提交到豆包' : '提交结果未确认';
    $('loadingDescription').textContent = notSubmitted ? error.message : '可用同一提示词和设置重试；不会重新创建任务。';
    $('previewLoading').classList.add('is-paused'); stopElapsed(); setNotice(error.message, true);
    void serviceStatus();
  }
}
function makeRecent(item) {
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'recent-item';
  const icon = document.createElement('span'); icon.className = 'recent-icon'; icon.textContent = item.status === 'completed' ? '▶' : '✦';
  const body = document.createElement('span'); const name = document.createElement('strong'); name.textContent = titleFor(item); const meta = document.createElement('small'); meta.textContent = [toDate(item.created_at), item.duration ? `${item.duration} 秒` : '', item.ratio || ''].filter(Boolean).join(' · '); body.append(name, meta);
  const status = document.createElement('em'); status.textContent = statusLabel(item.status);
  btn.append(icon, body, status); btn.onclick = () => openHistory(item); return btn;
}
async function openHistory(item) {
  setView('create');
  $('previewName').textContent = titleFor(item);
  $('previewDetail').textContent = [item.duration ? `${item.duration} 秒` : '', item.ratio || '', 'MP4'].filter(Boolean).join(' · ');
  clearVideo(); showStage('loading'); $('loadingTitle').textContent = '正在读取作品'; $('loadingDescription').textContent = '正在查询任务状态。';
  await queryTask(item.task_id, { manual: true });
}
function renderHistory() {
  const recent = $('recentList'); recent.replaceChildren();
  const grid = $('libraryGrid'); grid.replaceChildren();
  if (!history.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '还没有作品。写下第一个画面，开始创作吧。'; recent.append(empty); const card = document.createElement('div'); card.className = 'card settings-card'; card.innerHTML = '<h2>第一段画面，等你点亮 ✦</h2><p>完成的视频会自动出现在这里。</p>'; grid.append(card); return; }
  history.slice(0, 3).forEach(item => recent.append(makeRecent(item)));
  history.forEach(item => { const card = document.createElement('button'); card.type = 'button'; card.className = 'card library-item lift'; const thumb = document.createElement('div'); thumb.className = 'library-thumb'; const logo = document.createElement('img'); logo.src = '/orbit-frame.svg'; logo.alt = ''; thumb.append(logo); const info = document.createElement('div'); info.className = 'library-info'; const title = document.createElement('strong'); title.textContent = titleFor(item); const meta = document.createElement('p'); meta.textContent = [toDate(item.created_at), statusLabel(item.status), item.ratio || ''].filter(Boolean).join(' · '); info.append(title, meta); card.append(thumb, info); card.onclick = () => openHistory(item); grid.append(card); });
}
async function loadHistory(append = false) {
  if (append && (historyBusy || !historyCursor)) return;
  if (!getKey()) { $('libraryNotice').textContent = '输入本地服务密钥后可读取作品库。'; renderHistory(); return; }
  const revision = ++historyRevision; historyBusy = true; $('loadMoreHistory').disabled = true;
  try {
    const data = await api(`/v1/videos/tasks?limit=40${append ? `&before=${encodeURIComponent(historyCursor)}` : ''}`);
    if (revision !== historyRevision) return;
    const incoming = Array.isArray(data?.tasks) ? data.tasks : [];
    history = append ? [...new Map([...history, ...incoming].map(item => [item.task_id, item])).values()] : incoming;
    historyCursor = data.next_cursor || null; $('loadMoreHistory').hidden = !historyCursor;
    $('libraryNotice').textContent = ''; renderHistory();
  }
  catch (error) { $('libraryNotice').textContent = error.message; }
  finally { if (revision === historyRevision) { historyBusy = false; $('loadMoreHistory').disabled = false; } }
}
let readinessRequest = null;
async function serviceStatus(force = false) {
  if (readinessRequest) { if (!force) return readinessRequest; await readinessRequest; }
  readinessRequest = (async () => {
    let ready = false, message = '本地网关未连接，请启动网关。', label = ' 网关未连接';
    try {
      const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('offline');
      label = ' 网关在线 · 检查客户端'; message = '网关已启动，正在检查豆包客户端。';
      if (getKey()) {
        const state = await api(`/v1/videos/readiness${force ? '?refresh=1' : ''}`);
        ready = state.ready; message = state.message;
        label = ready ? ' 豆包客户端已连接' : state.code === 'login_required' ? ' 豆包需要登录' : ' 豆包暂不可用';
      }
    } catch (error) { if (getKey() && label.includes('在线')) { message = '客户端检查超时或失败，请重新检查连接。'; label = ' 客户端状态未确认'; } }
    $('serviceStatus').classList.toggle('online', ready);
    $('serviceStatus').lastChild.textContent = label; $('serviceStatus').title = message;
    $('videoConnectionBanner').hidden = ready;
    $('videoConnectionNotice').textContent = message;
  })();
  try { await readinessRequest; } finally { readinessRequest = null; }
}
async function applyKey() {
  if (localConnection) return localConnection;
  localConnection = (async () => {
    $('saveKeyButton').disabled = true;
    $('copyKeyButton').disabled = true;
    $('keyNotice').textContent = '正在自动连接本机网关…';
    try {
      const response = await fetch('/api/local-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('本机自动连接失败，请确认通过 localhost 或 127.0.0.1 打开网关。');
      const data = await response.json();
      if (!data.api_key) throw new Error('网关没有返回连接配置，请重启网关。');
      apiKey = data.api_key;
      void serviceStatus(true);
      void framePicker?.restorePreviews();
      setupAgentPrompt({ projectDir: data.project_dir, mediaDir: data.media_dir });
      await api('/v1/videos/tasks');
      $('apiKey').value = apiKey;
      $('copyKeyButton').disabled = false;
      $('keyNotice').textContent = '已自动连接，可以直接生成视频。';
      $('keyNotice').classList.remove('error');
      loadHistory(); const target = linkedTask() || activeDraft()?.taskId; if (target) queryTask(target, { manual: true });
      return true;
    } catch (error) {
      apiKey = ''; $('apiKey').value = '';
      $('keyNotice').textContent = error.name === 'TimeoutError' ? '连接超时，请确认网关已启动，然后重新连接。' : error.message;
      $('keyNotice').classList.add('error');
      return false;
    } finally { $('saveKeyButton').disabled = false; }
  })();
  try { return await localConnection; } finally { localConnection = null; }
}
async function generateImage(event) {
  event.preventDefault();
  if (!getKey()) await applyKey();
  if (!getKey()) { $('imageNotice').textContent = '自动连接失败，请重新连接。'; setView('settings'); return; }
  const prompt = $('imagePrompt').value.trim();
  if (!prompt) return;
  $('imageGenerateButton').disabled = true;
  $('imageNotice').textContent = '正在生成图像…';
  $('imageResults').replaceChildren();
  try {
    const model = $('imageModel').value, ratio = $('imageRatio').value;
    let urls;
    if (model === 'gpt-image-2.5') {
      const storageKey = 'orbit_frame_image_request';
      const previous = readJSON(storageKey);
      const reuse = previous?.prompt === prompt && previous?.model === model && previous?.ratio === ratio;
      const request = reuse ? previous : { id: crypto.randomUUID(), prompt, model, ratio };
      if (!reuse) localStorage.setItem(storageKey, JSON.stringify(request));
      let job = await api('/v1/images/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', prompt, model, ratio, idempotency_key: request.id }),
      });
      while (job.status === 'running') {
        $('imageNotice').textContent = 'gpt-image-2.5 正在生成图像…';
        job = await api(`/v1/images/jobs/${job.id}?wait_seconds=25`, { signal: AbortSignal.timeout(40_000) });
      }
      if (['completed', 'failed', 'cancelled'].includes(job.status)) localStorage.removeItem(storageKey);
      if (job.status !== 'completed') throw new Error(job.message || '生成结果暂未确认，再次点击会查询原任务。');
      urls = (job.images || []).map(image => image.preview_url).filter(Boolean);
    } else {
      const data = await api('/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt, ratio, style: '默认', stream: false }) });
      urls = Array.isArray(data?.data) ? data.data.map(item => item?.url).filter(url => typeof url === 'string') : [];
    }
    for (const url of urls) { const image = document.createElement('img'); image.src = url; image.alt = prompt.slice(0, 100); image.loading = 'lazy'; $('imageResults').append(image); }
    $('imageNotice').textContent = urls.length ? `已生成 ${urls.length} 张图像。` : '服务没有返回图像，请稍后重试。';
  } catch (error) { $('imageNotice').textContent = error.message; }
  finally { $('imageGenerateButton').disabled = false; }
}
function setup() {
  try { localStorage.removeItem(SAVED_KEY); } catch {}
  framePicker = setupVideoFrames({
    notice: setNotice,
    locked: () => generationBusy || !!activeDraft(),
    changed: () => { $('generateButton').disabled = generationBusy || !!framePicker?.isBusy(); },
    upload: async file => {
      if (!getKey()) await applyKey();
      if (!getKey()) throw new Error('自动连接失败，请在连接设置中重新连接。');
      if (generationBusy || activeDraft()) throw new Error('已有任务需要先确认状态。');
      return api('/v1/videos/frames', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    },
    preview: async url => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${getKey()}` } });
      if (!response.ok) throw new Error('图片预览暂时不可用');
      return response.blob();
    },
  });
  framePicker.restore(activeDraft());
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('seeAllButton').onclick = () => setView('library'); $('createForm').addEventListener('submit', submitVideo);
  $('imageForm').addEventListener('submit', generateImage);
  $('themeToggle').onclick = () => { const next = document.documentElement.dataset.mode === 'space' ? 'sky' : 'space'; document.documentElement.dataset.mode = next; localStorage.setItem('orbit_frame_theme', next); $('themeToggle').innerHTML = next === 'space' ? '☀ <span>天空</span>' : '☾ <span>深空</span>'; $('themeToggle').setAttribute('aria-label', next === 'space' ? '切换天空主题' : '切换深空主题'); };
  if (document.documentElement.dataset.mode === 'space') {
    $('themeToggle').innerHTML = '☀ <span>天空</span>';
    $('themeToggle').setAttribute('aria-label', '切换天空主题');
  }
  $('videoPrompt').addEventListener('input', () => { $('promptCount').textContent = `${$('videoPrompt').value.length} 字`; });
  document.querySelectorAll('.suggestion').forEach(button => button.onclick = () => { $('videoPrompt').value = button.dataset.prompt; $('videoPrompt').dispatchEvent(new Event('input')); $('videoPrompt').focus(); });
  const updateModel = () => { const { min, max } = videoDurationRange($('videoModel').value); $('videoDuration').min = min; $('videoDuration').max = max; $('videoDuration').value = String(Math.max(min, Math.min(max, Number($('videoDuration').value || 5)))); $('videoModelLabel').textContent = $('videoModel').value; };
  $('videoModel').onchange = updateModel;
  const adjust = delta => { const { min, max } = videoDurationRange($('videoModel').value); $('videoDuration').value = String(Math.max(min, Math.min(max, Number($('videoDuration').value || 5) + delta))); };
  $('durationMinus').onclick = () => adjust(-1); $('durationPlus').onclick = () => adjust(1);
  $('saveKeyButton').onclick = applyKey;
  $('checkVideoConnection').onclick = async () => {
    $('checkVideoConnection').disabled = true;
    try { await serviceStatus(true); } finally { $('checkVideoConnection').disabled = false; }
  };
  $('copyKeyButton').onclick = async () => {
    try { if (!getKey()) throw new Error('请先重新连接。'); await navigator.clipboard.writeText(getKey()); $('copyKeyNotice').textContent = 'API Key 已复制，可用于调用网关 API。'; }
    catch { $('copyKeyNotice').textContent = '复制失败，请重新连接后重试。'; }
  };
  $('retryButton').onclick = () => queryTask(currentTask?.task_id || activeDraft()?.taskId, { manual: true });
  $('finishTrackingButton').onclick = () => {
    if (!confirm('请先在豆包客户端核对这次请求。结束本页跟踪不会取消豆包生成，也不会删除原任务；随后再次生成可能产生另一条视频。确认已核对并结束跟踪？')) return;
    if (activeDraft()?.taskId === currentTask?.task_id) removeActive();
    stopStream(); clearTimeout(pollTimer); stopElapsed(); generationBusy = false;
    $('generateButton').disabled = false; $('generateButton').innerHTML = '生成视频 <span aria-hidden="true">↗</span>';
    $('finishTrackingButton').hidden = true; setNotice('已结束本页跟踪，原任务仍保留在作品库。');
  };
  $('downloadButton').onclick = () => { if (!currentBlobUrl) return; const a = document.createElement('a'); a.href = currentBlobUrl; a.download = `orbit-frame-${currentTask?.task_id?.slice(0, 8) || 'video'}.mp4`; document.body.append(a); a.click(); a.remove(); };
  $('loadMoreHistory').onclick = () => loadHistory(true);
  $('videoPlayer').addEventListener('error', () => {
    if (!currentBlobUrl) return;
    showStage('loading'); $('downloadButton').disabled = true;
    $('loadingTitle').textContent = '视频暂时无法播放';
    $('loadingDescription').textContent = '请重新连接本机网关，然后继续查询原任务。';
    $('retryButton').hidden = false; setNotice('视频文件加载失败，原任务和作品仍保留。', true);
    currentBlobUrl = null;
  });
  const draft = activeDraft(); if (draft?.prompt) { $('videoPrompt').value = draft.prompt; $('videoPrompt').dispatchEvent(new Event('input')); $('videoModel').value = draft.model || 'Seedance 2.0 Fast'; $('videoDuration').value = draft.duration || 5; const ratio = document.querySelector(`input[name=ratio][value="${CSS.escape(draft.ratio || '16:9')}"]`); if (ratio) ratio.checked = true; }
  updateModel();
  if (draft?.taskId && apiKey) queryTask(draft.taskId, { manual: true });
  else if (draft?.taskId) { setBadge('等待连接'); $('previewName').textContent = '有一个待恢复任务'; setNotice('请在连接设置中输入密钥，恢复同一个任务。'); }
  else if (draft) setNotice('有一次提交结果未确认。保持相同设置再次点击生成会沿用原请求。');
  applyKey(); serviceStatus(); setInterval(() => serviceStatus(), 15000);
  setupApiExamples();
  initPointerFX(); runSplash({ minMs: 650 });
}
setup();
