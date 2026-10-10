// 轨映 infinite canvas: note / image / video cards on a pannable, zoomable
// surface. Image cards connect into a video card's first/last frame slots.
// The canvas stores only card layout and references (task_id, media path,
// image job id); generated media stays in the job and media stores.
import { videoModels, videoDurationRange } from '/video-models.js';
import { followsVideoTask, isCloudVideo, needsCloudExtraction } from '/video-task-state.js';
import { reusableFrameImage } from '/canvas-image-inputs.js';
import { videoPrompt, acceptsVideoInput } from '/canvas-video-inputs.js';
import {canvasRuntimeFields,runtimeFields,restoreHistoryCard} from '/canvas-history.js';
import {mergeCanvasDocuments} from '/canvas-sync.js';
const $ = id => document.getElementById(id);
const LAST_KEY = 'orbit_canvas_last';
const CLIP_KEY = 'orbit_canvas_clipboard';
const widths = { note: 240, image: 280, video: 340 };
const draftHeights = { note: 280, image: 400, video: 660 };
const minWidths = { note: 180, image: 200, video: 300 };
const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const imageModels = ['Seedream 5.0 Lite', 'Seedream 5.0', 'Seedream 4.5', 'Seedream 4.0'];
const active = new Set(['submitting', 'running']);
const retryable = new Set(['waiting_input', 'unknown', 'extraction_failed', 'video_missing']);
const videoPhaseText = { submitted: '正在提交', generating: '豆包生成中', awaiting_confirmation: '等待确认', extracting: '提取云盘文件', validating: '校验视频', ready: '可预览' };
const phases = [['submitted', '已提交'], ['generating', '生成中'], ['awaiting_confirmation', '等待确认'],
  ['extracting', '提取'], ['validating', '校验'], ['ready', '可预览']];
const statusText = {
  submitting: '正在提交', running: '生成中', waiting_input: '需要在豆包客户端确认', unknown: '状态暂时无法确认',
  extraction_failed: '视频提取未完成', video_missing: '未找到视频文件', failed: '生成未完成',
  cancelled: '任务已取消', completed: '视频已完成',
};
const frameLabels = { first_frame: '首帧', last_frame: '尾帧' };
const inputLabels = { ...frameLabels, prompt: '提示词' };
const modeLabels = { text_to_video: '文生视频', image_to_video: '图生视频', first_last_frame: '首尾帧' };
// Fields owned by generation, not by editing: undo never rolls them back.
const volatileKeys = canvasRuntimeFields;

let apiKey = '';
let externalImageModels=['gpt-image-2.5'];
let doc = null;
let serverDocument = null;
let canvasList = [];
const els = new Map();
const jobs = new Map();
const busyCards = new Set();      // video cards with a submission in flight
const imageWaits = new Map();     // image card id -> image job id being awaited
const imageSubmitting = new Set();
const selected = new Set();
let selectedEdge = null;
let saveTimer = null, saving = null, saveAgain = false;
let historyTimer = null, lastShape = '';
let undoStack = [], redoStack = [];
const archive = new Map();
let stream = null, streamIds = '';
let edgeFrame = 0, minimapFrame = 0, minimapMap = null;
let tempEdge = null;
let spaceDown = false, pinch = null;
let lastPointer = null;
let pasteCount = 0;
let lastCardPointerDown = -Infinity;
let frameSelection = null, framePickerToken = 0, directUpload = null;
const imagePhaseText = { submitting: '正在提交图片任务', generating: '豆包正在生成图片', downloading: '正在下载并校验图片' };
const frameLocked = card => !card || !!card.task_id || !!card.request_key || busyCards.has(card.id);
const imageName = card => card.asset?.name || card.prompt?.trim().slice(0, 24) || `图片 · ${card.id.slice(-4)}`;

// ---------- helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}
function choose(options, value, onchange, label) {
  const el = h('select', { 'aria-label': label, onchange: () => onchange(el.value) }, options.map(option => h('option', { value: option }, option)));
  el.value = value;
  return el;
}
const uid = () => 'c' + crypto.randomUUID().replaceAll('-', '').slice(0, 15);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let indexedCards=null,indexedCount=0,cardIndex=new Map();
const cardById = id => {
  if(!doc)return;
  if(indexedCards!==doc.cards || indexedCount!==doc.cards.length) {indexedCards=doc.cards;indexedCount=doc.cards.length;cardIndex=new Map(doc.cards.map(card=>[card.id,card]));}
  return cardIndex.get(id);
};
const edgeInto = (cardId, role) => doc.edges.find(edge => edge.to === cardId && edge.role === role);
const isEditable = el => el?.closest?.('input, textarea, select, [contenteditable]');
const cardWidth = card => card.w || widths[card.type];
const mod = event => event.metaKey || event.ctrlKey;

let toastTimer = null;
function toast(message, error = false) {
  const el = $('toast');
  el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3200);
}
function setSave(text, error = false) { $('saveState').textContent = text; $('saveState').classList.toggle('error', error); }

async function connect() {
  // Same-origin local access also sets the read-only media cookie for <img>/<video>.
  const response = await fetch('/api/local-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
  if (!response.ok) throw new Error('无法连接本机网关，请通过 127.0.0.1 或 localhost 打开画布。');
  apiKey = (await response.json()).api_key;
}
async function api(path, options = {}) {
  const json = typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {};
  const response = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(path.includes('/generations') ? 180_000 : 15_000), headers: { Authorization: `Bearer ${apiKey}`, ...json, ...options.headers } });
  const data = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) {
    throw Object.assign(new Error(data?.error?.message || `请求失败（${response.status}）`), { status: response.status, data });
  }
  return data;
}

// ---------- viewport ----------
function applyViewport() {
  const { x, y, zoom } = doc.viewport;
  $('world').style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  const viewport = $('viewport');
  viewport.style.backgroundSize = `${Math.max(6,24 * zoom)}px ${Math.max(6,24 * zoom)}px`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  $('zoomReset').textContent = `${Math.round(zoom * 100)}%`;
  queueEdges();
}
function toWorld(clientX, clientY) {
  const rect = $('viewport').getBoundingClientRect();
  const { x, y, zoom } = doc.viewport;
  return { x: (clientX - rect.left - x) / zoom, y: (clientY - rect.top - y) / zoom };
}
function zoomAt(clientX, clientY, factor) {
  const rect = $('viewport').getBoundingClientRect();
  const vp = doc.viewport;
  const next = Math.min(2.5, Math.max(0.02, vp.zoom * factor));
  const wx = (clientX - rect.left - vp.x) / vp.zoom, wy = (clientY - rect.top - vp.y) / vp.zoom;
  vp.x = clientX - rect.left - wx * next; vp.y = clientY - rect.top - wy * next; vp.zoom = next;
  applyViewport(); changed();
}
function zoomCenter(factor) {
  const rect = $('viewport').getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}
function cardRect(card) {
  return { x: card.x, y: card.y, w: cardWidth(card), h: els.get(card.id)?.offsetHeight || 240 };
}
function bounds(cards) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const card of cards) {
    const r = cardRect(card);
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  return { minX, minY, maxX, maxY };
}
function fitView(cards = doc.cards) {
  if (!cards.length) { doc.viewport = { x: 120, y: 60, zoom: 1 }; applyViewport(); changed(); return; }
  const { minX, minY, maxX, maxY } = bounds(cards);
  const rect = $('viewport').getBoundingClientRect();
  const padX = Math.min(200, rect.width * 0.2), padY = Math.min(140, rect.height * 0.15);
  const zoom = Math.min(1.2, Math.max(0.02, Math.min((rect.width - padX) / (maxX - minX), (rect.height - padY) / (maxY - minY))));
  doc.viewport = { zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom + padX / 5, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom };
  applyViewport(); changed();
}
function viewCenter() {
  const rect = $('viewport').getBoundingClientRect();
  return toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}
