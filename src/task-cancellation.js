import { stopTurn, readTurn, receiptStore } from 'doubao-cli/src/turns.mjs';
import { withDoubaoClient } from './enterprise-video-client.js';

export async function cancelEnterpriseRun(conversationId, runId) {
  if (![conversationId,runId].every(id => /^\d{12,24}$/.test(String(id)))) return {state:'unknown',accepted:false,confirmed:false};
  return withDoubaoClient(async client => {
    const store=await receiptStore(client),receipt=store.read(conversationId,runId);
    const before=await readTurn(client,conversationId,{runId,receipt,deadline:Date.now()+5000});
    if (['completed','failed','cancelled'].includes(before.result.status) && !before.result.tasks?.running && !before.result.tasks?.unknown) return {state:before.result.status === 'completed' ? 'already_completed' : before.result.status,accepted:false,confirmed:true};
    const result=await stopTurn(client,conversationId,{runId,receipt,timeoutMs:15000,onReceipt:r=>store.save(r)});
    const saved=store.read(conversationId,runId);
    return {state:result.stopped && result.status === 'cancelled' ? 'cancelled' : 'unknown',accepted:!!saved?.cancellation?.accepted,confirmed:result.stopped === true && result.status === 'cancelled'};
  });
}
