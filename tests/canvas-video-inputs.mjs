import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoPrompt, acceptsVideoInput } from '../public/canvas-video-inputs.js';

const note = { id: 'note1', type: 'note', text: '首帧柔和过渡到尾帧' };
const image = { id: 'img1', type: 'image', asset: { path: 'uploads/a.png' } };
const video = { id: 'vid1', type: 'video', prompt: '直接输入的提示词' };
const edges = [{ from: note.id, to: video.id, role: 'prompt' }];

test('video uses connected text, preserves direct entry, and rejects empty sources without silently falling back', () => {
  assert.equal(videoPrompt(video, [note, video], []), video.prompt);
  assert.equal(videoPrompt(video, [note, video], edges), note.text);
  assert.equal(videoPrompt(video, [{ ...note, text: '' }, video], edges), '');
  assert.equal(videoPrompt(video, [video], edges), '');
  assert.equal(videoPrompt(video, [{ ...note, text: '修改后的过渡' }, video], edges), '修改后的过渡');
});

test('accepted and uncertain submissions keep their prompt when the linked text changes', () => {
  const changed = { ...note, text: '新的提示词' };
  for (const state of [{ request_key: 'key1' }, { task_id: 'task1' }]) {
    assert.equal(videoPrompt({ ...video, ...state }, [changed, video], edges), video.prompt);
  }
});

test('text and images have separate input roles and cannot cross-connect', () => {
  assert.equal(acceptsVideoInput(note, video, 'prompt'), true);
  assert.equal(acceptsVideoInput(image, video, 'first_frame'), true);
  assert.equal(acceptsVideoInput(image, video, 'last_frame'), true);
  for (const [source, target, role] of [[note, video, 'first_frame'], [image, video, 'prompt'],
    [note, image, 'prompt'], [{ ...image, asset: null }, video, 'first_frame'], [video, video, 'prompt']]) {
    assert.equal(acceptsVideoInput(source, target, role), false);
  }
});
