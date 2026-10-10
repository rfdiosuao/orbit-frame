import { randomUUID, createHash } from 'node:crypto';
import { mutateCanvas } from './canvas-store.js';
import { readFrames } from './video-frames.js';
import { validateVideoDuration } from './video-models.js';
import { videoPrompt } from '../public/canvas-video-inputs.js';

const invalid = message => Object.assign(new Error(message), { invalid: true, submitted: false });
const uid = () => 'c' + randomUUID().replaceAll('-', '').slice(0, 15);
const frameRoles = ['first_frame', 'last_frame'];

export function sceneInput(doc, card) {
  const images = Object.fromEntries(frameRoles.map(role => {
    const edge = doc.edges.find(e => e.to === card.id && e.role === role);
    const asset = card.request_key ? card.input_frames?.find(f => f.role === role)?.asset
      : doc.cards.find(c => c.id === edge?.from)?.asset;
    return [role, asset || null];
  }));
  const mode = images.last_frame ? 'first_last_frame' : images.first_frame ? 'image_to_video' : 'text_to_video';
  const prompt = videoPrompt(card, doc.cards, doc.edges);
  const missing = [];
  if (!prompt.trim()) missing.push('prompt');
  if (images.last_frame && !images.first_frame) missing.push('first_frame');
  if (!card.request_key) for (const role of frameRoles) {
    if (doc.edges.some(e => e.to === card.id && e.role === role) && !images[role]) missing.push(role);
  }
  return { card_id: card.id, prompt, model: card.model, duration: card.duration, ratio: card.ratio,
    mode, ...images, task_id: card.task_id || null, request_key: card.request_key || null,
    editable: !card.task_id && !card.request_key, missing: [...new Set(missing)] };
}

export function canvasSceneSummary(doc) {
  return { canvas_id: doc.id, title: doc.title, version: doc.version,
    scenes: doc.cards.filter(c => c.type === 'video').map(card => sceneInput(doc, card)),
    images: doc.cards.filter(c => c.type === 'image' && c.asset).map(c => ({ card_id: c.id, ...c.asset })),
    notes: doc.cards.filter(c => c.type === 'note').map(c => ({ card_id: c.id, text: c.text })) };
}

