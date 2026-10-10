// Only a final assistant parameter summary for the accepted turn is eligible.
export function textVideoConfirmation(snapshot, options, blocks) {
  if (snapshot?.result?.status !== 'completed' || snapshot.result.tasks?.total || snapshot.result.artifacts?.length) return null;
  const message = snapshot.messages?.filter(m => m.user_type === 2).at(-1);
  const text = (message ? blocks(message) : []).filter(b => !b.parent_id && b.content?.text_block)
    .map(b => b.content.text_block.text || '').join('\n').replace(/```[\s\S]*?```/g, '').replace(/\*\*|`/g, '');
  const asks = /视频|Seedance/i.test(text) && /(?:请.{0,8}确认|生成前.{0,16}确认|等待.{0,8}确认|待你.{0,8}确认|是否按以上[^\n？?]{0,180}生成)/.test(text);
  if (!asks || /(?:已|已经)生成(?:完|成功|视频)|视频(?:已|已经)生成|生成成功/.test(text)) return null;
  const model = text.match(/模型\s*[：:]\s*([^\n]+)/)?.[1]?.trim().replace(/\s*[（(]固定(?:[，,]\s*不切换)?[）)]\s*$/, '');
  const duration = text.match(/时长\s*[：:]\s*(\d+)\s*秒/)?.[1];
  const ratio = text.match(/比例\s*[：:]\s*(\d+\s*:\s*\d+)/)?.[1]?.replace(/\s/g, '');
  const canonicalModel = value => ({ 'seedance_2.5': 'Seedance 2.5', 'seedance_2.0_fast': 'Seedance 2.0 Fast' }[value?.toLowerCase()] || value);
  const eligible = !/支付|付费|收费|充值|购买|费用|扣费/.test(text) &&
    canonicalModel(model) === options.model && Number(duration) === Number(options.duration) && ratio === options.ratio;
  // Recognizing a question and authorizing its answer are separate. A changed
  // parameter still waits for the user; it is never an already generated video.
  return { id: `text:${snapshot.result.runId}:${message.message_id}`, messageId: message.message_id, eligible };
}

export function isManualVideoConfirmation(snapshot, originalRunId, blocks) {
  const users = (snapshot.conversation?.messages || []).filter(m => m.user_type === 1)
    .sort((a,b) => Number(a.index_in_conv) - Number(b.index_in_conv));
  if (String(users.at(-2)?.message_id) !== originalRunId || String(users.at(-1)?.message_id) !== snapshot.result.runId) return false;
  const text = blocks(snapshot.root).map(b => b.content?.text_block?.text || '').join('\n').trim();
  return /^(?:确认|确认生成|按以上参数生成)[。！!\s]*$/.test(text);
}