// Nearest spot to (x, y) where a w×h card does not overlap another card,
// preferring spots inside the visible area and to the right / below.
function freeSpot(x, y, w, h = 260) {
  const taken = doc.cards.map(cardRect);
  const clear = spot => !taken.some(r => spot.x < r.x + r.w + 24 && spot.x + w + 24 > r.x && spot.y < r.y + r.h + 24 && spot.y + h + 24 > r.y);
  const rect = $('viewport').getBoundingClientRect();
  const view = { ...toWorld(rect.left, rect.top), w: rect.width / doc.viewport.zoom, h: rect.height / doc.viewport.zoom };
  const visible = spot => spot.x >= view.x && spot.y >= view.y && spot.x + w <= view.x + view.w && spot.y + Math.min(h, 200) <= view.y + view.h;
  const candidates = [];
  for (let dx = -15; dx <= 15; dx++) {
    for (let dy = -15; dy <= 15; dy++) {
      const spot = { x: Math.round(x + dx * 80), y: Math.round(y + dy * 80) };
      candidates.push({ spot, score: Math.hypot(dx, dy) + (dx < 0 ? 0.4 : 0) + (dy < 0 ? 0.2 : 0) + (visible(spot) ? 0 : 50) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates.find(item => clear(item.spot))?.spot || { x: Math.round(x), y: Math.round(y) };
}
function spotNearCenter(type) {
  const center = viewCenter();
  return freeSpot(center.x - widths[type] / 2, center.y - draftHeights[type] / 2, widths[type], draftHeights[type]);
}

// ---------- edges ----------
function anchor(cardId, selector, side) {
  const el = els.get(cardId);
  if (!el) return null;
  const target = (selector && el.querySelector(selector)) || el;
  const rect = target.getBoundingClientRect();
  const x = target === el ? (side === 'right' ? rect.right : rect.left) : rect.left + rect.width / 2;
  const world = $('world').getBoundingClientRect();
  return { x: (x - world.left) / doc.viewport.zoom,
    y: (rect.top + Math.min(rect.height / 2, target === el ? 60 : rect.height / 2) - world.top) / doc.viewport.zoom };
}
function curve(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M${a.x} ${a.y} C${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
function drawEdges() {
  edgeFrame = 0;
  if (!doc) return;
  const svg = $('edges');
  const fragment=document.createDocumentFragment(),anchors=new Map();
  const point=(id,selector,side)=>{const key=[id,selector,side].join(':');if(!anchors.has(key))anchors.set(key,anchor(id,selector,side));return anchors.get(key);};
  const ns = 'http://www.w3.org/2000/svg';
  const path = (d, cls, edgeId) => {
    const el = document.createElementNS(ns, 'path'); el.setAttribute('d', d); if (cls) el.setAttribute('class', cls);
    if (edgeId) el.dataset.edge = edgeId;
    fragment.append(el);
  };
  for (const edge of doc.edges) {
    const a = edge.role === 'derived' ? point(edge.from, null, 'right') : point(edge.from, '.cv-port') || point(edge.from, null, 'right');
    const b = edge.role === 'derived' ? point(edge.to, null, 'left') : point(edge.to, `.cv-input-port[data-role="${edge.role}"]`) || point(edge.to, null, 'left');
    if (!a || !b) continue;
    const d = curve(a, b);
    path(d, 'cv-edge-hit', edge.id);
    path(d, [edge.role, edge.id === selectedEdge ? 'selected' : ''].join(' ').trim());
    if (inputLabels[edge.role]) {
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', (a.x + b.x) / 2); text.setAttribute('y', (a.y + b.y) / 2 - 6); text.setAttribute('text-anchor', 'middle');
      text.textContent = `${edge.role === 'prompt' ? '✎' : edge.role === 'first_frame' ? '①' : '②'} ${inputLabels[edge.role]} →`; text.setAttribute('class', edge.role); fragment.append(text);
    }
  }
  if (tempEdge) path(curve(tempEdge.a, tempEdge.b), 'temp');
  svg.replaceChildren(fragment);
}
function queueEdges() { if (!edgeFrame) edgeFrame = requestAnimationFrame(drawEdges); queueMinimap(); }
const resizeWatch = new ResizeObserver(() => queueEdges());
function selectEdge(id) {
  selectedEdge = id;
  if (id) setSelection([]);
  queueEdges();
}

// ---------- minimap ----------
function queueMinimap() { if (!minimapFrame) minimapFrame = requestAnimationFrame(drawMinimap); }
function drawMinimap() {
  minimapFrame = 0;
  const canvas = $('minimap');
  if (!doc || canvas.hidden) return;
  const W = 200, H = 130, dpr = devicePixelRatio || 1;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const rect = $('viewport').getBoundingClientRect();
  const view = { ...toWorld(rect.left, rect.top), w: rect.width / doc.viewport.zoom, h: rect.height / doc.viewport.zoom };
  const b = bounds(doc.cards);
  const minX = Math.min(b.minX, view.x) - 80, minY = Math.min(b.minY, view.y) - 80;
  const maxX = Math.max(b.maxX, view.x + view.w) + 80, maxY = Math.max(b.maxY, view.y + view.h) + 80;
  const scale = Math.min(W / (maxX - minX), H / (maxY - minY));
  const ox = (W - (maxX - minX) * scale) / 2, oy = (H - (maxY - minY) * scale) / 2;
  minimapMap = { minX, minY, scale, ox, oy };
  const style = getComputedStyle(document.documentElement);
  const colors = { note: style.getPropertyValue('--h-sun') || '#ffd23f', image: style.getPropertyValue('--h-pink') || '#ff93b4', video: style.getPropertyValue('--h-ha03') || '#5fd3f3' };
  for (const card of doc.cards) {
    const r = cardRect(card);
    ctx.fillStyle = colors[card.type];
    ctx.fillRect(ox + (r.x - minX) * scale, oy + (r.y - minY) * scale, Math.max(2, r.w * scale), Math.max(2, r.h * scale));
    if (selected.has(card.id)) { ctx.strokeStyle = style.getPropertyValue('--h-edge'); ctx.lineWidth = 1.5; ctx.strokeRect(ox + (r.x - minX) * scale, oy + (r.y - minY) * scale, r.w * scale, r.h * scale); }
  }
  ctx.strokeStyle = style.getPropertyValue('--h-edge') || '#0f2044'; ctx.lineWidth = 2;
  ctx.strokeRect(ox + (view.x - minX) * scale, oy + (view.y - minY) * scale, view.w * scale, view.h * scale);
}
function minimapJump(event) {
  if (!minimapMap) return;
  const box = $('minimap').getBoundingClientRect();
  const { minX, minY, scale, ox, oy } = minimapMap;
  const wx = (event.clientX - box.left - ox) / scale + minX, wy = (event.clientY - box.top - oy) / scale + minY;
  const rect = $('viewport').getBoundingClientRect();
  doc.viewport.x = rect.width / 2 - wx * doc.viewport.zoom; doc.viewport.y = rect.height / 2 - wy * doc.viewport.zoom;
  applyViewport(); changed();
}

// ---------- cards ----------
function place(card) { const el = els.get(card.id); if (el) el.style.transform = `translate(${card.x}px, ${card.y}px)`; }
function mountCard(card) {
  const el = h('article', { class: `cv-card cv-${card.type}`, dataset: { id: card.id } });
  el.style.width = `${cardWidth(card)}px`;
  els.set(card.id, el);
  $('cards').append(el);
  resizeWatch.observe(el);
  place(card); fillCard(card);
}
function remountAll() {
  for (const el of els.values()) resizeWatch.unobserve(el);
  els.clear(); $('cards').replaceChildren();
  doc.cards.forEach(mountCard);
  for (const id of [...selected]) if (!els.has(id)) selected.delete(id);
  for (const id of selected) els.get(id)?.classList.add('selected');
  queueEdges();
}
function head(card, kind, chip) {
  return h('header', { class: 'cv-card-head' },
    h('span', { class: 'cv-kind' }, kind),
    chip ? h('span', { class: `cv-chip ${chip[1] || ''}` }, chip[0]) : null,
    h('button', { class: 'cv-close', type: 'button', title: '从画布移除', 'aria-label': '从画布移除', onclick: () => removeCards([card.id]) }, '×'));
}
function fillCard(card) {
  const el = els.get(card.id);
  if (!el) return;
  el.classList.toggle('selected', selected.has(card.id));
  el.style.width = `${cardWidth(card)}px`;
  if (card.type === 'note') el.replaceChildren(head(card, '✎ 文字 / 提示词'), noteBody(card),
    h('span', { class: 'cv-port cv-prompt-port', title: '拖到视频卡片的提示词入口', role: 'button', 'aria-label': '连接文字到视频提示词' }, '✎'));
  else if (card.type === 'image') el.replaceChildren(...imageCard(card));
  else el.replaceChildren(...videoCard(card));
  el.append(h('span', { class: 'cv-resize', title: '拖动调整宽度', 'aria-hidden': 'true' }));
  queueEdges();
}
function noteBody(card) {
  return h('div', { class: 'cv-body' }, h('textarea', { value: card.text || '', maxLength: 20000, placeholder: '写视频提示词，再连接到视频卡片…', 'aria-label': '文字内容',
    oninput: event => { card.text = event.target.value; syncPromptInputs(); changed(); } }),
    h('p', { class: 'cv-muted' }, '文字连接到视频的 ✎ 提示词；图片连接到 ① 首帧 / ② 尾帧。'),
    h('button', { class: 'cv-ghost', type: 'button', onclick: () => {
      const video = addCard({ type: 'video', ...freeSpot(card.x + cardWidth(card) + 90, card.y, widths.video, draftHeights.video), prompt: '', duration: 5, ratio: '16:9', error: '' });
      addEdge(card.id, video.id, 'prompt'); fitView([card, video]);
    } }, '用这段文字创建视频'));
}

const noteName = card => card.text?.trim().slice(0, 28) || `空白文字 · ${card.id.slice(-4)}`;
function promptOptions(card) {
  return [h('option', { value: '' }, '直接在下方输入'), ...doc.cards.filter(source => source.type === 'note').map(source =>
    h('option', { value: source.id }, `文字：${noteName(source)}`))];
}
function syncPromptInputs() {
  for (const card of doc.cards.filter(card => card.type === 'video' && !frameLocked(card))) {
    const el = els.get(card.id), edge = edgeInto(card.id, 'prompt');
    const select = el?.querySelector('[aria-label="提示词来源"]');
    if (select) { select.replaceChildren(...promptOptions(card)); select.value = edge?.from || ''; }
    const textarea = el?.querySelector('[aria-label="视频提示词"]');
    if (textarea && edge) textarea.value = videoPrompt(card, doc.cards, doc.edges);
  }
}
function editPromptSource(card) {
  const source = cardById(edgeInto(card.id, 'prompt')?.from);
  if (!source) { els.get(card.id)?.querySelector('[aria-label="提示词来源"]')?.focus(); return; }
  fitView([source, card]); setSelection([source.id]);
  requestAnimationFrame(() => els.get(source.id)?.querySelector('textarea')?.focus());
}
function promptBody(card, locked) {
  const edge = edgeInto(card.id, 'prompt');
  const select = h('select', { 'aria-label': '提示词来源', disabled: locked, onchange: () => {
    if (select.value) addEdge(select.value, card.id, 'prompt');
    else if (edge) unlink(edge.id);
  } }, promptOptions(card));
  select.value = edge?.from || '';
  return h('section', { class: 'cv-prompt-slot', dataset: { role: 'prompt', card: card.id } },
    h('label', { class: 'cv-prompt-label' }, '✎ 提示词', select),
    h('p', { class: 'cv-muted' }, edge ? (locked ? '本次提交的提示词已保存，不随文字卡修改。' : '已连接文字卡，下方是实际使用的提示词。') : '可直接输入，或在上方选择文字卡；也可拖入文字连线。'),
    h('textarea', { value: videoPrompt(card, doc.cards, doc.edges), readOnly: !!edge, disabled: locked, maxLength: 20000,
      placeholder: '描述动作、镜头或首尾帧之间如何过渡…', 'aria-label': '视频提示词',
      oninput: event => { card.prompt = event.target.value; changed(); } }),
    edge && !locked ? h('button', { class: 'cv-ghost', type: 'button', onclick: () => editPromptSource(card) }, '编辑文字卡') : null);
}

function imageCard(card) {
  const generating = card.status === 'generating';
  const uncertain = card.status === 'unknown';
  const chip = generating ? [imagePhaseText[card.image_phase] || '提交中', 'busy'] : card.status === 'failed' ? ['失败', 'bad'] : card.status === 'ready' ? [card.asset ? `${card.asset.width}×${card.asset.height}` : '就绪'] : null;
  const body = h('div', { class: 'cv-body' });
  if (card.status === 'ready' && card.asset) {
    body.append(h('figure', { class: 'cv-figure', title: '双击查看大图' }, h('img', { src: card.asset.preview_url, alt: card.prompt?.slice(0, 80) || '画布图片', loading: 'lazy', draggable: false })));
    if (card.asset.name || !card.prompt) body.append(h('p', { class: 'cv-frame-caption' }, imageName(card)));
    if (card.assets?.length > 1) body.append(choose(card.assets.map((_, i) => `结果 ${i + 1}`), `结果 ${Math.max(0, card.assets.findIndex(a => a.path === card.asset.path)) + 1}`, value => { card.asset = card.assets[Number(value.split(' ')[1]) - 1]; fillCard(card); syncImageConnections(card); changed(); }, '图片生成结果'));
    if (card.prompt) body.append(h('p', { class: 'cv-prompt-view', title: card.prompt }, card.prompt));
    body.append(h('div', { class: 'cv-actions-row' },
      h('button', { class: 'cv-go', type: 'button', onclick: () => videoFromImage(card) }, '▶ 生成视频'),
      h('button', { class: 'cv-ghost', type: 'button', onclick: () => openDirectUpload(card) }, '替换图片'),
      card.prompt ? h('button', { class: 'cv-ghost', type: 'button', onclick: () => anotherImage(card, false) }, '同提示词再生成') : null,
      h('button', { class: 'cv-ghost', type: 'button', onclick: () => anotherImage(card, true) }, '参考原图衍生')));
    const port = h('span', { class: 'cv-port', title: '拖到视频卡片的首帧或尾帧', role: 'button', 'aria-label': '连接到视频' }, '→');
    return [head(card, '✦ 图片卡', chip), body, port];
  }
  if (generating) {
    body.append(h('div', { class: 'cv-wait' }, h('span', { class: 'cv-spin' }), imagePhaseText[card.image_phase] || '正在提交图片任务', h('small', { class: 'cv-image-elapsed', dataset: { started: card.image_started_at || new Date().toISOString() } }, '正在等待真实结果'), h('small', null, '按实际阶段显示；刷新后继续查询原任务')),
      card.prompt ? h('p', { class: 'cv-prompt-view' }, card.prompt) : null,
      h('button',{class:'cv-ghost',type:'button',onclick:()=>cancelCanvasTask(card,'image')},'取消图片任务'));
    return [head(card, '✦ 图片卡', chip), body];
  }
  if (uncertain) {
    body.append(h('p', { class: 'cv-error' }, card.error || '图片任务状态不明，先查询原任务。'), h('button', { class: 'cv-ghost', type: 'button', onclick: () => waitImageJob(card, { refresh: true }) }, '继续查询原图片任务'));
    return [head(card, '✦ 图片卡', ['待确认', 'bad']), body];
  }
  body.append(
    h('p', { class: 'cv-muted' }, '填写提示词后，在这张卡片内生成。也可以直接上传图片。'),
    h('button', { class: 'cv-ghost', type: 'button', onclick: () => openDirectUpload(card) }, '上传图片到这张卡'),
    ...(card.reference_images?.length ? [h('p',{class:'cv-muted'},`参考原图编辑 · ${card.reference_images.length} 张原图已绑定`)] : []),
    h('textarea', { value: card.prompt || '', placeholder: '描述想要的图片，例如：清晨海边的金色小狐狸，梦幻动画风格', 'aria-label': '图片提示词',maxLength:4000,
      oninput: event => { card.prompt = event.target.value; changed(); } }),
    h('div', { class: 'cv-row' },
      choose(['doubao-desktop','openai-compatible'],card.provider || 'doubao-desktop',value=>{card.provider=value;card.model=value==='openai-compatible'?(externalImageModels[0] || 'gpt-image-2.5'):'Seedream 4.5';fillCard(card);changed();},'生图服务'),
      choose(card.provider==='openai-compatible'?externalImageModels:imageModels, card.model || 'Seedream 4.5', value => { card.model = value; changed(); }, '图片模型'),
      choose(ratios, card.ratio || '1:1', value => { card.ratio = value; changed(); }, '图片比例')),
    ...(card.status === 'failed' && card.error ? [h('p', { class: 'cv-error' }, card.error)] : []),
    h('button', { class: 'cv-go', type: 'button', onclick: () => generateImage(card) }, card.status === 'failed' ? '重新生成图片' : '✦ 生成图片'));
  return [head(card, '✦ 图片卡', chip), body];
}

function videoMode(card) {
  const first = edgeInto(card.id, 'first_frame'), last = edgeInto(card.id, 'last_frame');
  return last ? 'first_last_frame' : first ? 'image_to_video' : 'text_to_video';
}
function framePorts(card) {
  return ['first_frame', 'last_frame', 'prompt'].map(role => h('button', { class: `cv-input-port cv-${role}`, type: 'button', dataset: { role, card: card.id },
    title: role === 'prompt' ? '提示词输入：拖入文字连线，或在卡片里选择文字' : `${frameLabels[role]}输入：拖入图片，或点击选择`, 'aria-label': `${inputLabels[role]}连接入口`, disabled: frameLocked(card),
    onclick: () => role === 'prompt' ? editPromptSource(card) : openFramePicker(card, role) }, role === 'prompt' ? '✎' : role === 'first_frame' ? '①' : '②'));
}

function firstAndLast(card) { return edgeInto(card.id, 'first_frame') && edgeInto(card.id, 'last_frame'); }
function swapFrames(card) {
  if (frameLocked(card) || !firstAndLast(card)) return;
  const first = edgeInto(card.id, 'first_frame'), last = edgeInto(card.id, 'last_frame');
  first.role = 'last_frame'; last.role = 'first_frame';
  fillCard(card); changed('now'); toast('已交换首帧和尾帧。');
}
function closeFramePicker() {
  frameSelection = null; framePickerToken++; $('framePicker').close();
}
function applyPickedFrame(image) {
  const selection = frameSelection;
  if (!selection || selection.owner !== doc) return;
  const target = cardById(selection.cardId);
  if (frameLocked(target)) { closeFramePicker(); return; }
  addEdge(image.id, target.id, selection.role);
  closeFramePicker(); setSelection([target.id]);
  toast(`已设置${frameLabels[selection.role]}；连线和生成方式已同步。`);
}
async function renderFramePicker(tab = 'canvas') {
  const selection = frameSelection, token = ++framePickerToken;
  if (!selection) return;
  const tabs = [['canvas', '画布图片'], ['generated', '生成的图片'], ['uploads', '上传的图片']];
  $('framePickerTabs').replaceChildren(...tabs.map(([key, label]) => h('button', { type: 'button', class: tab === key ? 'active' : '', onclick: () => renderFramePicker(key) }, label)));
  const list = $('framePickerList'); list.replaceChildren(h('p', { class: 'cv-muted' }, '正在读取图片…'));
  try {
    const images = tab === 'canvas' ? doc.cards.filter(card => card.type === 'image' && card.asset && card.status === 'ready')
      : ((await api(`/v1/media?dir=${tab}&limit=80`)).images || []).map(asset => ({ asset, external: true }));
    if (token !== framePickerToken || selection !== frameSelection) return;
    if (!images.length) { list.replaceChildren(h('p', { class: 'cv-muted' }, '暂无可用图片。可以上传图片，或切换到素材库。')); return; }
    const current = edgeInto(selection.cardId, selection.role)?.from;
    list.replaceChildren(...images.map(image => h('button', { class: `cv-frame-option${image.id && image.id === current ? ' chosen' : ''}`, type: 'button',
      onclick: () => {
        if (frameSelection !== selection || selection.owner !== doc || frameLocked(cardById(selection.cardId))) return;
        let source = image;
        if (image.external) {
          source = doc.cards.find(card => card.type === 'image' && card.asset?.path === image.asset.path);
          if (!source) { const target = cardById(selection.cardId); source = addAsset({ kind: 'image', ...image.asset }, { x: target.x - widths.image - 90, y: target.y + (selection.role === 'last_frame' ? 340 : 0) }); }
        }
        applyPickedFrame(source);
      } }, h('img', { src: image.asset.preview_url, loading: 'lazy', alt: image.external ? '素材图片' : imageName(image) }),
      h('span', null, image.external ? `${image.asset.width} × ${image.asset.height}` : imageName(image)),
      image.id && image.id === current ? h('small', null, `当前${frameLabels[selection.role]}`) : null)));
  } catch (error) { if (token === framePickerToken) list.replaceChildren(h('p', { class: 'cv-error' }, error.message)); }
}
function openFramePicker(card, role) {
  if (frameLocked(card)) return;
  frameSelection = { owner: doc, cardId: card.id, role };
  $('framePickerTitle').textContent = `选择${role === 'first_frame' ? '① 首帧' : '② 尾帧'}`;
  $('framePickerHint').textContent = role === 'first_frame' ? '这张图片决定视频开始的画面。选择后自动建立首帧连线。' : '这张图片决定视频结束的画面。首尾帧模式需要同时选择首帧。';
  $('framePicker').showModal(); renderFramePicker();
}

function videoCard(card) {
  if (card.task_id) return submittedVideo(card);
  const submitting = busyCards.has(card.id);
  const locked = submitting || !!card.request_key;
  const slot = role => {
    const edge = edgeInto(card.id, role);
    const image = edge && cardById(edge.from);
    return h('div', { class: `cv-slot cv-${role}${image?.asset ? ' filled' : ''}`, dataset: { role, card: card.id } },
      h('span', { class: 'cv-slot-label' }, `${role === 'first_frame' ? '①' : '②'} ${frameLabels[role]}`),
      h('button', { class: 'cv-slot-pick', type: 'button', disabled: locked, 'aria-label': `${image?.asset ? '更换' : '选择'}${frameLabels[role]}`,
        onclick: () => openFramePicker(card, role) }, image?.asset ? h('img', { src: image.asset.preview_url, alt: `${frameLabels[role]}预览` }) : h('span', null, '＋ 选择图片')),
      h('button', { class: 'cv-ghost cv-slot-upload', type: 'button', disabled: locked, onclick: () => openDirectUpload(card, role) }, `上传${frameLabels[role]}`),
      h('small', { class: 'cv-frame-caption' }, image?.asset ? imageName(image) : role === 'first_frame' ? '视频开始的画面' : '视频结束的画面 · 可选'),
      edge && !locked ? h('button', { class: 'cv-unlink', type: 'button', 'aria-label': `移除${frameLabels[role]}`, onclick: () => unlink(edge.id) }, '移除') : null);
  };
  const mode = videoMode(card);
  const body = h('div', { class: 'cv-body' },
    h('div', { class: 'cv-slots' }, slot('first_frame'), slot('last_frame')),
    firstAndLast(card) && !locked ? h('button', { class: 'cv-ghost cv-swap', type: 'button', onclick: () => swapFrames(card) }, '⇄ 交换首尾帧') : null,
    h('span', { class: 'cv-mode' }, `方式：${modeLabels[mode]}${edgeInto(card.id, 'last_frame') && !edgeInto(card.id, 'first_frame') ? ' · 还缺首帧' : ''}`),
    h('p', { class: 'cv-muted cv-frame-help' }, mode === 'first_last_frame' ? '① 首帧 → 提示词描述过渡 → ② 尾帧' : mode === 'image_to_video' ? '以首帧开始，提示词描述接下来的动作。' : '不选图片时按提示词生成；选择首帧可切换图生视频。'),
    promptBody(card, locked),
    (() => { const el = choose(videoModels, card.model || 'Seedance 2.0 Fast', value => { card.model = value; const { min, max } = videoDurationRange(value); card.duration = Math.max(min, Math.min(max, card.duration || 5)); fillCard(card); changed(); }, '视频模型'); el.disabled = locked; return el; })(),
    h('div', { class: 'cv-row' },
      h('label', null, '时长', h('input', { type: 'number', ...videoDurationRange(card.model), value: card.duration || 5, disabled: locked, 'aria-label': '视频时长（秒）',
        onchange: event => { const { min, max } = videoDurationRange(card.model); card.duration = Math.max(min, Math.min(max, Math.round(Number(event.target.value) || 5))); event.target.value = card.duration; changed(); } }), '秒'),
      (() => { const el = choose(ratios, card.ratio || '16:9', value => { card.ratio = value; changed(); }, '视频比例'); el.disabled = locked; return el; })()),
    card.error ? h('p', { class: 'cv-error' }, card.error) : null,
    h('div', { class: 'cv-actions-row' },
      h('button', { class: 'cv-go', type: 'button', disabled: submitting || !!edgeInto(card.id, 'last_frame') && !edgeInto(card.id, 'first_frame'), onclick: () => submitVideo(card) },
        submitting ? '正在提交…' : card.request_key ? '重试同一次提交' : '▶ 生成视频'),
      card.request_key && !submitting ? h('button', { class: 'cv-ghost', type: 'button', onclick: () => duplicateUncertainScene(card) }, '复制为新草稿') : null),
    card.request_key && !submitting ? h('p', { class: 'cv-muted' }, '上次提交结果未确认。重试会沿用同一个请求，不会重复生成。') : null);
  return [head(card, '▶ 视频卡', submitting ? ['提交中', 'busy'] : null), body, ...framePorts(card)];
}

// Videos load only near the visible area, so a large canvas stays light.
const lazyVideos = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting || !entry.target.dataset.src) continue;
    entry.target.src = entry.target.dataset.src;
    delete entry.target.dataset.src;
    lazyVideos.unobserve(entry.target);
  }
}, { root: $('viewport'), rootMargin: '400px' });

function submittedVideo(card) {
  const job = jobs.get(card.task_id);
  const status = job?.status || 'loading';
  const video = job?.videos?.find(item => /^[0-9a-f]{32,64}$/.test(String(item.id || '')));
  const chip = status === 'completed' ? ['完成'] : status === 'loading' ? ['读取中'] : active.has(status) ? [videoPhaseText[job?.phase] || statusText[status], 'busy'] : ['需处理', 'bad'];
  const body = h('div', { class: 'cv-body' });
  if (status === 'completed' && video) {
    const player = h('video', { controls: true, preload: 'metadata', playsInline: true, dataset: { src: `/v1/videos/files/${video.id}#t=0.1` } });
    let attemptedRefresh = false, reconnecting = false;
    const previewError = h('p', { class: 'cv-error', hidden: true }, '预览连接中断，成片文件仍然保留。');
    const reloadPreview = h('button', { class: 'cv-ghost', type: 'button', hidden: true, onclick: () => reloadMedia() }, '重新加载预览');
    async function reloadMedia() {
      if (reconnecting) return;
      reconnecting = true; reloadPreview.disabled = true;
      try { await connect(); player.src = `/v1/videos/files/${video.id}?preview=${Date.now()}#t=0.1`; player.load(); }
      catch { previewError.hidden = false; reloadPreview.hidden = false; }
      finally { reconnecting = false; reloadPreview.disabled = false; }
    }
    player.addEventListener('error', () => {
      previewError.hidden = false; reloadPreview.hidden = false;
      if (!attemptedRefresh) { attemptedRefresh = true; reloadMedia(); }
    });
    player.addEventListener('loadeddata', () => { previewError.hidden = true; reloadPreview.hidden = true; });
    lazyVideos.observe(player);
    body.append(player, previewError, reloadPreview, h('p', { class: 'cv-muted' }, `${video.width}×${video.height} · ${Number(video.duration).toFixed(1)} 秒 · ${isCloudVideo(video) ? '云盘上传版本' : '旧版来源待核验'}`));
  } else {
    const current = phases.findIndex(([key]) => key === job?.phase);
    body.append(h('div', { class: 'cv-wait' }, active.has(status) || status === 'loading' ? h('span', { class: 'cv-spin' }) : null, statusText[status] || '正在读取任务状态…',
      current >= 0 ? h('ul', { class: 'cv-phases' }, phases.map(([key, label], index) =>
        h('li', { class: key === job.phase ? 'current' : job.observed_phases?.includes(key) ? 'done' : '' }, label))) : null));
    if (job?.message) body.append(h('p', { class: 'cv-muted' }, job.message));
  }
  if (card.prompt) body.append(h('strong', { class: 'cv-prompt-label' }, '✎ 本次提示词 · 已提交'), h('p', { class: 'cv-prompt-view', title: card.prompt }, card.prompt));
  body.append(h('div', { class: 'cv-actions-row' },
    isCloudVideo(video) ? h('a', { class: 'cv-ghost', href: `/v1/videos/files/${video.id}`, download: `orbit-frame-${card.task_id.slice(0, 8)}.mp4` }, '下载 MP4') : null,
    retryable.has(status) || needsCloudExtraction(job) ? h('button', { class: 'cv-ghost', type: 'button', onclick: () => refreshTask(card.task_id) }, needsCloudExtraction(job) ? '重新提取云盘版本' : '重新查询') : null,
    active.has(status) || status==='waiting_input' ? h('button',{class:'cv-ghost',type:'button',onclick:()=>cancelCanvasTask(card,'video')},'取消视频任务') : null,
    h('a', { class: 'cv-ghost', href: `/?task=${card.task_id}`, target: '_blank', rel: 'noopener' }, '在创作页打开')));
  const el = els.get(card.id);
  if (el) el.dataset.sig = jobSig(job);
  const frames = ['first_frame', 'last_frame'].map(role => {
    const source = cardById(edgeInto(card.id, role)?.from);
    const input = card.input_frames?.find(f => f.role === role)?.asset || source?.asset;
    return input ? h('div', { class: `cv-slot cv-${role} filled` }, h('span', { class: 'cv-slot-label' }, `${role === 'first_frame' ? '①' : '②'} ${frameLabels[role]} · 已提交`),
      h('img', { src: input.preview_url, alt: `已提交的${frameLabels[role]}` }), h('small', { class: 'cv-frame-caption' }, input.name || (source ? imageName(source) : frameLabels[role]))) : null;
  }).filter(Boolean);
  if (frames.length) body.prepend(h('div', { class: 'cv-slots' }, frames));
  return [head(card, '▶ 视频卡', chip), body, ...framePorts(card)];
}
const jobSig = job => job ? `${job.status}|${job.phase}|${job.videos?.map(v => `${v.id}:${v.source_kind}`).join(',') || ''}|${job.message || ''}` : '';

function addCard(data, { select = true } = {}) {
  const spot = data.x == null || data.y == null ? spotNearCenter(data.type) : {};
  const card = { id: uid(), ...data, ...spot };
  doc.cards.push(card);
  mountCard(card);
  if (card.type === 'note') syncPromptInputs();
  if (select) setSelection([card.id]);
  changed('now');
  return card;
}
function addEdge(from, to, role) {
  if (role !== 'derived' && (frameLocked(cardById(to)) || !acceptsVideoInput(cardById(from), cardById(to), role))) {
    toast('文字请连接到提示词，图片请连接到首帧或尾帧；已提交任务的输入不能修改。', true); return;
  }
  if (role !== 'derived') doc.edges = doc.edges.filter(edge => !(edge.to === to && edge.role === role));
  doc.edges.push({ id: uid(), from, to, role });
  if (role !== 'derived') fillCard(cardById(to));
  queueEdges(); changed('now');
}
function unlink(edgeId) {
  const edge = doc.edges.find(item => item.id === edgeId);
  if (edge && edge.role !== 'derived' && frameLocked(cardById(edge.to))) { toast('已提交任务的输入不能修改。', true); return; }
  if (edge?.role === 'prompt') cardById(edge.to).prompt = videoPrompt(cardById(edge.to), doc.cards, doc.edges);
  doc.edges = doc.edges.filter(item => item.id !== edgeId);
  if (selectedEdge === edgeId) selectedEdge = null;
  if (edge) { const target = cardById(edge.to); if (target) fillCard(target); }
  queueEdges(); changed('now');
}
function removeCards(ids) {
  const cards = ids.map(cardById).filter(Boolean);
  if (!cards.length) return;
  if (cards.some(card => busyCards.has(card.id))) { toast('有视频正在提交，完成后再移除。', true); return; }
  const gone = new Set(cards.map(card => card.id));
  if (doc.edges.some(edge => edge.role !== 'derived' && gone.has(edge.from) && !gone.has(edge.to) && frameLocked(cardById(edge.to)))) {
    toast('这张卡片是已提交视频的输入。请先从画布移除对应视频卡片，再移除输入卡片。', true); return;
  }
  const touched = doc.edges.filter(edge => gone.has(edge.from) && !gone.has(edge.to)).map(edge => edge.to);
  for (const edge of doc.edges.filter(edge => edge.role === 'prompt' && gone.has(edge.from) && !gone.has(edge.to))) {
    const target = cardById(edge.to); target.prompt = videoPrompt(target, doc.cards, doc.edges);
  }
  doc.edges = doc.edges.filter(edge => !gone.has(edge.from) && !gone.has(edge.to));
  doc.cards = doc.cards.filter(card => !gone.has(card.id));
  for (const id of gone) { const el = els.get(id); if (el) { resizeWatch.unobserve(el); el.remove(); } els.delete(id); selected.delete(id); }
  for (const id of new Set(touched)) { const card = cardById(id); if (card) fillCard(card); }
  syncPromptInputs();
  queueEdges(); changed('now'); syncStream();
  toast(`已移除 ${cards.length} 张卡片，⌘Z 可撤销。图片、视频和任务都不会被删除。`);
}
function setSelection(ids) {
  for (const id of selected) els.get(id)?.classList.remove('selected');
  selected.clear();
  for (const id of ids) { selected.add(id); els.get(id)?.classList.add('selected'); }
  if (ids.length && selectedEdge) { selectedEdge = null; queueEdges(); }
  queueMinimap();
}
function reorder(ids, front = true) {
  const moving = doc.cards.filter(card => ids.includes(card.id));
  const rest = doc.cards.filter(card => !ids.includes(card.id));
  doc.cards = front ? rest.concat(moving) : moving.concat(rest);
  for (const card of doc.cards) $('cards').append(els.get(card.id));
}

// ---------- history (undo / redo) ----------
function volatileOf(card) {
  if (!card) return null;
  return runtimeFields(card);
}
function shape() {
  return JSON.stringify({ cards: doc.cards.map(card => Object.fromEntries(Object.entries(card).filter(([key]) => !volatileKeys.includes(key)))), edges: doc.edges });
}
function recordHistory() {
  clearTimeout(historyTimer); historyTimer = null;
  if (!doc) return;
  for (const card of doc.cards) archive.set(card.id, volatileOf(card));
  const now = shape();
  if (now === lastShape) return;
  undoStack.push(lastShape);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  lastShape = now;
  updateHistoryButtons();
}
function restore(snapshot) {
  const snap = JSON.parse(snapshot);
  const current = new Map(doc.cards.map(card => [card.id, card]));
  // Cards with generation in flight keep their live object, so results land.
  const pinned = id => busyCards.has(id) || imageWaits.has(id);
  const cards = snap.cards.map(card => pinned(card.id) && current.get(card.id) ? current.get(card.id)
    : restoreHistoryCard(card,current.get(card.id),archive.get(card.id) || {}));
  for (const [id, card] of current) if (pinned(id) && !cards.some(item => item.id === id)) cards.push(card);
  const ids = new Set(cards.map(card => card.id));
  const locked = new Set(cards.filter(card => card.type === 'video' && (card.task_id || card.request_key)).map(card => card.id));
  const committedEdges = doc.edges.filter(edge => edge.role !== 'derived' && locked.has(edge.to));
  // Editing history cannot rewrite the inputs of an accepted/uncertain
  // mutation. Keep its source cards as well as their explicit roles.
  for (const edge of committedEdges) {
    if (!ids.has(edge.from) && current.has(edge.from)) { cards.push(current.get(edge.from)); ids.add(edge.from); }
  }
  doc.cards = cards;
  doc.edges = snap.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && (edge.role === 'derived' || !locked.has(edge.to))).concat(committedEdges);
  lastShape = shape();
  selectedEdge = null;
  remountAll(); resumeImageWaits(); syncStream();
  changed(false);
  updateHistoryButtons();
}
function undo() {
  recordHistory();
  if (!undoStack.length) return;
  redoStack.push(lastShape);
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(lastShape);
  restore(redoStack.pop());
}
function updateHistoryButtons() {
  $('undoButton').disabled = !undoStack.length && !historyTimer;
  $('redoButton').disabled = !redoStack.length;
}

// ---------- clipboard ----------
let memoryClip = null;
function readClip() {
  try { return JSON.parse(localStorage.getItem(CLIP_KEY) || 'null') || memoryClip; } catch { return memoryClip; }
}
function copySelection() {
  if (!selected.size) return null;
  const ids = new Set(selected);
  const clip = { marker: `轨映画布卡片 ${ids.size} 张 · ${uid()}`,
    cards: structuredClone(doc.cards.filter(card => ids.has(card.id))),
    edges: structuredClone(doc.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))) };
  memoryClip = clip; pasteCount = 0;
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch {}
  return clip;
}
function pasteClip(clip, at = null) {
  if (!clip?.cards?.length) return;
  pasteCount++;
  const minX = Math.min(...clip.cards.map(card => card.x)), minY = Math.min(...clip.cards.map(card => card.y));
  const origin = at || { x: minX + 40 * pasteCount, y: minY + 40 * pasteCount };
  const idMap = new Map();
  const cards = clip.cards.map(source => {
    const card = { ...structuredClone(source), id: uid(), x: Math.round(origin.x + source.x - minX), y: Math.round(origin.y + source.y - minY) };
    idMap.set(source.id, card.id);
    // An unconfirmed submission belongs to the original card only.
    if (card.type === 'video' && !card.task_id) card.request_key = null;
    return card;
  });
  const edges = clip.edges.filter(edge => idMap.has(edge.from) && idMap.has(edge.to))
    .map(edge => ({ ...edge, id: uid(), from: idMap.get(edge.from), to: idMap.get(edge.to) }));
  doc.cards.push(...cards); doc.edges.push(...edges);
  cards.forEach(mountCard);
  setSelection(cards.map(card => card.id));
  queueEdges(); changed('now'); syncStream(); resumeImageWaits();
}
function duplicateSelection() { const clip = copySelection(); if (clip) pasteClip(clip); }

