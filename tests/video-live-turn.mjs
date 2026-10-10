import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLiveVideoTurn, acknowledgeLiveConfirmations } from '../src/video-live-turn.js';

test('a pending live confirmation absent from history is recovered on the same run after a bounded stream timeout', async () => {
  const receipt = {}, saved = [];
  let reads = 0;
  const snapshot = await readLiveVideoTurn({ receipt, conversationId: '123', runId: '456',
    read: async (id, options) => {
      assert.equal(id, '123'); assert.equal(options.runId, '456'); reads++;
      return { result: { status: receipt.liveAsk ? 'waiting_input' : 'running' } };
    },
    wait: async (id, options) => {
      assert.equal(id, '123'); assert.equal(options.runId, '456'); assert.equal(options.timeoutMs, 1500);
      options.receipt.liveAsk = true; options.onReceipt(options.receipt);
      throw Object.assign(new Error('short collection window ended'), { code: 'timeout' });
    }, save: value => saved.push(value), load: () => receipt,
  });
  assert.equal(snapshot.result.status, 'waiting_input'); assert.equal(reads, 2); assert.equal(saved.length, 1);
});

test('only successful confirmation IDs clear stale local control cards', () => {
  const asks = [{ status: 1, clarify_id: 'confirmed' }, { status: 1, clarify_id: 'new' }];
  const receipt = { liveMessages: [{ content_block: asks.map(ask => ({ content: { interaction_ask_block: ask } })) }] };
  assert.equal(acknowledgeLiveConfirmations(receipt, ['confirmed'], message => message.content_block), true);
  assert.equal(asks[0].status, 2); assert.equal(asks[1].status, 1);
  assert.equal(acknowledgeLiveConfirmations(receipt, ['confirmed'], message => message.content_block), false);
});

test('answered live confirmation is reconciled before status is returned', async () => {
  const receipt = { liveAsk: true };
  const snapshot = await readLiveVideoTurn({ conversationId: '123', runId: '456', receipt,
    refresh: async () => { receipt.liveAsk = false; return { result: { status: 'waiting_input' } }; },
    read: async () => ({ result: { status: receipt.liveAsk ? 'waiting_input' : 'running' } }),
    wait: async () => assert.fail('do not repeat a confirmation or stream read'),
  });
  assert.equal(snapshot.result.status, 'running');
});

test('known async streams use one refresh window without a second wait window', async () => {
  const snapshot = { result: { status: 'running' } };
  assert.equal(await readLiveVideoTurn({ conversationId: '123', runId: '456', receipt: { handoffs: [{ taskId: 'a' }] },
    refresh: async () => snapshot, read: async () => assert.fail('snapshot already refreshed'),
    wait: async () => assert.fail('must not open a second stream window') }), snapshot);
});

test('completed history is reused without reconnecting the stream', async () => {
  const snapshot = { result: { status: 'completed' }, videos: ['video'] };
  assert.equal(await readLiveVideoTurn({ conversationId: '123', runId: '456', receipt: {},
    read: async () => snapshot, wait: async () => assert.fail('must not reconnect a completed task') }), snapshot);
});
