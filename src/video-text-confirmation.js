// Only a final assistant parameter summary for the accepted turn is eligible.
export function textVideoConfirmation(snapshot, options, blocks) {
  if (snapshot?.result?.status !== 'completed' || snapshot.result.tasks?.total || snapshot.result.artifacts?.length) return null;
  const message = snapshot.messages?.filter(m => m.user_type === 2).at(-1);
  const text = (message ? blocks(message) : []).filter(b => !b.parent_id && b.content?.text_block)
    .map(b => b.content.text_block.text || '').join('\n').replace(/\*\*/g, '');
  if (!/请确认[\s\S]*视频[\s\S]*参数/.test(text) || !/确认后[\s\S]{0,20}(?:开始|再|继续)[\s\S]{0,10}生成/.test(text) ||
      /支付|付费|收费|充值|购买|费用|扣费|已生成|生成成功/.test(text)) return null;
  const model = text.match(/模型\s*[：:]\s*([^\n]+)/)?.[1]?.trim();
  const duration = text.match(/时长\s*[：:]\s*(\d+)\s*秒/)?.[1];
  const ratio = text.match(/比例\s*[：:]\s*(\d+\s*:\s*\d+)/)?.[1]?.replace(/\s/g, '');
  if (model !== options.model || Number(duration) !== Number(options.duration) || ratio !== options.ratio) return null;
  return { id: `text:${snapshot.result.runId}:${message.message_id}`, messageId: message.message_id };
}

export function isManualVideoConfirmation(snapshot, originalRunId, blocks) {
  const users = (snapshot.conversation?.messages || []).filter(m => m.user_type === 1)
    .sort((a,b) => Number(a.index_in_conv) - Number(b.index_in_conv));
  if (String(users.at(-2)?.message_id) !== originalRunId || String(users.at(-1)?.message_id) !== snapshot.result.runId) return false;
  const text = blocks(snapshot.root).map(b => b.content?.text_block?.text || '').join('\n').trim();
  return /^(?:确认|确认生成|按以上参数生成)[。！!\s]*$/.test(text);
}