// ---------- generation ----------
async function generateImage(card) {
  if (!card.prompt?.trim()) { toast('请先写图片提示词。', true); return; }
  if (card.status === 'generating') return;
  const owner = doc, id = card.id;
  card.status = 'generating'; card.image_phase = 'submitting'; card.image_started_at = new Date().toISOString(); card.error = ''; card.image_job = crypto.randomUUID();
  imageSubmitting.add(card.id);
  fillCard(card); changed();
  try {
    if (await saveNow() === false) throw Object.assign(new Error('画布未能保存，图片尚未提交，请恢复连接后重试。'), { notSubmitted: true });
    const job = await api('/v1/images/jobs', { method: 'POST', body: JSON.stringify({ provider: card.provider || 'doubao-desktop', prompt: card.prompt, model: card.model || 'Seedream 4.5', ratio: card.ratio || '1:1',reference_images:card.reference_images || [], idempotency_key: card.image_job }) });
    const live = owner === doc && cardById(id);
    if (!live) return;
    live.image_job = job.id; changed();
    waitImageJob(live);
  } catch (error) {
    const live = owner === doc && cardById(id);
    if (live) { live.error = String(error.message).slice(0, 300); live.status = error.notSubmitted || error.status === 400 ? 'failed' : 'unknown'; if (live.status === 'failed') live.image_job = null; fillCard(live); changed(); }
  } finally { imageSubmitting.delete(card.id); }
}
// Waits on the server-side image job; survives reloads because the card keeps the job id.
async function waitImageJob(card, { refresh = false } = {}) {
  const jobId = card.image_job, id = card.id, owner = doc;
  if (!jobId || imageWaits.get(id) === jobId) return;
  imageWaits.set(id, jobId);
  try {
    for (;;) {
      let job;
      try { job = await api(`/v1/images/jobs/${jobId}?wait_seconds=25${refresh ? '&refresh=1' : ''}`, { signal: AbortSignal.timeout(45_000) }); }
      catch (error) {
        if (error.status === 404) job = { status: 'unknown', message: '本机暂未找到原图片任务。请先核对豆包会话，避免重复生成。' };
        else { await sleep(3000); if (owner !== doc) return; continue; }
      }
      const live = owner === doc && cardById(id);
      if (!live || live.image_job !== jobId) return;
      refresh = false;
      if (job.status === 'running') {
        if (live.image_phase !== job.phase || !live.image_started_at) { live.image_phase = job.phase; live.image_started_at = job.created_at; fillCard(live); }
        continue;
      }
      if (job.status === 'completed' && job.images?.length) {
        live.status = 'ready'; live.asset = job.images[0]; live.error = '';
        live.assets = job.images;
      } else { live.status = ['unknown','cancelled'].includes(job.status) ? job.status : 'failed'; live.error = job.message || (job.status==='cancelled'?'图片任务已取消':'图片生成失败，可以重新生成。'); }
      if (job.status !== 'unknown') live.image_job = null;
      live.image_phase = job.phase;
      fillCard(live); syncImageConnections(live); changed();
      return;
    }
  } finally { if (imageWaits.get(id) === jobId) imageWaits.delete(id); }
}
function resumeImageWaits() {
  for (const card of doc.cards) if (card.type === 'image' && card.status === 'generating' && card.image_job) waitImageJob(card);
}
function anotherImage(card, useReference = false) {
  const el = els.get(card.id);
  const next = addCard({ type: 'image', ...freeSpot(card.x, card.y + (el?.offsetHeight || 300) + 50, cardWidth(card)),
    prompt: card.prompt || '',provider:card.provider, model: card.model, ratio: card.ratio,reference_images:useReference?[structuredClone(card.asset)]:[],status: 'draft', error: '' });
  if(useReference) addEdge(card.id, next.id, 'derived');
  revealCard(next);requestAnimationFrame(()=>els.get(next.id)?.querySelector('textarea')?.focus());
}
function closestRatio(asset) {
  if (!asset) return '16:9';
  const value = asset.width / asset.height;
  return ratios.reduce((best, ratio) => {
    const [w, h] = ratio.split(':').map(Number);
    const [bw, bh] = best.split(':').map(Number);
    return Math.abs(w / h - value) < Math.abs(bw / bh - value) ? ratio : best;
  });
}
function videoFromImage(card) {
  const video = addCard({ type: 'video', ...freeSpot(card.x + cardWidth(card) + 90, card.y, widths.video, draftHeights.video), prompt: '', duration: 5,
    ratio: closestRatio(card.asset), error: '' });
  addEdge(card.id, video.id, 'first_frame');
  requestAnimationFrame(() => { revealCard(video); els.get(video.id)?.querySelector('textarea')?.focus({ preventScroll: true }); });
}