// Adding/updating a scene assigns roles and positions in one operation; an
// agent does not need to calculate coordinates or drag connector handles.
export async function composeVideoScene(id, args) {
  const frames = await readFrames(args.last_frame ? 'first_last_frame' : args.first_frame ? 'image_to_video' : 'text_to_video', args);
  const prompt = String(args.prompt || '').trim();
  if (!prompt || prompt.length > 20000) throw invalid('prompt must be 1 to 20000 characters');
  const model = args.model || 'Seedance 2.0 Fast', duration = Number(args.duration ?? 5), ratio = args.ratio || '16:9';
  const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, model, duration, ratio, frames: frames.map(frame => [frame.role, frame.sha256]) })).digest('hex');
  try { validateVideoDuration(model, duration); } catch (error) { throw invalid(error.message); }
  let cardId;
  const saved = await mutateCanvas(id, doc => {
    if (args.idempotency_key) {
      const existing = doc.cards.find(card => card.compose_key === args.idempotency_key);
      if (existing) {
        if (existing.compose_fingerprint !== fingerprint) throw invalid('同一镜头准备编号不能用于不同输入');
        cardId = existing.id; return doc;
      }
    }
    let video = args.card_id && doc.cards.find(c => c.id === args.card_id && c.type === 'video');
    if (args.card_id && !video) throw invalid('Video card does not exist');
    if (video?.task_id || video?.request_key) throw invalid('Submitted scene is frozen; create a new scene instead');
    if (!video) {
      const bottom = Math.max(0, ...doc.cards.map(c => c.y + 760));
      video = { id: uid(), type: 'video', x: 740, y: bottom, prompt, model, duration, ratio };
      doc.cards.push(video);
    }
    cardId = video.id;
    Object.assign(video, { prompt, model, duration, ratio, error: '', input_frames: [], compose_key: args.idempotency_key || null, compose_fingerprint: args.idempotency_key ? fingerprint : null });
    const old = Object.fromEntries(['prompt', ...frameRoles].map(role => {
      const edge = doc.edges.find(e => e.to === video.id && e.role === role);
      const source = doc.cards.find(c => c.id === edge?.from);
      const exclusive = source && !doc.edges.some(e => e.from === source.id && e.to !== video.id);
      return [role, exclusive && (role === 'prompt' || source.frame_owner === video.id && source.status !== 'generating') ? source : null];
    }));
    // Reuse this draft scene's own inputs; a shared source remains unchanged.
    doc.edges = doc.edges.filter(e => e.to !== video.id || !['prompt', ...frameRoles].includes(e.role));
    const note = old.prompt || { id: uid(), type: 'note', x: video.x - 740, y: video.y };
    note.text = prompt;
    if (!old.prompt) doc.cards.push(note);
    doc.edges.push({ id: uid(), from: note.id, to: video.id, role: 'prompt' });
    for (const frame of frames) {
      const spec = args[frame.role], mediaPath = typeof spec === 'string' ? spec : spec.path;
      // Uploaded assets have relative library paths; no arbitrary path is
      // persisted into the canvas or exposed through a preview URL.
      if (!/^(uploads|generated)\/[\w.-]+$/.test(mediaPath)) throw invalid('Scene frames must be uploaded library assets');
      const image = { ...(old[frame.role] || {}), id: old[frame.role]?.id || uid(), type: 'image', x: video.x - 400, y: video.y + (frame.role === 'last_frame' ? 380 : 0),
        prompt: '', status: 'ready', ratio, frame_owner: video.id, image_job: null, image_phase: null, error: '',
        asset: { ...(typeof spec === 'object' ? spec : {}), asset_id: `sha256:${frame.sha256}`, sha256: frame.sha256, bytes: frame.bytes, path: mediaPath, name: spec.name || frame.role, width: frame.width, height: frame.height,
          preview_url: mediaPath.startsWith('uploads/') ? `/v1/videos/frames/${mediaPath.split('/')[1]}` : `/v1/media/${mediaPath}` } };
      image.assets = [image.asset];
      if (old[frame.role]) doc.cards = doc.cards.map(c => c.id === image.id ? image : c);
      else doc.cards.push(image);
      doc.edges.push({ id: uid(), from: image.id, to: video.id, role: frame.role });
    }
    for (const role of frameRoles) if (old[role] && !frames.some(f => f.role === role)) doc.cards = doc.cards.filter(c => c.id !== old[role].id);
    doc.viewport = { x: 30, y: 40 - video.y * 0.85, zoom: 0.85 };
    return doc;
  });
  return saved ? { ...canvasSceneSummary(saved), card_id: cardId } : null;
}

// Persist the key and immutable inputs before the upstream mutation. Both
// simultaneous agent calls reuse the same request, even after a lost response.
export async function reserveVideoScene(id, cardId) {
  let input;
  const saved = await mutateCanvas(id, async doc => {
    const card = doc.cards.find(c => c.id === cardId && c.type === 'video');
    if (!card) throw invalid('Video card does not exist');
    input = sceneInput(doc, card);
    if (input.missing.length) throw invalid(`Scene needs: ${input.missing.join(', ')}`);
    await readFrames(input.mode, Object.fromEntries(frameRoles.filter(r => input[r]).map(r => [r, input[r]])));
    if (!card.request_key) {
      card.prompt = input.prompt;
      card.input_frames = frameRoles.filter(r => input[r]).map(role => ({ role, asset: structuredClone(input[role]) }));
      card.request_key = randomUUID();
    }
    input.idempotency_key = card.request_key;
    card.task_id ||= createHash('sha256').update(`doubao-desktop:${card.request_key}`).digest('hex');
    input.task_id = card.task_id;
    return doc;
  });
  return saved ? input : null;
}

export async function releaseRejectedScene(id, cardId, key) {
  return mutateCanvas(id, doc => {
    const card = doc.cards.find(c => c.id === cardId);
    if (card?.request_key === key) { card.request_key = null; card.task_id = null; card.input_frames = []; }
    return doc;
  });
}
