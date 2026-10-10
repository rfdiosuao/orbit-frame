import { createHash } from 'node:crypto';
import path from 'node:path';

const shortLink = /https:\/\/aka\.doubaocdn\.com\/s\/[A-Za-z0-9_-]{4,64}(?![A-Za-z0-9_\/-])/g;
const maxBytes = 100 * 1024 * 1024;

// Read literal paths from recorded tool output. Never execute its commands.
function fileArgument(command, flag, cwd = null) {
  const match = new RegExp(`(?:^|\\s)${flag}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s;&|<>]+))`).exec(command);
  const file = match && (match[1] || match[2] || match[3]);
  if(!file || !/\.mp4$/i.test(file) || /[\r\n`$\0]/.test(file) || !file.startsWith('/') && !cwd)return null;
  return path.posix.resolve(cwd || '/',file);
}

// Recognize only a literal optional cwd and read-only checks after curl.
// These strings are evidence; none are evaluated or executed.
function recordedCommands(raw) {
  if(typeof raw!=='string' || /[\r\n`$;|<>\0]/.test(raw))return null;
  const parts=raw.replace(/\\"/g,'"').trim().split(/\s+&&\s+/);let cwd=null;
  if(/^cd\s/.test(parts[0])) {
    const match=/^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))$/.exec(parts.shift());
    cwd=match && (match[1] || match[2] || match[3]);
    if(!cwd?.startsWith('/') || /[&]/.test(cwd))return null;
    cwd=path.posix.normalize(cwd);
  }
  if(!parts.length || parts.length>3)return null;
  return {parts,cwd};
}

function cloudUpload(operation) {
  const display = operation?.display_content;
  const commands=recordedCommands(display?.operation);
  if (!display || Number(display.exit_code) !== 0 || !commands || commands.parts.length!==1 || !/^lark-cli\s+drive\s+\+upload\s/.test(commands.parts[0])) return null;
  const file = fileArgument(commands.parts[0], '--file',commands.cwd);
  if (!file) return null;
  let result;
  try { result = typeof display.result === 'string' ? JSON.parse(display.result) : display.result; } catch { return null; }
  const data = result?.data, bytes = Number(data?.size);
  if (result?.ok !== true || !/\.mp4$/i.test(data?.file_name || '') || !Number.isSafeInteger(bytes) || bytes < 32 || bytes > maxBytes) return null;
  try {
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:[a-z0-9-]+\.)*feishu\.cn$/i.test(url.hostname) || !/^[A-Za-z0-9_-]+$/.test(data.file_token || '') ||
        url.pathname !== `/file/${data.file_token}`) return null;
    return { file, bytes, identity: createHash('sha256').update(url.origin + url.pathname).digest('hex').slice(0, 24) };
  } catch { return null; }
}

export function extractCloudVideos(entries) {
  const downloads = new Map(), files = new Map(), found = [];
  // Attachments may be rendered after the upload tool result in the same run.
  for (const { messageId, group = 'main', block } of entries) {
    const file = Number(block.block_type) === 10020 && block.content?.file_block;
    if (file?.type === 'mp4' && file.path && file.url && /\.mp4$/i.test(file.name || '') && Number(file.size) > 0)
      files.set(`${group}:${file.path}`, { file, messageId, blockId: String(block.block_id) });
  }
  for (const { messageId, group = 'main', block } of entries) {
    if (Number(block.block_type) === 10020) {
      const file = block.content?.file_block;
      if (file?.type === 'mp4' && file.path && file.url && /\.mp4$/i.test(file.name || '')) {
        files.set(`${group}:${file.path}`, { file, messageId, blockId: String(block.block_id) });
      }
    }
    if (Number(block.block_type) !== 10019) continue;
    const operation = block.content?.file_operation_block, display = operation?.display_content;
    if (!display || Number(display.exit_code) !== 0) continue;
    const commands=recordedCommands(display.operation);
    if (commands && /^(?:\/usr\/bin\/)?curl\s/.test(commands.parts[0])) {
      // Do not accept a compound command that could transform the downloaded file.
      const {parts,cwd}=commands;
      const file = fileArgument(parts[0], '(?:-o|--output)',cwd);
      const checks=parts.slice(1).every(part=>{
        const match=/^(?:ls\s+-(?:lh|la|l)|file)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))$/.exec(part);
        const arg=match && (match[1] || match[2] || match[3]);
        return arg && path.posix.resolve(cwd || '/',arg)===file;
      });
      if(!checks)continue;
      const links = [...parts[0].matchAll(shortLink)].map(match => match[0]);
      if (file && links.length === 1) downloads.set(`${group}:${file}`, { source: links[0], messageId, blockId: String(block.block_id) });
    }
    const upload = cloudUpload(operation);
    if (!upload) continue;
    const key = `${group}:${upload.file}`, download = downloads.get(key), attachment = files.get(key);
    // A matching preceding download identifies the exact bytes uploaded. A
    // matching attachment can supply those bytes when there was no curl step.
    const origin = download || attachment && Number(attachment.file.size) === upload.bytes && attachment;
    if (!origin) continue;
    found.push({ kind: download ? 'cloud_upload_original' : 'cloud_attachment',
      messageId: origin.messageId, blockId: origin.blockId, creationId: `cloud_${upload.identity}`, vid: '',
      source: download ? origin.source : origin.file.url, expectedBytes: upload.bytes,
      width: null, height: null, duration: null, sourceVerification: 'matched_upload_path_and_size' });
  }
  return found;
}

export function selectCloudVideos(videos = []) {
  const selected = videos.filter(video => ['cloud_upload_original', 'cloud_attachment'].includes(video.kind) &&
    video.sourceVerification === 'matched_upload_path_and_size');
  return { selected, delivery: { policy: 'cloud_only', selected_count: selected.length,
    source_counts: { video_card: videos.filter(video => video.kind === 'creation').length,
      attachment: videos.filter(video => video.kind === 'file').length,
      text_link: videos.filter(video => video.kind === 'link').length, cloud_video: selected.length },
    candidate_count: videos.length } };
}
