// User-selected assets participate in undo. Completed generation results and
// submitted video inputs must survive unrelated edits and undo operations.
export const canvasRuntimeFields=['status','input_frames','image_phase','image_started_at','task_id','request_key','error','image_job'];
export function runtimeFields(card) {
  const fields=card?.type==='video' && (card.task_id || card.request_key)
    ? [...canvasRuntimeFields,'prompt','model','duration','ratio'] : canvasRuntimeFields;
  return Object.fromEntries(fields.filter(key=>card && key in card).map(key=>[key,card[key]]));
}
export function restoreHistoryCard(snapshot,current,archived={}) {
  const result={...snapshot,...(current?runtimeFields(current):archived)};
  if(result.type==='image' && !snapshot.asset && current?.asset?.source_task_id) {
    result.asset=current.asset;result.assets=current.assets;
  }
  return result;
}