async function submitVideo(card) {
  if (busyCards.has(card.id)) return;
  const first = edgeInto(card.id, 'first_frame'), last = edgeInto(card.id, 'last_frame');
  const firstAsset = (card.request_key && card.input_frames?.find(f => f.role === 'first_frame')?.asset) || (first && cardById(first.from)?.asset),
    lastAsset = (card.request_key && card.input_frames?.find(f => f.role === 'last_frame')?.asset) || (last && cardById(last.from)?.asset);
  if (last && !first) { toast('首尾帧需要同时连接首帧。', true); return; }
  if ((first && !firstAsset) || (last && !lastAsset)) { toast('连接的图片还没准备好。', true); return; }
  const prompt = videoPrompt(card, doc.cards, doc.edges);
  if (!prompt.trim()) { toast(edgeInto(card.id, 'prompt') ? '连接的文字卡是空的，请先填写文字内容。' : '请在视频卡的「✎ 提示词」输入文字，或选择一张文字卡。', true); return; }
  const mode = videoMode(card);
  // Persist the idempotency key before sending, so a retry after a lost
  // response reuses the same request instead of generating twice.
  if (!card.request_key) card.input_frames = ['first_frame', 'last_frame'].flatMap(role => { const source = cardById(edgeInto(card.id, role)?.from); return source?.asset ? [{ role, asset: { ...source.asset } }] : []; });
  card.prompt = prompt;
  card.request_key ||= crypto.randomUUID();
  card.error = '';
  busyCards.add(card.id); fillCard(card);
  const owner=doc;
  let baseline;
  try {
    if (await saveNow() === false) throw Object.assign(new Error('画布未能保存，视频尚未提交，请恢复连接后重试。'), { data: { error: { submitted: false } } });
    baseline=structuredClone(serverDocument || owner);
    const job = await api(`/v1/canvases/${owner.id}/video-scenes/${card.id}/generate`, { method: 'POST',body:'{}',signal:AbortSignal.timeout(180_000) });
    if (!job?.task_id) throw new Error('服务没有返回任务 ID，请重试同一次提交。');
    card.task_id = job.task_id; jobs.set(job.task_id, job);
  } catch (error) {
    card.error = String(error.message).slice(0, 300);
  } finally {
    if(baseline && owner===doc) {
      try {
        const stored=await api(`/v1/canvases/${owner.id}`),persisted=stored.cards.find(item=>item.id===card.id);
        const merged=mergeCanvasDocuments(baseline,owner,stored);
        if(merged) {applySyncedDocument(owner,merged);serverDocument=structuredClone(stored);}
        else if(persisted) {const layout={x:card.x,y:card.y,w:card.w},error=card.error;Object.assign(card,persisted,layout);if(error)card.error=error;}
      }catch { /* Retry the same saved scene; never clear an uncertain key. */ }
    }
    busyCards.delete(card.id);
    fillCard(card); changed(); syncStream();
  }
}
async function cancelCanvasTask(card,kind) {
  const taskId=kind==='image'?card.image_job:card.task_id;if(!taskId)return;
  try {
    const result=await api(kind==='image'?`/v1/images/jobs/${taskId}/cancel`:`/v1/videos/tasks/${taskId}/cancel`,{method:'POST',body:'{}',signal:AbortSignal.timeout(30_000)});
    const state=result.cancellation?.state;
    toast(state==='cancelled'?'上游已确认取消':state==='already_completed'?'原任务已经完成':state==='unsupported'?'该服务不支持取消；原任务仍需查询':'取消请求已记录，上游状态仍待确认',state!=='cancelled');
    if(kind==='image' && result.status==='cancelled') {card.status='cancelled';card.error='上游已确认取消';fillCard(card);changed();}else if(kind==='video')onJob(result);
  }catch(error){toast(error.message,true);}
}
function duplicateUncertainScene(card) {
  // Preserve the original request and frozen inputs. A copy is only a draft;
  // starting it remains a separate, explicit action.
  const copy = addCard({type:'video', ...freeSpot(card.x + card.w + 80,card.y,widths.video),
    prompt:card.prompt,model:card.model,duration:card.duration,ratio:card.ratio,error:''});
  for (const edge of doc.edges.filter(item => item.to === card.id)) addEdge(edge.from,copy.id,edge.role);
  toast('已复制草稿；原请求保留。请先核对原任务，再决定是否生成新视频。');
  revealCard(copy);
}
async function refreshTask(taskId) {
  try { onJob(await api(`/v1/videos/tasks/${taskId}?refresh=1`)); streamIds = ''; syncStream(); }
  catch (error) { toast(error.message, true); }
}

