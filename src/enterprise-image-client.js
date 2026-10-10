import { createConversation } from 'doubao-cli/src/automation.mjs';
import { readTurn, refreshTurn, waitTurn, receiptStore, messageBlocks } from 'doubao-cli/src/turns.mjs';
import { withDoubaoClient } from './enterprise-video-client.js';
import { readLiveVideoTurn } from './video-live-turn.js';
import { extractReferenceFailure } from './reference-failure.js';
import { cancelEnterpriseRun } from './task-cancellation.js';

const host = /^(?:[a-z0-9-]+\.)*(?:byteimg\.com|doubaocdn\.com)$/i;
function imageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && host.test(url.hostname) ? url.href : null; }
  catch { return null; }
}
export function extractRunImages(snapshot) {
  const cards = [], generated = [], originals = [];
  for (const message of [...(snapshot.messages || []), ...(snapshot.nodes || []).flatMap(n => n.messages || [])]) {
    if (Number(message.user_type) !== 2) continue;
    for (const block of messageBlocks(message)) {
      if (Number(block.block_type) === 10084) for (const media of block.content?.rich_media_layout_block?.media || []) {
        const creation = media.creation, image = creation?.image;
        if (Number(creation?.type) !== 1 || Number(image?.status) !== 2) continue;
        const variants = [image.image_ori_raw, image.image_ori, image.image_preview].filter(v => v?.url).sort((a, b) => Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0));
        const url = variants.map(v => imageUrl(v.url)).find(Boolean);
        if (url) cards.push(url);
      }
      if (Number(block.block_type) === 10019) {
        const display = block.content?.file_operation_block?.display_content;
        const command = display?.operation || '';
        if (Number(display?.exit_code) === 0 && /(?:^|\s)curl\s/.test(command) && /(?:-o|--output)\s+(?:"[^"]+\.(?:png|jpe?g|webp)"|'[^']+\.(?:png|jpe?g|webp)'|[^\s;&|<>]+\.(?:png|jpe?g|webp))(?:\s|$)/i.test(command)) {
          const links = [...command.matchAll(/https:\/\/[^\s"'<>]+/g)].map(m => imageUrl(m[0])).filter(Boolean);
          if (links.length === 1) originals.push(links[0]);
        }
      }
      if (Number(block.block_type) === 10010) for (const image of block.content?.gen_image_block?.images || []) {
        const url = imageUrl(image.full_size_url?.[0] || image.uri);
        if (url) generated.push(url);
      }
    }
  }
  // A generation may be represented twice, once in the tool and once as a card.
  return [...new Set(cards.length ? cards : generated.length && originals.length ? originals : generated)].slice(0, 8);
}
export async function inspectEnterpriseImage(conversationId, runId) {
  if (![conversationId, runId].every(id => /^\d{12,24}$/.test(String(id)))) throw new Error('Invalid image run');
  return withDoubaoClient(async client => {
    const store = await receiptStore(client), receipt = store.read(conversationId, runId);
    const snapshot = await readLiveVideoTurn({ conversationId, runId, receipt,
      read: (id, options) => readTurn(client, id, options), wait: (id, options) => waitTurn(client, id, options),
      refresh: (id, options) => refreshTurn(client, id, { ...options, deadline: Date.now() + 2500, onReceipt: r => store.save(r) }),
      save: r => store.save(r), load: id => store.read(conversationId, id) });
    return { status: snapshot.result.status, images: extractRunImages(snapshot), reference_failure: extractReferenceFailure(snapshot) };
  });
}
export async function generateEnterpriseImage(body, { onReceipt = async () => {}, onPhase = async () => {}, receipt: known, signal } = {}) {
  let receipt = known;
  if (!receipt) {
    try {
      receipt = await withDoubaoClient(() => createConversation(
        `请调用 ${body.model || 'Seedream 4.5'} ${body.reference_files?.length ? '基于附件原图做图生图编辑，保留未要求修改的角色身份、服装和场景。若不能读取附件原图，请停止并明确报错，不得自行重绘冒充参考图编辑。' : '生成一张图片'}，画面比例 ${body.ratio || '1:1'}。画面要求：${body.prompt}\n请交付真实生成的图片附件。`,
        { runtime: 'cloud', project: 'none', waitForReply: false, timeoutMs: 120_000, ...(body.reference_files?.length ? {attachments:body.reference_files} : {}) }));
    } catch {
      throw Object.assign(new Error('图片提交结果未确认。请在豆包查看本次会话；不会自动重发生成。'), { uncertain: true });
    }
  }
  await onReceipt(receipt); await onPhase('generating');
  const deadline = Date.now() + 600_000;
  let failures = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('已停止本地等待；上游取消状态请查询原任务'),{uncertain:true});
    let state;
    try { state = await inspectEnterpriseImage(receipt.conversationId, receipt.runId); failures = 0; }
    catch { if (++failures >= 3) throw Object.assign(new Error('图片任务已提交，客户端读取暂时失败。可查询原任务恢复，不要重复生成。'), { uncertain: true }); }
    if (body.reference_files?.length && state?.reference_failure) {
      let cancellation;
      if (!['completed','failed','cancelled'].includes(state.status)) {
        try { cancellation=await cancelEnterpriseRun(receipt.conversationId,receipt.runId); }
        catch { cancellation={state:'unknown',confirmed:false,accepted:false}; }
      }
      throw Object.assign(new Error('豆包明确报告原图无法读取，不接受重绘图片作为参考图编辑结果。'), { upstream_status: 'failed', reference_failure: state.reference_failure, cancellation });
    }
    if (state?.status === 'completed') {
      if (!state.images.length) throw new Error('豆包已完成，但未返回可下载的图片附件。');
      await onPhase('downloading'); return { images: state.images };
    }
    if (['failed', 'cancelled', 'waiting_input'].includes(state?.status)) throw Object.assign(new Error('豆包图片任务需要处理，请先在客户端查看原会话。'), { uncertain: state.status === 'waiting_input', upstream_status:state.status });
    await new Promise(r => setTimeout(r, 3000));
  }
  throw Object.assign(new Error('图片等待超时，可查询原任务继续恢复。'), { uncertain: true });
}
