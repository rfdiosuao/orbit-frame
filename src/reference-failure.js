import { messageBlocks } from 'doubao-cli/src/turns.mjs';

// This is a conservative rejection signal, not proof that a successful reply
// actually used the reference. Never inspect the user's instructions as a claim.
export function extractReferenceFailure(snapshot) {
  const messages = [...(snapshot.messages || []), ...(snapshot.nodes || []).flatMap(node => node.messages || [])];
  for (const message of messages) {
    if (Number(message.user_type) !== 2) continue;
    for (const block of messageBlocks(message)) {
      if (Number(block.block_type) !== 10000) continue;
      for (const sentence of String(block.content?.text_block?.text || '').split(/[。！？!\n]/)) {
        if (/(?:如果|假如|若|一旦|if\b).{0,24}(?:无法|不能|未能|读不到|can't|cannot|unable)/i.test(sentence)) continue;
        // The URL access route failed, while the original local frame remains
        // available for upload. Do not treat this narrowly described recovery
        // as an unreadable original. Other failure sentences still reject it.
        if (/^\s*附件\s*(?:URL|链接|地址)\s*(?:无法|不能)(?:被视频服务)?(?:直接)?(?:访问|读取)[，,]\s*(?:我先|改为|将|已)(?:重新)?(?:上传本地(?:首帧|尾帧|原图)(?:图片)?|把本地(?:首帧|尾帧|原图)(?:图|图片)?上传)获取可用链接\s*$/i.test(sentence)) continue;
        const failure = /(?:无法|不能|未能|没能|读不到).{0,16}(?:读取|访问|下载|打开|加载|获取|查看|使用).{0,36}(?:附件|上传.{0,12}(?:图|文件)|原图|图片|首帧|尾帧)/.test(sentence) ||
          /(?:读不到|访问不了|打不开|找不到).{0,24}(?:附件|原图|上传.{0,12}(?:图|文件)|首帧|尾帧)/.test(sentence) ||
          /(?:附件|上传.{0,12}(?:图|文件)|原图|首帧|尾帧).{0,36}(?:读取失败|访问失败|读不到|无法读取|无法访问|不可访问|找不到|不存在|已过期|链接失效)/.test(sentence) ||
          /(?:can't|cannot|unable to|failed to).{0,16}(?:read|access|open|load|download).{0,36}(?:attachment|reference image|uploaded image|first frame|last frame)/i.test(sentence);
        if (failure) return { code: 'reference_unreadable', message_id: String(message.message_id || ''), block_id: String(block.block_id || '') };
      }
    }
  }
  return null;
}
