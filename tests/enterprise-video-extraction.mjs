import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractRunVideos } from '../src/enterprise-video-client.js';

test('extracts the generated video card and uploaded MP4 file from a run snapshot', () => {
  const snapshot = { nodes: [], messages: [{ message_id: '123456789012', content_block: [
    { block_type: 10084, block_id: 'video-block', content: { rich_media_layout_block: { media: [{ creation: {
      type: 2, id: 'creation-1', video: { status: 3, video_type: 'mp4', width: '1280', height: '720',
        duration: 5.05, download_url: 'https://v9-default.douyin.com/signed', vid: 'v1' },
    } }] } } },
    { block_type: 10020, block_id: 'file-block', content: { file_block: {
      type: 'mp4', name: 'result.mp4', size: '551573', url: 'https://p6-flow-sign.byteimg.com/signed',
    } } },
  ] }] };
  const videos = extractRunVideos(snapshot);
  assert.equal(videos.length, 2);
  assert.deepEqual(videos.map(video => video.kind), ['creation', 'file']);
  assert.equal(videos[0].width, 1280);
  assert.equal(videos[1].expectedBytes, 551573);
  assert.ok(videos.every(video => video.messageId === '123456789012'));
});

test('does not treat unfinished cards or generic files as videos', () => {
  const snapshot = { nodes: [], messages: [{ message_id: '123456789012', content_block: [
    { block_type: 10084, content: { rich_media_layout_block: { media: [{ creation: {
      type: 2, video: { status: 1, video_type: 'mp4', width: '1280', height: '720', duration: 5,
        download_url: 'https://v9-default.douyin.com/signed' },
    } }] } } },
    { block_type: 10020, content: { file_block: {
      type: 'pdf', name: 'result.pdf', url: 'https://p6-flow-sign.byteimg.com/signed',
    } } },
  ] }] };
  assert.deepEqual(extractRunVideos(snapshot), []);
});
