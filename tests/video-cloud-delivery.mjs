import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractRunVideos, recoverEnterpriseVideo } from '../src/enterprise-video-client.js';
import { extractCloudVideos, selectCloudVideos } from '../src/video-delivery.js';
import { isCloudVideo, needsCloudExtraction } from '../public/video-task-state.js';

const file = '/home/user/Doubao/chats/123/result.mp4';
const link = 'https://aka.doubaocdn.com/s/cloud123';
const operation = (command, result = '', exit_code = 0) => ({ block_type: 10019, block_id: command.slice(0, 8), content: { file_operation_block: { display_content: { operation: command, result, exit_code } } } });
const curl = () => operation(`curl -L -o ${file} "${link}" && ls -lh ${file}`);
const upload = (overrides = {}, command = `lark-cli drive +upload --file ${file} --name "result.mp4"`, exit = 0) => operation(command, JSON.stringify({ ok: true, data: { file_name: 'result.mp4', file_token: 'test_token', size: 12345, url: 'https://larkcommunity.feishu.cn/file/test_token', ...overrides } }), exit);
const card = { block_type: 10084, block_id: 'card', content: { rich_media_layout_block: { media: [{ creation: { id: 'card', type: 2, video: { status: 3, video_type: 'mp4', width: 1280, height: 720, duration: 5, download_url: 'https://v9-default.douyin.com/card' } } }] } } };
const snapshot = blocks => ({ messages: [{ user_type: 2, message_id: '123456789012', content_block: blocks }], nodes: [] });
const entries = blocks => blocks.map(block => ({ block, messageId: '123', group: 'main' }));

test('matches observed cwd-relative curl and cloud upload without allowing transformations',()=>{
  const download=operation(`cd /home/user/Doubao/chats/123 && curl -L -o result.mp4 "${link}" && ls -la result.mp4 && file result.mp4`);
  const uploaded=upload({},'cd /home/user/Doubao/chats/123 && lark-cli drive +upload --file ./result.mp4 --name "result.mp4" --format json');
  assert.equal(extractCloudVideos(entries([download,uploaded]))[0]?.source,link);
  for(const command of [`cd /other && lark-cli drive +upload --file ./result.mp4`, `cd /home/user/Doubao/chats/123 && lark-cli drive +upload --file ./result.mp4 && rm result.mp4`])assert.deepEqual(extractCloudVideos(entries([download,upload({},command)])),[]);
  for(const command of [`cd /home/user/Doubao/chats/123 && curl -L -o result.mp4 "${link}" && ffmpeg -i result.mp4 edited.mp4`,`cd /home/user/Doubao/chats/123 && curl -L -o result.mp4 "${link}" && file /other.mp4`])assert.deepEqual(extractCloudVideos(entries([operation(command),uploaded])),[]);
});

test('keeps card plus verified cloud original, but downloads only the cloud source', () => {
  const videos = extractRunVideos(snapshot([card, curl(), upload()]));
  const { selected, delivery } = selectCloudVideos(videos);
  assert.equal(videos.length, 2); assert.equal(selected.length, 1);
  assert.equal(selected[0].source, link); assert.equal(selected[0].expectedBytes, 12345);
  assert.equal(delivery.source_counts.video_card, 1); assert.equal(delivery.policy, 'cloud_only');
  assert.ok(!JSON.stringify(delivery).includes('test_token'));
});

test('cloud-only policy never falls back to a card or unverified text link', async () => {
  const state = { status: 'completed', pending: [], videos: extractRunVideos(snapshot([card])), message: 'done' };
  const result = await recoverEnterpriseVideo('123456789012', '123456789013', { state });
  assert.equal(result.status, 'video_missing'); assert.equal(result.error.code, 'cloud_video_missing');
  assert.deepEqual(result.videos, []); assert.equal(result.delivery.selected_count, 0);
});

test('does not match a failed operation, a different path, thread, malformed JSON or fake cloud page', () => {
  for (const invalid of [upload({}, `lark-cli drive +upload --file /other.mp4`), upload({}, undefined, 1),
    upload({ url: 'https://feishu.cn.evil.example/file/test_token' }), upload({ url: 'https://larkcommunity.feishu.cn/file/other' }),
    upload({ size: 101 * 1024 * 1024 }), operation(`lark-cli drive +upload --file ${file}`, 'not JSON')])
    assert.deepEqual(extractCloudVideos(entries([curl(), invalid])), []);
  const failedCurl = curl(); failedCurl.content.file_operation_block.display_content.exit_code = 1;
  assert.deepEqual(extractCloudVideos(entries([failedCurl, upload()])), []);
  const separate = entries([curl(), upload()]); separate[1].group = 'other';
  assert.deepEqual(extractCloudVideos(separate), []);
  const failedUpload = upload(); failedUpload.content.file_operation_block.display_content.result = '{"ok":false}';
  assert.deepEqual(extractCloudVideos(entries([curl(), failedUpload])), []);
});

test('matches an attachment rendered after the upload, with exact path and recorded size', () => {
  const attachment = { block_type: 10020, block_id: 'file', content: { file_block: { type: 'mp4', name: 'result.mp4', path: file, size: '12345', url: 'https://p6-flow-sign.byteimg.com/file' } } };
  const selected = selectCloudVideos(extractRunVideos(snapshot([upload(), attachment]))).selected;
  assert.equal(selected.length, 1); assert.equal(selected[0].kind, 'cloud_attachment');
  attachment.content.file_block.size = 11111;
  assert.deepEqual(selectCloudVideos(extractRunVideos(snapshot([upload(), attachment]))).selected, []);
});

test('user-uploaded blocks and duplicate snapshots cannot create a second cloud delivery', () => {
  const s = snapshot([card, curl(), upload()]);
  s.nodes = [{ messages: s.messages }];
  assert.equal(selectCloudVideos(extractRunVideos(s)).selected.length, 1);
  s.messages[0].user_type = 1;
  assert.deepEqual(extractRunVideos(s), []);
});

test('export eligibility requires cloud provenance; historical tasks request extraction', () => {
  assert.equal(isCloudVideo({ source_kind: 'creation' }), false);
  assert.equal(isCloudVideo({ source_kind: 'cloud_upload_original' }), false);
  assert.equal(isCloudVideo({ source_kind: 'cloud_upload_original', source_verification: 'matched_upload_path_and_size' }), true);
  assert.equal(needsCloudExtraction({ status: 'completed' }), true);
  assert.equal(needsCloudExtraction({ status: 'completed', delivery: { policy: 'cloud_only' } }), false);
});


test('delivery continuation matches the original attachment, never an unrelated path or size', () => {
 const attachment = {block_type:10020,block_id:'original-file',content:{file_block:{type:'mp4',name:'result.mp4',path:file,size:12345,url:'https://p6-flow-sign.byteimg.com/original'}}};
 const original=snapshot([attachment]), delivered=snapshot([upload()]);
 const combined={messages:[...original.messages,...delivered.messages],nodes:[]};
 assert.equal(selectCloudVideos(extractRunVideos(combined)).selected.length,1);
 const mismatched=snapshot([upload({size:9999})]);
 assert.equal(selectCloudVideos(extractRunVideos({messages:[...original.messages,...mismatched.messages],nodes:[]})).selected.length,0);
});