// ---------- task updates (one SSE stream for every video on the canvas) ----------
function onJob(job) {
  if (!job?.task_id) return;
  jobs.set(job.task_id, job);
  for (const card of doc.cards) {
    if (card.type !== 'video' || card.task_id !== job.task_id) continue;
    if (els.get(card.id)?.dataset.sig !== jobSig(job)) fillCard(card); // Unchanged state keeps a playing video intact.
  }
  const ids = streamIds.split(',').filter(Boolean);
  if (stream && ids.length && ids.every(id => jobs.has(id) && !followsVideoTask(jobs.get(id)))) {
    stream.abort(); stream = null; // Everything settled; reopen only when a task is added or refreshed.
    streamIds = ''; queueMicrotask(syncStream); // Read the next batch of older cards, if present.
  }
}
function syncStream() {
  const candidates = [...new Set(doc.cards.filter(card => card.type === 'video' && card.task_id).map(card => card.task_id))];
  const ids = candidates.filter(id => !jobs.has(id) || followsVideoTask(jobs.get(id)))
    .sort((a, b) => Number(followsVideoTask(jobs.get(b))) - Number(followsVideoTask(jobs.get(a))) || a.localeCompare(b)).slice(0, 50).join(',');
  if (ids === streamIds && (stream || ids.split(',').every(id => jobs.has(id) && !followsVideoTask(jobs.get(id))))) return;
  stream?.abort(); stream = null; streamIds = ids;
  if (!ids) return;
  const controller = new AbortController();
  stream = controller;
  (async () => {
    let watchdog;
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 45000); };
    arm();
    try {
      const response = await fetch(`/v1/videos/events?ids=${ids}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('stream unavailable');
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
          if (data && stream === controller) onJob(JSON.parse(data));
        }
      }
    } catch { /* Reconnect below. */ }
    finally { clearTimeout(watchdog); }
    if (stream === controller) { stream = null; setTimeout(syncStream, 3000); }
  })();
}

// ---------- saving ----------
function changed(history = true) {
  indexedCards=null;
  if (!doc) return;
  setSave('有未保存的修改');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
  // 'now' marks a discrete action (add, remove, connect, move); typing is batched.
  if (history === 'now') recordHistory();
  else if (history) { clearTimeout(historyTimer); historyTimer = setTimeout(recordHistory, 350); updateHistoryButtons(); }
}
function body() {
  return { version: doc.version, title: doc.title, viewport: doc.viewport, cards: doc.cards, edges: doc.edges };
}
function applySyncedDocument(target,next) {
  const prior=new Map(target.cards.map(card=>[card.id,card]));
  Object.assign(target,next,{cards:next.cards.map(card=>{const current=prior.get(card.id) || {};for(const key of Object.keys(current))if(!(key in card))delete current[key];return Object.assign(current,card);})});
  indexedCards=null;
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!doc) return;
  if (saving) { saveAgain = true; return saving; }
  const target = doc;
  setSave('正在保存…');
  saving = api(`/v1/canvases/${target.id}`, { method: 'PUT', body: JSON.stringify(body()) })
    .then(saved => {
      target.version = saved.version;
      if(target===doc)serverDocument=structuredClone(saved);
      const item = canvasList.find(item => item.id === target.id); if (item) { item.title = target.title; item.updated_at = saved.updated_at; }
      if (target === doc) setSave('已保存'); return true;
    })
    .catch(async error => {
      if (error.status === 409 && error.data?.current && target === doc) {
        const merged=mergeCanvasDocuments(serverDocument,target,error.data.current);
        if(merged) {
          try {
            applySyncedDocument(target,merged);serverDocument=structuredClone(error.data.current);
            const saved=await api(`/v1/canvases/${target.id}`,{method:'PUT',body:JSON.stringify(body())});
            target.version=saved.version;serverDocument=structuredClone(saved);remountAll();applyViewport();setSave('已保存');return true;
          }catch { /* Preserve genuinely conflicting or still racing edits below. */ }
        }
        // Keep both versions: never silently discard the user's local edits.
        try {
          const copy = await api('/v1/canvases', { method: 'POST', body: JSON.stringify({ ...body(), title: `${target.title.slice(0, 68)}（冲突恢复）` }) });
          target.id = copy.id; target.version = copy.version; target.title = copy.title;
          serverDocument=structuredClone(copy);
          canvasList.unshift({ id: copy.id, title: copy.title, updated_at: copy.updated_at, cards: copy.cards.length });
          localStorage.setItem(LAST_KEY, copy.id); $('canvasTitle').value = copy.title; renderCanvasList();
          syncDocumentLocation();
          document.title = `${copy.title} · 轨映画布`;
          saveAgain = true; toast('另一个窗口已修改原画布。你的编辑已保留为“冲突恢复”副本。', true); return true;
        } catch { setSave('保存失败，当前编辑已保留，请勿关闭', true); return false; }
      } else { if (target === doc) setSave('保存失败，当前编辑已保留', true); if (error.status !== 400) setTimeout(() => { if (target === doc) changed(false); }, 3000); else toast(error.message, true); return false; }
    })
    .finally(() => { saving = null; if (saveAgain) { saveAgain = false; saveNow(); } });
  return saving;
}

// ---------- canvases ----------
function renderCanvasList() {
  const select = $('canvasSelect');
  select.replaceChildren(...canvasList.map(item => h('option', { value: item.id }, item.id === doc?.id ? doc.title : item.title)));
  if (doc) select.value = doc.id;
}
function loadDocument(next) {
  doc = next;
  serverDocument=structuredClone(next);
  syncDocumentLocation();
  try { localStorage.setItem(LAST_KEY, doc.id); } catch {}
  for (const card of doc.cards) {
    if (card.type === 'image' && card.status === 'generating' && !card.image_job) {
      card.status = 'failed'; card.error = '生成在提交前被中断，可以重新生成。';
    }
  }
  selected.clear(); selectedEdge = null;
  remountAll();
  $('canvasTitle').value = doc.title;
  document.title = `${doc.title} · 轨映画布`;
  applyViewport(); renderCanvasList();
  streamIds = ''; syncStream(); resumeImageWaits();
  undoStack = []; redoStack = []; archive.clear(); lastShape = shape();
  for (const card of doc.cards) archive.set(card.id, volatileOf(card));
  updateHistoryButtons();
  setSave('已保存');
}
function syncDocumentLocation() {
  if(!doc)return;
  const url=new URL(location.href);url.searchParams.set('id',doc.id);
  if(url.href!==location.href)history.replaceState(null,'',url);
}
async function openCanvas(id) {
  if (busyCards.size || imageSubmitting.size) { toast('有生成请求正在提交，请完成后再切换画布。', true); renderCanvasList(); return; }
  while (doc && (saveTimer || saving)) {
    if (await (saving || saveNow()) === false) { toast('当前修改尚未保存，暂不切换画布。', true); renderCanvasList(); return; }
  }
  closeFramePicker();
  loadDocument(await api(`/v1/canvases/${id}`));
}
async function newCanvas() {
  if (busyCards.size || imageSubmitting.size) { toast('有生成请求正在提交，请完成后再新建画布。', true); return; }
  const created = await api('/v1/canvases', { method: 'POST', body: JSON.stringify({ title: `画布 ${canvasList.length + 1}` }) });
  canvasList.unshift({ id: created.id, title: created.title, updated_at: created.updated_at, cards: 0 });
  await openCanvas(created.id);
  $('canvasTitle').select();
}
async function deleteCurrentCanvas() {
  if (!doc || busyCards.size || imageSubmitting.size) return;
  if (!confirm(`删除画布「${doc.title}」？\n只删除画布本身，生成的图片、视频和任务都会保留。删除后无法撤销。`)) return;
  const id = doc.id;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (saving) await saving.catch(() => {});
  await api(`/v1/canvases/${id}`, { method: 'DELETE' });
  canvasList = canvasList.filter(item => item.id !== id);
  doc = null;
  if (canvasList.length) await openCanvas(canvasList[0].id);
  else await newCanvas();
  toast('画布已删除。');
}

// ---------- uploads & assets ----------
async function uploadImage(file, at, { imageCard: existing, frameTarget, role, valid = () => true } = {}) {
  const owner = doc;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast(`${file.name || '图片'}：仅支持 PNG、JPEG 或 WebP。`, true); return null; }
  if (file.size > 20 * 1024 * 1024) { toast(`${file.name || '图片'}：图片不能超过 20 MB。`, true); return null; }
  setSave(`正在上传 ${file.name || '图片'}…`);
  try {
    const saved = await api('/v1/videos/frames', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: AbortSignal.timeout(60_000) });
    if (owner !== doc) { toast('图片已上传到素材库；画布已切换，未添加到当前画布。'); return null; }
    const asset = { ...saved, name: file.name.slice(0, 140) };
    if (!valid()) { toast('图片已保存到素材库，本次选择已取消。'); return null; }
    const reusable = existing || (frameTarget ? reusableFrameImage(doc.cards, doc.edges, frameTarget.id, role) : null);
    if (reusable) { reusable.asset = asset; reusable.assets = [asset]; reusable.status = 'ready'; reusable.prompt = ''; reusable.error = ''; reusable.image_job = null; fillCard(reusable); syncImageConnections(reusable); changed(); return reusable; }
    return addCard({ type: 'image', ...freeSpot(at.x, at.y, widths.image), prompt: '', status: 'ready', error: '', ratio: closestRatio(asset), asset, ...(frameTarget ? { frame_owner: frameTarget.id } : {}) });
  } catch (error) { toast(`${file.name || '图片'}：${error.message}`, true); setSave('上传失败', true); return null; }
}
function syncImageConnections(image) {
  for (const edge of doc.edges.filter(e => e.from === image.id && ['first_frame', 'last_frame'].includes(e.role))) { const target = cardById(edge.to); if (target && !target.task_id) fillCard(target); }
  queueEdges();
}
function openDirectUpload(card, role = null) {
  if (role && frameLocked(card) || !role && card.status === 'generating') return;
  directUpload = { owner: doc, cardId: card.id, role }; $('directUploadInput').click();
}
async function uploadFiles(files, at) {
  let last;
  for (const file of files) last = await uploadImage(file, at) || last;
  if (last) revealCard(last);
}
function addAsset(asset, at) {
  if (asset.kind === 'video') {
    const card = addCard({ type: 'video', ...freeSpot(at.x, at.y, widths.video, 360), task_id: asset.task_id, prompt: asset.prompt || '',
      duration: asset.duration || 5, ratio: asset.ratio || '16:9', error: '' });
    syncStream();
    return card;
  }
  return addCard({ type: 'image', ...freeSpot(at.x, at.y, widths.image), prompt: '', status: 'ready', error: '',
    ratio: closestRatio(asset), asset: { ...asset } });
}
const assetTabs = [['videos', '视频作品'], ['generated', '生成的图片'], ['uploads', '上传的图片']];
let assetTab = 'videos', drawerToken = 0;
const drawerVideos = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) if (isIntersecting && target.dataset.src) {
    target.src = target.dataset.src; delete target.dataset.src; drawerVideos.unobserve(target);
  }
}, { root: $('assetList'), rootMargin: '100px' });
function releaseDrawerMedia() {
  drawerVideos.disconnect();
  for (const player of $('assetList').querySelectorAll('video')) { player.pause(); player.removeAttribute('src'); player.load(); }
  $('assetList').replaceChildren();
}
async function renderDrawer() {
  const list = $('assetList');
  const token = ++drawerToken; // A slower earlier tab must not overwrite the current one.
  $('assetTabs').replaceChildren(...assetTabs.map(([key, label]) => h('button', { type: 'button', class: key === assetTab ? 'active' : '',
    onclick: () => { assetTab = key; renderDrawer(); } }, label)));
  releaseDrawerMedia(); list.replaceChildren(h('p', { class: 'cv-muted' }, '正在读取…'));
  try {
    await connect();
    try {const capabilities=await api('/v1/images/capabilities');const external=capabilities.providers.find(provider=>provider.id==='openai-compatible');if(external?.models?.length)externalImageModels=external.models;}catch{}
    const items = assetTab === 'videos'
      ? ((await api('/v1/videos/tasks')).tasks || []).filter(task => task.status === 'completed' && task.videos?.length).slice(0, 40)
        .map(task => ({ kind: 'video', task_id: task.task_id, prompt: task.prompt, duration: task.duration, ratio: task.ratio, video: task.videos[0] }))
      : ((await api(`/v1/media?dir=${assetTab}&limit=80`)).images || []).map(image => ({ kind: 'image', ...image }));
    if (token !== drawerToken) return;
    if (!items.length) { list.replaceChildren(h('p', { class: 'cv-muted' }, assetTab === 'videos' ? '还没有完成的视频。' : '这里还没有图片。')); return; }
    list.replaceChildren(...items.map(item => {
      const thumb = item.kind === 'video'
        ? h('video', { muted: true, preload: 'metadata', playsInline: true, 'aria-hidden': 'true', dataset: { src: `/v1/videos/files/${item.video.id}#t=0.1` } })
        : h('img', { src: item.preview_url, alt: '', loading: 'lazy', draggable: false });
      const label = item.kind === 'video' ? (item.prompt?.slice(0, 26) || '视频作品') : `${item.width}×${item.height}`;
      return h('button', { type: 'button', class: 'cv-asset', draggable: true, title: '点击放到画布中央，或拖到画布 / 视频槽位',
        ondragstart: event => { event.dataTransfer.setData('application/x-orbit-asset', JSON.stringify(item)); event.dataTransfer.effectAllowed = 'copy'; },
        onclick: () => { const center = viewCenter(); addAsset(item, { x: center.x - 150, y: center.y - 120 }); } }, thumb, h('span', null, label));
    }));
    for (const player of list.querySelectorAll('video')) drawerVideos.observe(player);
  } catch (error) { if (token === drawerToken) list.replaceChildren(h('p', { class: 'cv-error' }, error.message)); }
}
function toggleDrawer(open = $('drawer').hidden) {
  $('drawer').hidden = !open;
  $('assetsButton').classList.toggle('active', open);
  if (open) renderDrawer();
  else { drawerToken++; releaseDrawerMedia(); }
}

