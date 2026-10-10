import { uploadAttachmentsFromClient, resolveAttachmentFiles, clearUploadedAttachments, uploadedAttachmentBlocks } from 'doubao-cli/src/attachments.mjs';
import { APP_MODULE_BOOTSTRAP } from 'doubao-cli/src/app-modules.mjs';
const uploadChat = Symbol('original_upload_chat');
export const videoAttachmentUploadPolicy = 'native_attachment_encoder_v1';

// Read the same official attachment store used by uploadedAttachmentBlocks.
// Return only metadata needed to identify this invocation's owned local keys.
export async function videoAttachmentState(client) {
  return client.evaluate(`(async()=>{${APP_MODULE_BOOTSTRAP}
    const req=await new Promise(resolve=>window['@flow-web/desktop:stable'].push([['video_upload_scope_'+Date.now()],{},resolve]));
    const chatId=appModule(req,'stores').Wp('chatViewCoreStore').getState().currentChatViewConfig?.chatId;
    const map=appModule(req,'stores').Wp('attachmentsStore').getState().attachmentsMap?.[chatId]||{};
    return {chat_id:chatId,dom_count:document.querySelectorAll('[data-testid="attachment_area"] [data-testid="attachment_file_item"]').length+
      [...document.querySelectorAll('[data-testid="attachment_area"] [data-testid="mdbox_image"]')].filter(x=>!x.closest('[data-testid="attachment_file_item"]')).length,
      groups:Object.entries(map).filter(([,items])=>items?.length).map(([group,items])=>({params:{chatId,skillType:group.slice(1)},
        items:items.map(a=>({name:a.fileName||a.file?.name,size:Number(a.file?.size??a.size),localKey:a.localKey}))}))};})()`);
}

export function scopedCleanupSnapshots(state, files) {
  const matches = state.groups.flatMap(g => g.items.filter(a => files.some(f => f.name === a.name && f.size === a.size))
    .map(a => ({ params: g.params, item: a })));
  if (matches.length > files.length || matches.some(m => !m.item.localKey) || files.some(f => matches.filter(m => m.item.name === f.name && m.item.size === f.size).length > 1)) return [];
  return matches.map(m => ({ params: m.params, localKeys: [m.item.localKey] }));
}

export async function nativeAttachmentWaitState(dom, files, encode, chatId) {
  // A loaded thumbnail is not evidence that the original file is available.
  // Conversely a broken preview must not hold a fully uploaded original for
  // 60 seconds. Use the SDK's official, identity-checked wire encoder.
  if (dom.progressing || /失败|不支持|超出|error|failed/i.test(dom.status || '')) return dom;
  const pending = { ...dom, files: dom.files.map(f => ({ ...f, available: false })),
    images: dom.images.map(i => ({ ...i, loaded: false })) };
  let snapshot;
  try { snapshot = await encode(files); } catch { return pending; }
  const count = snapshot?.blocks?.reduce((n, b) => n + (b.content?.attachment_block?.attachments?.length || 0), 0);
  if (count !== files.length || snapshot?.params?.chatId !== chatId || snapshot?.localKeys?.length !== files.length ||
      snapshot.localKeys.some(k => typeof k !== 'string' || !k) || new Set(snapshot.localKeys).size !== files.length) return pending;
  return { ...dom, files: files.filter(f => !f.type.startsWith('image/')).map(() => ({ available: true })),
    images: files.filter(f => f.type.startsWith('image/')).map(() => ({ loaded: true })), progressing: false };
}

export async function nativeVideoAttachmentBlocks(client, files) {
  const snapshot = await uploadedAttachmentBlocks(client, files);
  if (snapshot.localKeys.length !== files.length || snapshot.localKeys.some(k => !k) || new Set(snapshot.localKeys).size !== files.length) {
    throw new Error('Cannot identify the staged attachments safely');
  }
  const types = await client.evaluate(`(async()=>{${APP_MODULE_BOOTSTRAP}
    const req=await new Promise(resolve=>window['@flow-web/desktop:stable'].push([['video_attachment_types_'+Date.now()],{},resolve]));
    const params=${JSON.stringify(snapshot.params)},keys=${JSON.stringify(snapshot.localKeys)};
    const items=appModule(req,'attachments').getAttachments(params);
    return keys.map(k=>items.find(a=>a.localKey===k)?.type);})()`);
  if (!Array.isArray(types) || types.length !== files.length || types.some((type, i) => type !== (files[i].type.startsWith('image/') ? 'image' : 'file'))) {
    throw new Error('Composer attachments changed; nothing was sent');
  }
  return snapshot;
}

export function scopedUploadClient(client, { onPoll, readyState } = {}) {
  return { evaluate: expression => {
    // The SDK timeout handler clears every composer attachment. Suppress that
    // unscoped operation; our cleanup uses only matching keys added to an empty
    // draft by this invocation and never clicks the user's delete buttons.
    if (expression.includes('delete-btn-') && expression.includes("new MouseEvent('click'")) {
      throw Object.assign(new Error('Unscoped attachment cleanup is blocked'), { code: 'attachment_cleanup_unscoped' });
    }
    const result = client.evaluate(expression);
    return (onPoll || readyState) && expression.includes('progressing:')
      ? result.then(async state => { await onPoll?.(state); return readyState ? readyState(state) : state; }) : result;
  } };
}

export async function cleanupVideoUpload(client, files) {
  const after = await videoAttachmentState(client);
  if (files[uploadChat] !== after.chat_id) return 'changed_chat_preserved';
  const snapshots = scopedCleanupSnapshots(after, files);
  for (const snapshot of snapshots) await clearUploadedAttachments(client, snapshot);
  return snapshots.length ? 'owned_keys_removed' : after.groups.some(g => g.items.length) ? 'ambiguous_preserved' : 'nothing_staged';
}

export async function uploadVideoAttachments(client, paths, { timeoutMs = 60000, onCleanup = () => {}, onPoll } = {}) {
  const files = await resolveAttachmentFiles(paths);
  const before = await videoAttachmentState(client);
  if (before.dom_count || before.groups.some(g => g.items.length)) throw Object.assign(
    new Error('Doubao composer already contains draft attachments'), { code: 'attachment_draft_present' });
  files[uploadChat] = before.chat_id;
  try {
    const uploaded = await uploadAttachmentsFromClient(scopedUploadClient(client, { onPoll,
      readyState: state => nativeAttachmentWaitState(state, files, f => nativeVideoAttachmentBlocks(client, f), before.chat_id),
    }), paths, { timeoutMs });
    uploaded[uploadChat] = before.chat_id;
    return uploaded;
  }
  catch (error) {
    let status = 'unavailable';
    try {
      status = await cleanupVideoUpload(client, files);
    } catch { status = 'cleanup_unavailable_preserved'; }
    onCleanup(status);
    throw error;
  }
}
