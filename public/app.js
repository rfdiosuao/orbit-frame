import { setupApiExamples } from '/api-examples.js';
import { initPointerFX, runSplash } from '/heang/index.js';

const $ = id => document.getElementById(id);
const ACTIVE_KEY = 'orbit_frame_active_task';
const SAVED_KEY = 'doubao_local_api_key';
const terminal = new Set(['completed', 'failed', 'cancelled', 'video_missing']);
const paused = new Set(['waiting_input', 'unknown', 'extraction_failed', 'video_missing', 'failed', 'cancelled']);
const retryable = new Set(['waiting_input', 'unknown', 'extraction_failed']);
const statusText = {
  submitting: ['正在提交', '请求已发出，等待任务确认。'],
  running: ['画面正在路上', '视频正在生成；完成后会自动出现在这里。'],
  waiting_input: ['需要进一步确认', '任务等待输入，请查看任务信息并在豆包客户端处理。'],
  unknown: ['状态暂时无法确认', '请稍后重新查询这个任务；不会重复提交。'],
  extraction_failed: ['视频提取未完成', '任务已结束，但文件提取或校验失败。请重新查询。'],
  video_missing: ['未找到视频文件', '任务已结束，但未取得有效视频。'],
  failed: ['生成未完成', '此任务失败。可以查看任务信息后再决定是否重新创作。'],
  cancelled: ['任务已取消', '这个任务没有生成视频。'],
  completed: ['视频已完成', '现在可以预览和下载 MP4。'],
};
let apiKey = '';
let currentTask = null;
let currentBlobUrl = null;
let currentBlob = null;
let pollTimer = null;
let elapsedTimer = null;
let requestBusy = false;
let generationBusy = false;
let history = [];

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
function validVideo(video) { return video && /^[0-9a-f]{32,64}$/i.test(String(video.id || '')); }