// ---------- menus & preview ----------
function closeMenu() { $('menu').hidden = true; }
function openMenu(x, y, items) {
  const menu = $('menu');
  menu.replaceChildren(...items.filter(Boolean).map(item => item === '-' ? h('hr')
    : h('button', { type: 'button', role: 'menuitem', disabled: item.disabled, onclick: () => { closeMenu(); item.run(); } },
      h('span', null, item.label), item.key ? h('kbd', null, item.key) : null)));
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - box.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - box.height - 8)}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}
function cardMenu(card, event) {
  if (!selected.has(card.id)) setSelection([card.id]);
  const many = selected.size > 1;
  const video = card.type === 'video' && jobs.get(card.task_id)?.videos?.[0];
  openMenu(event.clientX, event.clientY, [
    card.type === 'image' && card.asset ? { label: '查看大图', run: () => openLightbox(card) } : null,
    card.type === 'image' && card.asset ? { label: '用它生成视频', run: () => videoFromImage(card) } : null,
    card.type === 'image' && card.asset ? { label: '下载图片', run: () => download(card.asset.preview_url, card.asset.path.split('/').pop()) } : null,
    video ? { label: '下载 MP4', run: () => download(`/v1/videos/files/${video.id}`, `orbit-frame-${card.task_id.slice(0, 8)}.mp4`) } : null,
    (card.type === 'image' && card.asset) || video ? '-' : null,
    { label: many ? `复制 ${selected.size} 张` : '复制', key: '⌘C', run: copySelection },
    { label: '重复', key: '⌘D', run: duplicateSelection },
    { label: '置于顶层', run: () => { reorder([...selected], true); changed('now'); } },
    { label: '置于底层', run: () => { reorder([...selected], false); changed('now'); } },
    { label: '缩放到所选', run: () => fitView(doc.cards.filter(item => selected.has(item.id))) },
    '-',
    { label: many ? `移除 ${selected.size} 张` : '从画布移除', key: 'Del', run: () => removeCards([...selected]) },
  ]);
}
function canvasMenu(event) {
  const at = toWorld(event.clientX, event.clientY);
  const clip = readClip();
  openMenu(event.clientX, event.clientY, [
    { label: '在这里添加文字', run: () => addCardAt('note', at) },
    { label: '在这里添加图片卡', run: () => addCardAt('image', at) },
    { label: '在这里添加视频卡', run: () => addCardAt('video', at) },
    '-',
    { label: clip ? `粘贴 ${clip.cards.length} 张卡片` : '粘贴', key: '⌘V', disabled: !clip, run: () => pasteClip(clip, at) },
    { label: '全选', key: '⌘A', disabled: !doc.cards.length, run: () => setSelection(doc.cards.map(card => card.id)) },
    { label: '适应画布', run: () => fitView() },
  ]);
}
function download(href, name) {
  const link = h('a', { href, download: name });
  document.body.append(link); link.click(); link.remove();
}
function openLightbox(card) {
  $('lightboxImage').src = card.asset.preview_url;
  $('lightboxImage').alt = card.prompt || '画布图片';
  $('lightboxCaption').textContent = [card.prompt, `${card.asset.width}×${card.asset.height}`].filter(Boolean).join(' · ');
  $('lightbox').hidden = false;
  $('lightbox').focus();
}
// Keep newly added controls inside the canvas viewport even when freeSpot
// finds space beyond the visible area. Browser scrolling cannot pan the world.
function revealCard(card) {
  const el = els.get(card.id), viewport = $('viewport').getBoundingClientRect();
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const left = viewport.left + 120, right = viewport.right - 24, top = viewport.top + 24, bottom = viewport.bottom - 40;
  if (rect.width > right - left || rect.height > bottom - top) { fitView([card]); return; }
  const dx = rect.left < left ? left - rect.left : rect.right > right ? right - rect.right : 0;
  const dy = rect.top < top ? top - rect.top : rect.bottom > bottom ? bottom - rect.bottom : 0;
  if (dx || dy) { doc.viewport.x += dx; doc.viewport.y += dy; applyViewport(); changed(); }
}
function addCardAt(type, at) {
  const data = type === 'note' ? { type, text: '' }
    : type === 'image' ? { type, prompt: '', model: 'Seedream 4.5', ratio: '1:1', status: 'draft', error: '' }
    : { type, prompt: '', duration: 5, ratio: '16:9', error: '' };
  const spot = at ? freeSpot(at.x - widths[type] / 2, at.y - 60, widths[type], draftHeights[type]) : spotNearCenter(type);
  const card = addCard({ ...data, ...spot });
  requestAnimationFrame(() => { revealCard(card); els.get(card.id)?.querySelector('textarea')?.focus({ preventScroll: true }); });
  return card;
}

