import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { withApp, resolveApp } from 'doubao-cli/src/app.mjs';
import { CdpClient, cdpStatus, findChatTarget, withChatClient } from 'doubao-cli/src/cdp.mjs';
import { waitConversation, sendMessage } from 'doubao-cli/src/automation.mjs';
import { clearUploadedAttachments } from 'doubao-cli/src/attachments.mjs';
import { resolveTaskContext } from 'doubao-cli/src/context.mjs';
import { modelProtocol, sendChatCompletion } from 'doubao-cli/src/protocol.mjs';
import { performVideoSubmission } from './video-submission.js';
import { uploadVideoAttachments, cleanupVideoUpload, nativeVideoAttachmentBlocks } from './video-attachment-upload.js';
import { readTurn, refreshTurn, waitTurn, messageBlocks, receiptStore } from 'doubao-cli/src/turns.mjs';
import { APP_MODULE_BOOTSTRAP } from 'doubao-cli/src/app-modules.mjs';
import { config } from './config.js';
import { boundedCdp } from './video-errors.js';
import { readLiveVideoTurn, acknowledgeLiveConfirmations } from './video-live-turn.js';
import { extractCloudVideos, selectCloudVideos } from './video-delivery.js';
import { videoDiagnostic } from './video-errors.js';
import { validateVideoDuration } from './video-models.js';
import { extractReferenceFailure } from './reference-failure.js';

const idPattern = /^\d{12,24}$/;
const mediaHosts = /^(?:(?:[a-z0-9-]+\.)*(?:douyin\.com|douyinvod\.com|byteimg\.com|doubaocdn\.com)|v\d+-vdl\.doubao\.com)$/i;
// Seedance agent replies may deliver the video only as a short link in text.
const shortVideoLink = /https:\/\/aka\.doubaocdn\.com\/s\/([A-Za-z0-9_-]{4,64})(?![A-Za-z0-9_\/-])/g;
const maxTextLinks = 4;
const maxBytes = 100 * 1024 * 1024;
const videoDir = path.join(config.dataDir, 'videos');
const idleCloseMs = 120_000;

// All Doubao CDP work runs on one process-wide lane over one reused chat-page
// connection, so concurrent watchers and API calls never read the same
// session at the same time or reconnect for every query.
let lane = Promise.resolve();
let shared = null;
let idleTimer = null;
const inflight = new Map();

function cdpExclusive(work) {
  const run = lane.then(() => withApp(resolveApp('doubao'), work));
  lane = run.catch(() => {});
  return run;
}

async function sharedClient() {
  clearTimeout(idleTimer);
  if (shared?.socket?.readyState === WebSocket.OPEN) return shared;
  shared = null;
  const status = await cdpStatus();
  if (!status.available) throw new Error(status.error || 'Doubao CDP is unavailable');
  const target = await findChatTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await boundedCdp(() => client.connect(), () => client.close());
  const send = client.send.bind(client);
  client.send = (method, params) => boundedCdp(() => send(method, params), () => client.close());
  client.socket.addEventListener('close', () => { if (shared === client) shared = null; });
  shared = client;
  return client;
}

function releaseLater() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { shared?.close(); shared = null; }, idleCloseMs);
  idleTimer.unref?.();
}

export function withDoubaoClient(work) {
  return cdpExclusive(async () => {
    try { return await work(await sharedClient()); }
    catch (error) {
      if (shared && shared.socket?.readyState !== WebSocket.OPEN) shared = null;
      throw error;
    } finally { releaseLater(); }
  });
}

function singleFlight(key, work) {
  if (inflight.has(key)) return inflight.get(key);
  const run = work().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

function validId(value, name) {
  const id = String(value || '');
  if (!idPattern.test(id)) throw new Error(`Invalid ${name}`);
  return id;
}

function validPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    return !(parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
      parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 ||
      parts[0] === 192 && parts[1] === 168 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return !(lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') ||
      lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') ||
      lower.startsWith('::ffff:'));
  }
  return false;
}

async function checkedMediaUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !mediaHosts.test(url.hostname)) {
    throw new Error('Video source host is not allowed');
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !validPublicAddress(item.address))) {
    throw new Error('Video source resolved to a non-public address');
  }
  return url;
}