async function api(path, options = {}) {
  if (!getKey()) throw new Error('请先到连接设置输入本地服务密钥。');
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${getKey()}`, ...options.headers } });
  const data = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) {
    const message = response.status === 401 ? '密钥无效。请在连接设置中检查。' : data?.error?.message || `请求失败（${response.status}）`;
    throw new Error(message);
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
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = null;
  currentBlob = null;
  $('downloadButton').disabled = true;
}
function setBadge(text) { $('previewBadge').textContent = text; }
function taskInfo(job) {
  $('taskDetails').hidden = false;
  $('taskIdText').textContent = `任务 ID：${job.task_id || ''}`;
  $('taskMessageText').textContent = job.message || '';
  $('retryButton').hidden = !retryable.has(job.status);
}
function startElapsed(job) {
  clearInterval(elapsedTimer);
  const draft = activeDraft();
  const began = job.created_at || (draft?.taskId === job.task_id ? draft.createdAt : null);
  const tick = () => { $('elapsedTime').textContent = `已等待 ${formatElapsed(secondsBetween(began))}`; };
  tick(); elapsedTimer = setInterval(tick, 1000);
}
function stopElapsed() { clearInterval(elapsedTimer); elapsedTimer = null; }
function schedulePoll(id) { clearTimeout(pollTimer); pollTimer = setTimeout(() => queryTask(id), 4200); }

async function loadVideo(video) {
  if (!validVideo(video)) throw new Error('任务没有可用的视频文件。');
  clearVideo();
  const response = await fetch(`/v1/videos/files/${encodeURIComponent(video.id)}`, { headers: { Authorization: `Bearer ${getKey()}` } });
  if (!response.ok) throw new Error(response.status === 401 ? '密钥无效。请重新连接。' : `视频文件读取失败（${response.status}）。`);
  const blob = await response.blob();
  if (!blob.size || !/^video\/mp4(?:;|$)/i.test(blob.type)) throw new Error('视频文件无效，请重新查询任务。');
  currentBlob = blob;
  currentBlobUrl = URL.createObjectURL(blob);
  $('videoPlayer').src = currentBlobUrl;
  showStage('video');
  $('downloadButton').disabled = false;
}
async function showTask(job, { poll = true } = {}) {
  currentTask = job;
  clearTimeout(pollTimer);
  const status = job.status || 'unknown';
  const [headline, description] = statusText[status] || ['正在确认状态', '可以稍后重新查询。'];
  $('previewLoading').classList.toggle('is-paused', paused.has(status) || status === 'completed');
  const draft = activeDraft();
  $('previewName').textContent = titleFor({ prompt: job.prompt || (draft?.taskId === job.task_id ? draft.prompt : ''), created_at: job.created_at || draft?.createdAt });
  const ownDraft = draft?.taskId === job.task_id ? draft : null;
  $('previewDetail').textContent = [job.duration || ownDraft?.duration ? `${job.duration || ownDraft.duration} 秒` : '', job.ratio || ownDraft?.ratio || '', 'MP4'].filter(Boolean).join(' · ');
  setBadge(headline);
  taskInfo(job);
  $('loadingTitle').textContent = headline;
  $('loadingDescription').textContent = description;
  if (status === 'completed' && Array.isArray(job.videos) && job.videos.some(validVideo)) {
    stopElapsed();
    try { await loadVideo(job.videos.find(validVideo)); setNotice('作品已完成，可以预览与下载。'); if (activeDraft()?.taskId === job.task_id) removeActive(); }
    catch (error) { showStage('loading'); $('loadingTitle').textContent = '视频读取失败'; $('loadingDescription').textContent = error.message; $('retryButton').hidden = false; setNotice(error.message, true); }
  } else {
    clearVideo(); showStage('loading'); startElapsed(job);
    if (status === 'completed') { $('loadingTitle').textContent = '未找到有效视频'; $('loadingDescription').textContent = '任务标记为完成，但没有可用的 MP4 文件。'; $('retryButton').hidden = true; }
    if (paused.has(status)) { stopElapsed(); setNotice(description, true); }
    else setNotice('任务已接收。页面刷新后仍可继续查看同一个任务。');
    if (terminal.has(status) && activeDraft()?.taskId === job.task_id) removeActive();
    if (poll && ['running', 'submitting'].includes(status)) schedulePoll(job.task_id);
  }
  generationBusy = false;
  $('generateButton').disabled = false;
  $('generateButton').innerHTML = '生成视频 <span aria-hidden="true">↗</span>';
}
async function queryTask(id, { manual = false } = {}) {
  if (requestBusy || !id) return;
  requestBusy = true;
  clearTimeout(pollTimer);
  if (manual) { $('retryButton').disabled = true; setNotice('正在查询原任务，不会重新提交。'); }
  try {
    const job = await api(`/v1/videos/tasks/${encodeURIComponent(id)}`);
    await showTask(job);
    await loadHistory();
  } catch (error) {
    clearTimeout(pollTimer);
    $('retryButton').hidden = false;
    $('taskDetails').hidden = false;
    $('loadingTitle').textContent = '查询暂时中断';
    $('loadingDescription').textContent = '任务仍可恢复。检查连接后重新查询。';
    $('previewLoading').classList.add('is-paused');
    showStage('loading'); stopElapsed(); setNotice(error.message, true);
  } finally { requestBusy = false; $('retryButton').disabled = false; }
}
async function submitVideo(event) {
  event.preventDefault();
  if (generationBusy || requestBusy) return;
  const prompt = $('videoPrompt').value.trim();
  const duration = Number($('videoDuration').value);
  const ratio = document.querySelector('input[name=ratio]:checked')?.value || '16:9';
  if (!prompt) { setNotice('请先写下想生成的画面。', true); $('videoPrompt').focus(); return; }
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) { setNotice('视频时长请输入 1 到 15 秒。', true); $('videoDuration').focus(); return; }
  if (!getKey()) { setNotice('请先在连接设置中输入本地服务密钥。', true); setView('settings'); $('apiKey').focus(); return; }
  let draft = activeDraft();
  if (draft && !draft.taskId && (draft.prompt !== prompt || draft.duration !== duration || draft.ratio !== ratio)) {
    setNotice('上一次提交结果未确认。请保持原提示词与设置重试同一次请求。', true);
    return;
  }
  if (draft?.taskId) { setNotice('已有任务需要先确认状态。正在查询原任务，不会重新提交。', true); await queryTask(draft.taskId, { manual: true }); return; }
  if (!draft || draft.taskId || draft.prompt !== prompt || draft.duration !== duration || draft.ratio !== ratio) {
    draft = { key: crypto.randomUUID(), prompt, duration, ratio, createdAt: new Date().toISOString(), taskId: null };
    saveActive(draft);
  }
  generationBusy = true; $('generateButton').disabled = true; $('generateButton').textContent = '正在提交…';
  $('previewLoading').classList.remove('is-paused');
  setNotice('正在提交；如连接中断，重试会沿用同一个请求。');
  clearVideo(); showStage('loading'); setBadge('正在提交'); $('loadingTitle').textContent = '正在提交'; $('loadingDescription').textContent = '等待服务确认任务。'; startElapsed({ created_at: draft.createdAt });
  try {
    const job = await api('/v1/videos/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'doubao-desktop', model: 'Seedance 2.0 Fast', duration, ratio, prompt, async: true, idempotency_key: draft.key }) });
    if (!job?.task_id) throw new Error('服务没有返回任务 ID。请使用相同设置重试。');
    draft.taskId = job.task_id; saveActive(draft);
    await showTask({ ...job, prompt, duration, ratio, created_at: draft.createdAt });
    await loadHistory();
  } catch (error) { generationBusy = false; $('generateButton').disabled = false; $('generateButton').innerHTML = '重试同一次提交 <span aria-hidden="true">↗</span>'; $('loadingTitle').textContent = '提交结果未确认'; $('loadingDescription').textContent = '可用同一提示词和设置重试；不会重新创建任务。'; $('previewLoading').classList.add('is-paused'); stopElapsed(); setNotice(error.message, true); }
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
async function loadHistory() {
  if (!getKey()) { $('libraryNotice').textContent = '输入本地服务密钥后可读取作品库。'; renderHistory(); return; }
  try { const data = await api('/v1/videos/tasks'); history = Array.isArray(data?.tasks) ? data.tasks : []; $('libraryNotice').textContent = ''; renderHistory(); }
  catch (error) { $('libraryNotice').textContent = error.message; }
}
async function serviceStatus() {
  try { const response = await fetch('/health', { cache: 'no-store' }); if (!response.ok) throw new Error('offline'); $('serviceStatus').classList.add('online'); $('serviceStatus').lastChild.textContent = ' 本地服务在线'; }
  catch { $('serviceStatus').classList.remove('online'); $('serviceStatus').lastChild.textContent = ' 本地服务未连接'; }
}
async function applyKey() {
  const candidate = $('apiKey').value.trim();
  $('saveKeyButton').disabled = true;
  $('keyNotice').textContent = '正在验证连接…';
  try {
    if (!candidate) throw new Error('请输入本地服务密钥。');
    const response = await fetch('/v1/videos/tasks', { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(10000) });
    if (response.status === 401) throw new Error('密钥无效，请检查本机 .env 的 LOCAL_API_KEY。');
    if (!response.ok) throw new Error(`网关暂时不可用（HTTP ${response.status}）。`);
    await response.json();
    apiKey = candidate;
    try { if ($('rememberKey').checked) localStorage.setItem(SAVED_KEY, apiKey); else localStorage.removeItem(SAVED_KEY); } catch {}
    $('keyNotice').textContent = '连接验证成功。可以生成视频和读取作品。';
    $('keyNotice').classList.remove('error');
    loadHistory(); const draft = activeDraft(); if (draft?.taskId) queryTask(draft.taskId, { manual: true });
  } catch (error) {
    apiKey = '';
    try { localStorage.removeItem(SAVED_KEY); } catch {}
    $('keyNotice').textContent = error.name === 'TimeoutError' ? '连接超时，请确认网关已启动。' : error.message;
    $('keyNotice').classList.add('error');
  } finally { $('saveKeyButton').disabled = false; }
}
async function generateImage(event) {
  event.preventDefault();
  if (!getKey()) { $('imageNotice').textContent = '请先在连接设置输入本地服务密钥。'; setView('settings'); return; }
  const prompt = $('imagePrompt').value.trim();
  if (!prompt) return;
  $('imageGenerateButton').disabled = true;
  $('imageNotice').textContent = '正在生成图像…';
  $('imageResults').replaceChildren();
  try {
    const data = await api('/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: $('imageModel').value, prompt, ratio: $('imageRatio').value, style: '默认', stream: false }) });
    const urls = Array.isArray(data?.data) ? data.data.map(item => item?.url).filter(url => typeof url === 'string') : [];
    for (const url of urls) { const image = document.createElement('img'); image.src = url; image.alt = prompt.slice(0, 100); image.loading = 'lazy'; $('imageResults').append(image); }
    $('imageNotice').textContent = urls.length ? `已生成 ${urls.length} 张图像。` : '服务没有返回图像，请稍后重试。';
  } catch (error) { $('imageNotice').textContent = error.message; }
  finally { $('imageGenerateButton').disabled = false; }
}
function setup() {
  try { const saved = localStorage.getItem(SAVED_KEY); if (saved) { apiKey = saved; $('apiKey').value = saved; $('rememberKey').checked = true; } } catch {}
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
  const adjust = delta => { $('videoDuration').value = String(Math.max(1, Math.min(15, Number($('videoDuration').value || 5) + delta))); };
  $('durationMinus').onclick = () => adjust(-1); $('durationPlus').onclick = () => adjust(1);
  $('saveKeyButton').onclick = applyKey;
  $('retryButton').onclick = () => queryTask(currentTask?.task_id || activeDraft()?.taskId, { manual: true });
  $('downloadButton').onclick = () => { if (!currentBlobUrl || !currentBlob) return; const a = document.createElement('a'); a.href = currentBlobUrl; a.download = `orbit-frame-${currentTask?.task_id?.slice(0, 8) || 'video'}.mp4`; document.body.append(a); a.click(); a.remove(); };
  const draft = activeDraft(); if (draft?.prompt) { $('videoPrompt').value = draft.prompt; $('videoPrompt').dispatchEvent(new Event('input')); $('videoDuration').value = draft.duration || 5; const ratio = document.querySelector(`input[name=ratio][value="${CSS.escape(draft.ratio || '16:9')}"]`); if (ratio) ratio.checked = true; }
  if (draft?.taskId && apiKey) queryTask(draft.taskId, { manual: true });
  else if (draft?.taskId) { setBadge('等待连接'); $('previewName').textContent = '有一个待恢复任务'; setNotice('请在连接设置中输入密钥，恢复同一个任务。'); }
  else if (draft) setNotice('有一次提交结果未确认。保持相同设置再次点击生成会沿用原请求。');
  serviceStatus(); setInterval(serviceStatus, 30000); loadHistory();
  setupApiExamples();
  initPointerFX(); runSplash({ minMs: 650 });
}
setup();
