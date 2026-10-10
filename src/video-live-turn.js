// Reconnect the existing accepted stream; callers do not provide a send API.
export function acknowledgeLiveConfirmations(receipt, ids, blocks) {
  let changed = false;
  for (const message of receipt.liveMessages || []) for (const block of blocks(message)) {
    const ask = block.content?.interaction_ask_block;
    if (ask?.status === 1 && ids.includes(ask.clarify_id)) { ask.status = 2; changed = true; }
  }
  return changed;
}

export async function readLiveVideoTurn({ read, refresh = read, wait, save, load, receipt, conversationId, runId }) {
  let snapshot = await refresh(conversationId, { runId, receipt });
  if (['running', 'unknown'].includes(snapshot.result.status) && !receipt.handoffs?.length) {
    try {
      await wait(conversationId, { runId, receipt, timeoutMs: 1500, onReceipt: save, loadReceipt: load });
    } catch (error) { if (error.code !== 'timeout') throw error; }
    snapshot = await read(conversationId, { runId, receipt });
  } else if (snapshot.result.status === 'waiting_input') {
    // Refresh reconciles answered live cards in the receipt. Read once more
    // so a stale confirmation cannot keep the accepted generation paused.
    snapshot = await read(conversationId, { runId, receipt });
  }
  return snapshot;
}