// ---------- pointer interaction ----------
function capture(el, event) { try { el.setPointerCapture(event.pointerId); } catch { /* Synthetic or finished pointer. */ } }
function track(onMove, onUp) {
  const viewport = $('viewport');
  const move = event => { if (!pinch) onMove(event); };
  const up = event => {
    viewport.removeEventListener('pointermove', move); viewport.removeEventListener('pointerup', up); viewport.removeEventListener('pointercancel', up);
    onUp(event);
  };
  viewport.addEventListener('pointermove', move); viewport.addEventListener('pointerup', up); viewport.addEventListener('pointercancel', up);
}
function startPan(event, clearOnClick = true) {
  const viewport = $('viewport');
  const start = { x: event.clientX, y: event.clientY, vx: doc.viewport.x, vy: doc.viewport.y };
  let moved = false;
  viewport.classList.add('panning');
  capture(viewport, event);
  track(e => {
    if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) moved = true;
    doc.viewport.x = start.vx + e.clientX - start.x; doc.viewport.y = start.vy + e.clientY - start.y; applyViewport();
  }, () => {
    viewport.classList.remove('panning');
    if (moved) changed();
    else if (clearOnClick) { setSelection([]); if (selectedEdge) selectEdge(null); }
  });
}
function startMarquee(event) {
  const viewport = $('viewport'), box = $('marquee');
  const origin = viewport.getBoundingClientRect();
  const start = { x: event.clientX, y: event.clientY };
  const base = new Set(selected);
  capture(viewport, event);
  track(e => {
    const x1 = Math.min(start.x, e.clientX), x2 = Math.max(start.x, e.clientX), y1 = Math.min(start.y, e.clientY), y2 = Math.max(start.y, e.clientY);
    Object.assign(box.style, { left: `${x1 - origin.left}px`, top: `${y1 - origin.top}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    box.hidden = false;
    const hits = doc.cards.filter(card => {
      const r = els.get(card.id)?.getBoundingClientRect();
      return r && r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1;
    }).map(card => card.id);
    setSelection([...new Set([...base, ...hits])]);
  }, () => { box.hidden = true; });
}
function startDrag(event, id) {
  if (!selected.has(id)) setSelection(event.shiftKey ? [...selected, id] : [id]);
  const ids = [...selected];
  reorder(ids, true);
  const viewport = $('viewport');
  const origin = toWorld(event.clientX, event.clientY);
  const starts = ids.map(cardById).filter(Boolean).map(card => ({ card, x: card.x, y: card.y }));
  let moved = false;
  capture(viewport, event);
  track(e => {
    const point = toWorld(e.clientX, e.clientY);
    const dx = point.x - origin.x, dy = point.y - origin.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    for (const item of starts) { item.card.x = Math.round(item.x + dx); item.card.y = Math.round(item.y + dy); place(item.card); }
    queueEdges();
  }, () => { if (moved) changed('now'); });
}
function startResize(event, id) {
  const card = cardById(id), el = els.get(id);
  if (!card || !el) return;
  const viewport = $('viewport');
  const origin = toWorld(event.clientX, event.clientY).x, startWidth = cardWidth(card);
  capture(viewport, event);
  track(e => {
    card.w = Math.round(Math.max(minWidths[card.type], Math.min(960, startWidth + toWorld(e.clientX, e.clientY).x - origin)));
    el.style.width = `${card.w}px`;
    queueEdges();
  }, () => changed('now'));
}
function slotAt(x, y, source = null) {
  const slot = document.elementFromPoint(x, y)?.closest('.cv-slot, .cv-input-port, .cv-prompt-slot');
  if (!slot) return null;
  const card = cardById(slot.dataset.card);
  return card && !frameLocked(card) && (source ? acceptsVideoInput(source, card, slot.dataset.role) : slot.dataset.role !== 'prompt') ? slot : null;
}
function startConnect(event, fromId) {
  const viewport = $('viewport');
  capture(viewport, event);
  let hover = null;
  const a = anchor(fromId, '.cv-port');
  track(e => {
    tempEdge = { a, b: toWorld(e.clientX, e.clientY) };
    const slot = slotAt(e.clientX, e.clientY, cardById(fromId));
    if (slot !== hover) { hover?.classList.remove('hover'); hover = slot; hover?.classList.add('hover'); }
    queueEdges();
  }, () => {
    tempEdge = null; hover?.classList.remove('hover');
    if (hover) addEdge(fromId, hover.dataset.card, hover.dataset.role);
    else toast(cardById(fromId)?.type === 'note' ? '请把文字连线拖到视频的 ✎ 提示词入口。' : '请把图片连线拖到视频的 ① 首帧或 ② 尾帧入口。', true);
    queueEdges();
  });
}

function setupInteraction() {
  const viewport = $('viewport');
  viewport.addEventListener('scroll', queueEdges);
  viewport.addEventListener('pointermove', event => { lastPointer = { x: event.clientX, y: event.clientY }; });
  viewport.addEventListener('pointerdown', event => {
    closeMenu();
    if (!doc || pinch) return;
    if (event.button === 1 || (event.button === 0 && spaceDown)) { event.preventDefault(); startPan(event, false); return; }
    if (event.button !== 0) return;
    const card = event.target.closest('.cv-card');
    if (card) lastCardPointerDown = performance.now();
    if (card && event.target.closest('.cv-resize')) { event.preventDefault(); startResize(event, card.dataset.id); return; }
    if (card && event.target.closest('.cv-port')) { event.preventDefault(); startConnect(event, card.dataset.id); return; }
    if (card) {
      const handle = event.target.closest('.cv-card-head, .cv-figure, .cv-wait') && !event.target.closest('button, a, input, select, textarea');
      if (handle) { event.preventDefault(); startDrag(event, card.dataset.id); }
      else if (!selected.has(card.dataset.id)) setSelection(event.shiftKey ? [...selected, card.dataset.id] : [card.dataset.id]);
      return;
    }
    const edge = event.target.closest?.('.cv-edge-hit');
    if (edge) { selectEdge(edge.dataset.edge); return; }
    if (event.shiftKey) { event.preventDefault(); startMarquee(event); return; }
    startPan(event);
  });
  viewport.addEventListener('wheel', event => {
    if (!doc) return;
    if (!mod(event) && event.target.closest('textarea, .cv-menu')) return;
    event.preventDefault();
    if (mod(event)) zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0045));
    else { doc.viewport.x -= event.deltaX; doc.viewport.y -= event.deltaY; applyViewport(); changed(); }
  }, { passive: false });
  viewport.addEventListener('dblclick', event => {
    if (!doc) return;
    const figure = event.target.closest('.cv-figure');
    if (figure) { const card = cardById(figure.closest('.cv-card').dataset.id); if (card?.asset) openLightbox(card); return; }
    if (event.target.closest('.cv-card')) return;
    // A quick second click after removing a card must not create a note
    // at the now-empty position of its close button.
    if (performance.now() - lastCardPointerDown < 450) return;
    const at = toWorld(event.clientX, event.clientY);
    const note = addCard({ type: 'note', x: Math.round(at.x - 120), y: Math.round(at.y - 40), text: '' });
    requestAnimationFrame(() => els.get(note.id)?.querySelector('textarea')?.focus());
  });
  viewport.addEventListener('contextmenu', event => {
    if (!doc || isEditable(event.target)) return;
    if (!mod(event) && event.target.closest('video,button,a,[role="button"]')) return;
    event.preventDefault();
    const card = event.target.closest('.cv-card');
    const edge = event.target.closest?.('.cv-edge-hit');
    if (card) cardMenu(cardById(card.dataset.id), event);
    else if (edge) { selectEdge(edge.dataset.edge); openMenu(event.clientX, event.clientY, [{ label: '删除连线', key: 'Del', run: () => unlink(edge.dataset.edge) }]); }
    else canvasMenu(event);
  });

  // Two-finger pinch zoom and pan on touch screens.
  const pinchState = touches => {
    const [a, b] = [touches[0], touches[1]];
    return { cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 };
  };
  viewport.addEventListener('touchstart', event => { if (event.touches.length === 2) { pinch = pinchState(event.touches); event.preventDefault(); } }, { passive: false });
  viewport.addEventListener('touchmove', event => {
    if (!pinch || event.touches.length !== 2 || !doc) return;
    event.preventDefault();
    const next = pinchState(event.touches);
    doc.viewport.x += next.cx - pinch.cx; doc.viewport.y += next.cy - pinch.cy;
    zoomAt(next.cx, next.cy, next.d / pinch.d);
    pinch = next;
  }, { passive: false });
  viewport.addEventListener('touchend', event => { if (event.touches.length < 2) pinch = null; });

  const isAsset = event => event.dataTransfer?.types?.includes('application/x-orbit-asset');
  viewport.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types?.includes('Files') && !isAsset(event)) return;
    event.preventDefault(); viewport.classList.add('drop-over');
    document.querySelectorAll('.cv-slot.hover').forEach(el => el.classList.remove('hover'));
    slotAt(event.clientX, event.clientY)?.classList.add('hover');
  });
  viewport.addEventListener('dragleave', event => { if (event.target === viewport) viewport.classList.remove('drop-over'); });
  viewport.addEventListener('drop', async event => {
    event.preventDefault(); viewport.classList.remove('drop-over');
    document.querySelectorAll('.cv-slot.hover').forEach(el => el.classList.remove('hover'));
    if (!doc) return;
    const at = toWorld(event.clientX, event.clientY);
    const slot = slotAt(event.clientX, event.clientY);
    const video = slot && cardById(slot.dataset.card);
    const near = video && { x: video.x - widths.image - 90, y: video.y + (slot.dataset.role === 'last_frame' ? 340 : 0) };
    if (isAsset(event)) {
      let asset = null;
      try { asset = JSON.parse(event.dataTransfer.getData('application/x-orbit-asset')); } catch {}
      if (!asset) return;
      if (video && asset.kind === 'image') { const image = addAsset(asset, near); addEdge(image.id, video.id, slot.dataset.role); }
      else addAsset(asset, at);
      return;
    }
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    if (video) {
      const image = await uploadImage(files[0], near);
      if (image) addEdge(image.id, video.id, slot.dataset.role);
      return;
    }
    await uploadFiles(files, at);
  });

  $('minimap').addEventListener('pointerdown', event => {
    if (!doc) return;
    event.preventDefault();
    const minimap = $('minimap');
    capture(minimap, event);
    minimapJump(event);
    const move = e => minimapJump(e);
    const up = () => { minimap.removeEventListener('pointermove', move); minimap.removeEventListener('pointerup', up); };
    minimap.addEventListener('pointermove', move); minimap.addEventListener('pointerup', up);
  });

  document.addEventListener('keydown', event => {
    if ($('framePicker').open) return; // The modal owns its keyboard focus.
    if (event.key === 'Escape') {
      if (!$('lightbox').hidden) { $('lightbox').hidden = true; return; }
      if (!$('menu').hidden) { closeMenu(); return; }
    }
    if (!doc || isEditable(event.target)) return;
    if (!mod(event) && event.target.closest('video,button,a,[role="button"]')) return;
    const key = event.key.toLowerCase();
    if (event.key === ' ' && !spaceDown) { spaceDown = true; $('viewport').classList.add('space'); event.preventDefault(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && (selected.size || selectedEdge)) {
      event.preventDefault();
      if (selectedEdge) unlink(selectedEdge); else removeCards([...selected]);
    } else if (event.key === 'Escape') { setSelection([]); selectEdge(null); }
    else if (mod(event) && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (mod(event) && key === 'y') { event.preventDefault(); redo(); }
    else if (mod(event) && key === 'a') { event.preventDefault(); setSelection(doc.cards.map(card => card.id)); }
    else if (mod(event) && key === 'd') { event.preventDefault(); duplicateSelection(); }
    else if (mod(event) && (event.key === '=' || event.key === '+')) { event.preventDefault(); zoomCenter(1.2); }
    else if (mod(event) && event.key === '-') { event.preventDefault(); zoomCenter(1 / 1.2); }
    else if (mod(event) && event.key === '0') { event.preventDefault(); zoomCenter(1 / doc.viewport.zoom); }
    else if (event.shiftKey && event.key === '!') { event.preventDefault(); fitView(); }
    else if (event.key.startsWith('Arrow') && selected.size) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      for (const id of selected) { const card = cardById(id); if (card) { card.x += dx; card.y += dy; place(card); } }
      queueEdges(); changed();
    }
  });
  document.addEventListener('keyup', event => { if (event.key === ' ') { spaceDown = false; $('viewport').classList.remove('space'); } });
  window.addEventListener('blur', () => { spaceDown = false; $('viewport').classList.remove('space'); });

  document.addEventListener('copy', event => {
    if (!doc || isEditable(event.target) || getSelection()?.toString()) return;
    const clip = copySelection();
    if (!clip) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', clip.marker);
    toast(`已复制 ${clip.cards.length} 张卡片。`);
  });
  document.addEventListener('paste', async event => {
    if (!doc || isEditable(event.target)) return;
    const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    const text = event.clipboardData?.getData('text/plain') || '';
    event.preventDefault();
    const at = lastPointer ? toWorld(lastPointer.x, lastPointer.y) : viewCenter();
    if (files.length) { await uploadFiles(files, at); return; }
    const clip = readClip();
    if (clip && text === clip.marker) { pasteClip(clip); return; }
    if (text.trim()) addCard({ type: 'note', ...freeSpot(at.x - widths.note / 2, at.y - 40, widths.note), text: text.slice(0, 20_000) });
  });
}

function setupChrome() {
  $('closeFramePicker').onclick = closeFramePicker;
  $('framePicker').addEventListener('cancel', () => { frameSelection = null; framePickerToken++; });
  $('frameUploadInput').addEventListener('change', async event => {
    const selection = frameSelection, file = event.target.files[0]; event.target.value = '';
    if (!file || !selection || selection.owner !== doc) return;
    const target = cardById(selection.cardId);
    if (frameLocked(target)) return;
    const image = await uploadImage(file, { x: target.x - widths.image - 90, y: target.y + (selection.role === 'last_frame' ? 340 : 0) }, { frameTarget: target, role: selection.role, valid: () => selection === frameSelection && cardById(selection.cardId) === target && !frameLocked(target) });
    if (image && selection === frameSelection) applyPickedFrame(image);
  });
  $('directUploadInput').onchange = async event => {
    const choice = directUpload, file = event.target.files[0]; event.target.value = '';
    if (!choice || !file || choice.owner !== doc) return;
    const target = cardById(choice.cardId);
    if (!target || choice.role && frameLocked(target)) return;
    const image = await uploadImage(file, { x: target.x - widths.image - 90, y: target.y + (choice.role === 'last_frame' ? 340 : 0) }, {
      ...(choice.role ? { frameTarget: target, role: choice.role } : { imageCard: target }),
      valid: () => choice === directUpload && choice.owner === doc && cardById(choice.cardId) === target && (!choice.role || !frameLocked(target)) });
    if (image && choice.role) { addEdge(image.id, target.id, choice.role); toast(`已上传并设置${frameLabels[choice.role]}。`); }
  };
  setInterval(() => { for (const el of document.querySelectorAll('.cv-image-elapsed')) { const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.started)) / 1000)); el.textContent = `已等待 ${elapsed} 秒 · 尚未返回完成结果`; } }, 1000);
  document.querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => { if (doc) addCardAt(button.dataset.add); }));
  $('uploadInput').addEventListener('change', async event => {
    const files = [...event.target.files]; event.target.value = '';
    if (doc && files.length) { const center = viewCenter(); await uploadFiles(files, { x: center.x - 140, y: center.y - 120 }); }
  });
  $('assetsButton').onclick = () => toggleDrawer();
  $('closeDrawer').onclick = () => toggleDrawer(false);
  $('canvasTitle').addEventListener('input', event => {
    if (!doc) return;
    doc.title = event.target.value.slice(0, 80) || '未命名画布';
    const item = canvasList.find(item => item.id === doc.id); if (item) item.title = doc.title;
    document.title = `${doc.title} · 轨映画布`;
    renderCanvasList(); changed(false);
  });
  $('canvasSelect').addEventListener('change', event => openCanvas(event.target.value).catch(error => toast(error.message, true)));
  $('newCanvas').addEventListener('click', () => newCanvas().catch(error => toast(error.message, true)));
  $('syncCanvas').addEventListener('click', async () => {
    if (!doc) return;
    try { await openCanvas(doc.id); toast('已同步当前画布的镜头和首尾帧。'); }
    catch (error) { toast(error.message, true); }
  });
  $('deleteCanvas').addEventListener('click', () => deleteCurrentCanvas().catch(error => toast(error.message, true)));
  $('undoButton').onclick = undo;
  $('redoButton').onclick = redo;
  $('zoomIn').onclick = () => zoomCenter(1.2);
  $('zoomOut').onclick = () => zoomCenter(1 / 1.2);
  $('zoomReset').onclick = () => zoomCenter(1 / doc.viewport.zoom);
  $('zoomFit').onclick = () => fitView();
  $('minimapToggle').onclick = () => {
    $('minimap').hidden = !$('minimap').hidden;
    $('minimapToggle').classList.toggle('active', !$('minimap').hidden);
    queueMinimap();
  };
  $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.cv-menu')) closeMenu(); });
  const theme = () => { const space = document.documentElement.dataset.mode === 'space'; $('themeToggle').textContent = space ? '☀' : '☾'; $('themeToggle').setAttribute('aria-label', space ? '切换天空主题' : '切换深空主题'); };
  $('themeToggle').onclick = () => {
    const next = document.documentElement.dataset.mode === 'space' ? 'sky' : 'space';
    document.documentElement.dataset.mode = next;
    try { localStorage.setItem('orbit_frame_theme', next); } catch {}
    theme(); queueMinimap();
  };
  theme();
  window.addEventListener('resize', queueMinimap);
  window.addEventListener('beforeunload', event => {
    if (saveTimer || saving || busyCards.size) { saveNow(); event.preventDefault(); }
  });
}

async function boot() {
  setupChrome(); setupInteraction();
  try {
    await connect();
    try {const capabilities=await api('/v1/images/capabilities');const external=capabilities.providers.find(provider=>provider.id==='openai-compatible');if(external?.models?.length)externalImageModels=external.models;}catch{}
    canvasList = (await api('/v1/canvases')).canvases || [];
    let last = null;
    try { last = localStorage.getItem(LAST_KEY); } catch {}
    const linked = new URLSearchParams(location.search).get('id');
    let id = canvasList.some(item => item.id === linked) ? linked : canvasList.some(item => item.id === last) ? last : canvasList[0]?.id;
    if (!id) {
      const created = await api('/v1/canvases', { method: 'POST', body: JSON.stringify({ title: '我的第一张画布', viewport: { x: 140, y: 60, zoom: 1 } }) });
      canvasList = [{ id: created.id, title: created.title, updated_at: created.updated_at, cards: 0 }];
      id = created.id;
    }
    await openCanvas(id);
  } catch (error) {
    setSave('未连接', true);
    toast(error.message, true);
  }
}
boot();