function videoUrl(video) {
  if (video.download_url) return video.download_url;
  try {
    const model = typeof video.video_model === 'string' ? JSON.parse(video.video_model) : video.video_model;
    const variants = Object.values(model?.video_list || {});
    for (const item of variants) {
      const encoded = item?.main_url || item?.url;
      if (!encoded) continue;
      const decoded = /^https:\/\//.test(encoded) ? encoded : Buffer.from(encoded, 'base64').toString('utf8');
      if (/^https:\/\//.test(decoded)) return decoded;
    }
  } catch { /* Do not guess from malformed metadata. */ }
  return '';
}

export function extractRunVideos(snapshot) {
  const found = [];
  const messages = [...(snapshot.messages || []), ...(snapshot.nodes || []).flatMap(node => (node.messages || []).map(message => ({ ...message, thread_id: message.thread_id || node.threadId || node.thread_id })))]
    .filter(message => Number(message.user_type) === 2);
  const entries = messages.flatMap(message => messageBlocks(message).map(block => ({
    messageId: String(message.message_id), group: String(message.thread_id || 'main'), block })));
  for (const message of messages) {
    for (const block of messageBlocks(message)) {
      if (Number(block.block_type) === 10020) {
        const file = block.content?.file_block;
        if (file && file.type === 'mp4' && /\.mp4$/i.test(file.name || '') && file.url) {
          found.push({ kind: 'file', messageId: String(message.message_id), blockId: String(block.block_id),
            creationId: String(block.block_id), vid: '', width: null, height: null, duration: null,
            source: file.url, expectedBytes: Number(file.size) || null });
        }
        continue;
      }
      if (Number(block.block_type) !== 10084) continue;
      for (const media of block.content?.rich_media_layout_block?.media || []) {
        const creation = media.creation;
        const video = creation?.video;
        if (Number(creation?.type) !== 2 || !video || Number(video.status) !== 3) continue;
        const width = Number(video.width), height = Number(video.height), duration = Number(video.duration);
        const source = videoUrl(video);
        if (!source || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 ||
          !Number.isFinite(duration) || duration <= 0 || video.video_type !== 'mp4') continue;
        found.push({ kind: 'creation', messageId: String(message.message_id), blockId: String(block.block_id),
          creationId: String(creation.id), vid: String(video.vid || ''), width, height, duration, source });
      }
    }
  }
  // Keep every source category, even when the reply also contains a card.
  const links = new Set();
  for (const message of messages) {
    for (const block of messageBlocks(message)) {
      if (Number(block.block_type) !== 10000) continue;
      for (const match of String(block.content?.text_block?.text || '').matchAll(shortVideoLink)) {
        if (links.size >= maxTextLinks) break;
        if (links.has(match[0])) continue;
        links.add(match[0]);
        found.push({ kind: 'link', messageId: String(message.message_id), blockId: String(block.block_id || ''),
          creationId: match[1], vid: '', width: null, height: null, duration: null, source: match[0] });
      }
    }
  }
  const unique = new Map();
  for (const video of [...found, ...extractCloudVideos(entries)]) unique.set(video.source, video);
  return [...unique.values()];
}

function ratioMatches(width, height, ratio) {
  const [w, h] = String(ratio).split(':').map(Number);
  return w > 0 && h > 0 && Math.abs(width / height / (w / h) - 1) <= 0.05;
}

function boxes(data, start, end) {
  const found = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(data.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
    found.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return found;
}

function probeMp4(data) {
  if (data.length < 32 || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid MP4 header');
  const top = boxes(data, 0, data.length);
  if (!top.some(box => box.type === 'mdat' && box.end > box.start)) throw new Error('MP4 media data is missing');
  const moov = top.find(box => box.type === 'moov');
  if (!moov) throw new Error('MP4 movie metadata is missing');
  for (const trak of boxes(data, moov.start, moov.end).filter(box => box.type === 'trak')) {
    const children = boxes(data, trak.start, trak.end);
    const tkhd = children.find(box => box.type === 'tkhd');
    const mdia = children.find(box => box.type === 'mdia');
    if (!tkhd || !mdia) continue;
    const media = boxes(data, mdia.start, mdia.end);
    const hdlr = media.find(box => box.type === 'hdlr');
    const mdhd = media.find(box => box.type === 'mdhd');
    if (!hdlr || !mdhd || hdlr.start + 12 > hdlr.end || data.toString('ascii', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    if (tkhd.end - tkhd.start < 8) continue;
    const width = data.readUInt32BE(tkhd.end - 8) / 65536;
    const height = data.readUInt32BE(tkhd.end - 4) / 65536;
    const version = data[mdhd.start];
    if (![0, 1].includes(version) || mdhd.end - mdhd.start < (version === 1 ? 32 : 20)) continue;
    const timescale = data.readUInt32BE(mdhd.start + (version === 1 ? 20 : 12));
    const ticks = version === 1 ? Number(data.readBigUInt64BE(mdhd.start + 24)) : data.readUInt32BE(mdhd.start + 16);
    const duration = ticks / timescale;
    if (width > 0 && height > 0 && Number.isFinite(duration) && duration > 0) return { width, height, duration };
  }
  throw new Error('MP4 lacks a valid video track');
}

async function downloadMp4(rawUrl, file) {
  let url = await checkedMediaUrl(rawUrl);
  for (let redirect = 0; redirect < 4; redirect++) {
    // curl honors the machine's HTTP proxy. Feed the signed URL through stdin
    // so it never appears in process arguments or gateway logs.
    const headerFile = `${file}.${randomUUID()}.headers`;
    const tempFile = `${file}.${randomUUID()}.download`;
    let status;
    try {
      await Promise.all([fs.writeFile(headerFile, '', { flag: 'wx', mode: 0o600 }),
        fs.writeFile(tempFile, '', { flag: 'wx', mode: 0o600 })]);
      status = await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/curl', [
          '--silent', '--show-error', '--max-time', '90', '--max-filesize', String(maxBytes),
          '--dump-header', headerFile, '--output', tempFile, '--write-out', '%{http_code}',
          '--config', '-',
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.resume(); // stderr can contain the signed URL; never log it.
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(Number(output.trim())) : reject(new Error(`Video download transport failed (${code})`)));
        child.stdin.end(`url = "${url.href.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`);
      });
      const headers = await fs.readFile(headerFile, 'utf8');
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = /^location:\s*(.+)\r?$/im.exec(headers)?.[1]?.trim();
        if (!location) throw new Error('Video redirect has no location');
        url = await checkedMediaUrl(new URL(location, url).href);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`Video download failed: HTTP ${status}`);
      const data = await fs.readFile(tempFile);
      if (data.length > maxBytes) throw new Error('Video exceeds download size limit');
      if (data.length < 32 || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Downloaded media is not an MP4');
      await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
      return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    } finally {
      await Promise.all([fs.rm(headerFile, { force: true }), fs.rm(tempFile, { force: true })]);
    }
  }
  throw new Error('Video exceeded redirect limit');
}

export async function inspectEnterpriseRun(conversationId, runId, { confirmedIds = [], deliveryRunId = null, fresh = false } = {}) {
  validId(conversationId, 'conversation_id');
  validId(runId, 'run_id');
  if (deliveryRunId) validId(deliveryRunId, 'delivery_run_id');
  const inspectedRunId = deliveryRunId || runId;
  return singleFlight(`inspect:${conversationId}:${inspectedRunId}:${confirmedIds.join(',')}:${fresh}`, () => withDoubaoClient(async client => {
    if (fresh) {
      const snapshot = await readTurn(client, conversationId, { runId, receipt: {}, deadline: Date.now() + 25_000 });
      return { status: snapshot.result.status, pending: snapshot.result.pending || [],
        videos: extractRunVideos(snapshot), reference_failure: extractReferenceFailure(snapshot),
        message: snapshot.result.progress || snapshot.result.reply?.text || '' };
    }
    const receipts = await receiptStore(client);
    const receipt = receipts.read(conversationId, inspectedRunId);
    if (acknowledgeLiveConfirmations(receipt, confirmedIds, messageBlocks)) receipts.save(receipt);
    const snapshot = await readLiveVideoTurn({ conversationId, runId: inspectedRunId, receipt,
      read: (id, options) => readTurn(client, id, options), wait: (id, options) => waitTurn(client, id, options),
      refresh: (id, options) => refreshTurn(client, id, { ...options, deadline: Date.now() + 2500, onReceipt: next => receipts.save(next) }),
      save: next => receipts.save(next), load: id => receipts.read(conversationId, id) });
    let mediaSnapshot = snapshot;
    if (deliveryRunId && snapshot.result.status === 'completed') {
      // The delivery continuation may render only a cloud page. Match its
      // successful upload against the immutable original run's MP4 attachment.
      const original = await readTurn(client, conversationId, { runId, receipt: receipts.read(conversationId, runId) });
      if (original.result.status !== 'completed') throw new Error('Original generation is not complete');
      mediaSnapshot = { messages: [...original.messages, ...snapshot.messages], nodes: [...original.nodes, ...snapshot.nodes] };
    }
    return { status: snapshot.result.status, pending: snapshot.result.pending || [],
      videos: extractRunVideos(mediaSnapshot), reference_failure: extractReferenceFailure(mediaSnapshot),
      message: snapshot.result.progress || snapshot.result.reply?.text || '' };
  }));
}

export function videoConfirmationOption(question) {
  const choices = (question?.options || []).filter(option =>
    typeof option.option_id === 'string' && option.option_id &&
    /^(按要求生成|立即生成|开始生成|确认生成|生成视频|继续生成|生成|继续)$/.test(String(option.label || '').trim()) &&
    !/支付|付费|收费|充值|购买|扣费/.test(`${option.label || ''} ${option.description || ''}`));
  return choices.length === 1 ? choices[0].option_id : null;
}

export function isEligibleVideoConfirmationAsk(ask, answeredIds = []) {
  const question = ask?.questions?.[0];
  if (!question) return false;
  if (!(ask?.status === 1 && !answeredIds.includes(ask.clarify_id) && ask.questions?.length === 1 &&
      ['confirm_video_gen', 'confirm_video_generate', 'confirm_video_generation', 'final_generation_confirm', 'confirm_generate_video', 'final_video_confirm', 'final_confirm_generate', 'final_generate_confirm', 'final_confirm_first_last_frame', 'confirm_generate', 'final_confirm_seedance25', 'confirm_generate_seedance_25', 'confirm_seedance_25_30s', 'confirm_seedance_gen'].includes(question.question_id) &&
      /确认|是否/.test(question.title || '') && /生成/.test(question.title || '') && /视频|参数/.test(question.title || '') &&
      !/支付|付费|收费|充值|购买|费用|扣费/.test(question.title || ''))) return false;
  return question.type === 3 && question.question_capability?.allow_text === true ||
    question.type === 1 && videoConfirmationOption(question) !== null;
}

export async function confirmEnterpriseVideoAsk(conversationId, runId, options = {}, answeredIds = [], beforeSubmit = async () => {}) {
  validId(conversationId, 'conversation_id');
  validId(runId, 'run_id');
  return withDoubaoClient(async client => {
    const receipts = await receiptStore(client);
    const snapshot = await readTurn(client, conversationId, { runId, receipt: receipts.read(conversationId, runId) });
    const asks = snapshot.messages.flatMap(messageBlocks)
      .map(block => block.content?.interaction_ask_block).filter(Boolean);
    const eligible = asks.filter(ask => isEligibleVideoConfirmationAsk(ask, answeredIds));
    if (eligible.length !== 1) return { confirmed: false, reason: asks.length ? 'requires_manual_input' : 'no_confirmation' };
    const ask = eligible[0];
    const q = ask.questions[0];
    const model = options.model || 'Seedance 2.0 Fast';
    const duration = Number(options.duration || 5);
    const ratio = options.ratio || '16:9';
    const modeText = { image_to_video: '、首帧图生', first_last_frame: '、首尾帧' }[options.mode] || '';
    const reply = `确认，仅按本次已授权参数生成1条 ${model}、${duration}秒、${ratio}${modeText} 视频。立即提交并等待可播放视频。生成完后必须将同一原始 MP4 上传到豆包云盘，交付云盘链接并再次交付这个原文件附件；不要重新生成。`;
    const answered = { ...ask, status: 2, questions: [{ ...q, answer: {
      status: 2, selected_option_ids: q.type === 1 ? [videoConfirmationOption(q)] : [],
      ...(q.question_capability?.allow_text === true ? { capability_answer: { text: reply } } : {}), question_id: q.question_id,
    } }] };
    await beforeSubmit(ask.clarify_id);
    const result = await client.evaluate(`(async () => {
      ${APP_MODULE_BOOTSTRAP}
      const req = await new Promise(resolve => window['@flow-web/desktop:stable'].push([['video_confirm_' + crypto.randomUUID()], {}, resolve]));
      const ask = ${JSON.stringify(answered)};
      const response = await appModule(req, 'skills').GE.AGWUploadAskHumanResult({
        ask_human_result: { tool_call_id: ask.clarify_id,
          InteractionAsk: { interaction_ask_block_json: JSON.stringify(ask) } },
      });
      return { code: response?.code, status_code: response?.status_code };
    })()`);
    if (result?.code !== 0) throw new Error('Doubao rejected the video confirmation');
    return { confirmed: true, clarifyId: ask.clarify_id };
  });
}

// Pass `state` from a fresh inspectEnterpriseRun() to skip a second CDP read;
// `onPhase` reports extracting/validating progress to the job store.
// Only a source matched to a successful cloud upload can be downloaded.
export async function recoverEnterpriseVideo(conversationId, runId, { state: known, onPhase = async () => {}, expect = null } = {}) {
  const state = known || await inspectEnterpriseRun(conversationId, runId);
  const { selected, delivery } = selectCloudVideos(state.videos);
  if (state.status !== 'completed' || !selected.length) {
    const error = state.status === 'completed' ? videoDiagnostic('cloud_video_missing', { submitted: true, retryable: true }) : null;
    return { conversationId, runId, status: state.status === 'completed' ? 'video_missing' : state.status,
      pending: state.pending, videos: [], delivery, error, message: error?.message || state.message };
  }
  await fs.mkdir(videoDir, { recursive: true, mode: 0o700 });
  await onPhase('extracting');
  const videos = [];
  for (const video of selected) {
    const id = createHash('sha256').update([conversationId, runId, video.messageId, video.creationId, video.vid].join(':')).digest('hex').slice(0, 32);
    const file = path.join(videoDir, `${id}.mp4`);
    let downloaded;
    try {
      const existing = await fs.readFile(file);
      if (existing.length < 32 || existing.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Stored video is not an MP4');
      downloaded = { bytes: existing.length, sha256: createHash('sha256').update(existing).digest('hex') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      downloaded = await downloadMp4(video.source, file);
    }
    await onPhase('validating');
    if (video.expectedBytes && downloaded.bytes !== video.expectedBytes) throw new Error('Downloaded MP4 size does not match the file block');
    const probe = probeMp4(await fs.readFile(file));
    if (video.width && (probe.width !== video.width || probe.height !== video.height || Math.abs(probe.duration - video.duration) > 1)) {
      throw new Error('Downloaded MP4 does not match the video block');
    }
    if (expect?.duration && (Math.abs(probe.duration - expect.duration) > 1.5 ||
      expect.ratio && !ratioMatches(probe.width, probe.height, expect.ratio))) {
      throw new Error('Cloud MP4 does not match the requested duration or ratio');
    }
    videos.push({ id, file, url: `/v1/videos/files/${id}`, width: probe.width,
      height: probe.height, duration: probe.duration, bytes: downloaded.bytes,
      sha256: downloaded.sha256, message_id: video.messageId, block_id: video.blockId,
      creation_id: video.creationId, vid: video.vid, source_kind: video.kind,
      source_verification: video.sourceVerification });
    await fs.writeFile(path.join(videoDir, `${id}.source.json`), JSON.stringify({
      id, source_kind: video.kind, source_verification: video.sourceVerification,
      bytes: downloaded.bytes, sha256: downloaded.sha256 }), { mode: 0o600 });
  }
  return { conversationId, runId, status: 'completed', videos, delivery, message: state.message };
}

const frameInstruction = {
  image_to_video: '附件图片（first_frame）是视频首帧，请以它为第一帧做图生视频。必须使用附件原图；若无法读取附件，请停止并明确说明，不能根据文字重绘图片来替代。',
  first_last_frame: '这是首尾帧视频：第一个附件（first_frame）是首帧，第二个附件（last_frame）是尾帧，请用首尾帧模式生成。必须使用两张附件原图；若无法读取附件，请停止并明确说明，不能根据文字重绘图片来替代。',
};

// `attachments` are local image paths in role order (first_frame, then last_frame).
export async function submitEnterpriseVideo(prompt, options = {}, attachments = [], hooks = {}) {
  const model = options.model || 'Seedance 2.0 Fast';
  const duration = Number(options.duration || 5);
  const ratio = options.ratio || '16:9';
  validateVideoDuration(model, duration);
  if (!/^\d{1,2}:\d{1,2}$/.test(ratio)) throw new Error('ratio must be like 16:9');
  const mode = options.mode || 'text_to_video';
  const roles = { text_to_video: 0, image_to_video: 1, first_last_frame: 2 }[mode];
  if (roles === undefined || attachments.length !== roles) throw new Error('attachments do not match the video mode');
  const instruction = `请调用 ${model} 生成一个${duration}秒、${ratio}的视频。${frameInstruction[mode] || ''}画面要求：${prompt}\n生成完后上传到豆包云盘交付附件链接。`;
  const result = await cdpExclusive(() => withChatClient(async client => {
    const started = Date.now(), timeoutMs = 120_000;
    let store;
    return performVideoSubmission(instruction, attachments, hooks, {
      upload: paths => uploadVideoAttachments(client, paths, { timeoutMs: 60_000 }),
      encode: files => nativeVideoAttachmentBlocks(client, files),
      context: async () => { const resolved = await resolveTaskContext(client, null, { runtime: 'cloud', project: 'none' }); store = await receiptStore(client); return resolved; },
      storeReceipt: receipt => store.save(receipt),
      send: (message, resolved, attachmentBlocks, onReceipt) => sendChatCompletion(client, {
        conversationId: null, message, model: modelProtocol('auto'), waitForReply: false,
        timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), ...resolved, attachmentBlocks, onReceipt,
      }),
      cleanup: snapshot => clearUploadedAttachments(client, snapshot),
      cleanupFiles: files => cleanupVideoUpload(client, files),
    });
  }));
  return { conversationId: result.conversationId, runId: result.runId, status: result.status,
    requestedModel: model, modelVerification: 'requested_only' };
}

// A single delivery-only continuation reuses the existing conversation/video.
// The job persists intent before calling this mutation; lost ACKs are not retried.
export async function requestEnterpriseCloudDelivery(conversationId) {
  validId(conversationId, 'conversation_id');
  const receipt = await cdpExclusive(() => sendMessage(conversationId,
    '上一次视频已经生成成功。这次只补交付：把本会话刚生成的同一个原始 MP4 文件上传到豆包云盘（企业账号可用飞书云盘），返回上传链接，并用 present_files 再次交付刚上传的同一个原始 MP4 附件，供本地网关核对路径和大小。严禁调用视频或图片生成工具，不得重绘、转码、修改或重新生成。如果原文件不存在或上传失败，请明确报错并停止。',
    { waitForReply: false, timeoutMs: 120_000 }));
  return { conversationId: receipt.conversationId, runId: receipt.runId };
}

export async function waitEnterpriseRun(conversationId, runId, timeoutMs = 540_000) {
  validId(conversationId, 'conversation_id');
  validId(runId, 'run_id');
  return cdpExclusive(() => waitConversation(conversationId, { runId, timeoutMs }));
}

export async function enterpriseVideoFile(id) {
  if (!/^(?:[0-9a-f-]{36}|[0-9a-f]{32})$/.test(String(id))) return null;
  const file = path.join(videoDir, `${id}.mp4`);
  try { await fs.access(file); return file; } catch { return null; }
}

export async function enterpriseVideoSource(id) {
  if (!/^[0-9a-f]{32}$/.test(String(id))) return null;
  try { return JSON.parse(await fs.readFile(path.join(videoDir, `${id}.source.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
