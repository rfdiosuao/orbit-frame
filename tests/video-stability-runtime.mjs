import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExtractionQueue, createVideoTaskStepper, canWatchVideoJob } from '../src/video-task-runtime.js';
import { createReadinessProbe, interpretVideoReadiness } from '../src/video-readiness.js';
import { boundedCdp } from '../src/video-errors.js';

const job = id => ({ id, status: 'running', conversationId: '123456789012', runId: '123456789013',
  options: {}, autoConfirm: true, pending: [], videos: [], confirmedIds: [], confirmationAttemptedIds: [], createdAt: new Date().toISOString() });
const saved = async () => {};

test('readiness distinguishes offline, login, loading and incompatible clients without claiming quota', () => {
  assert.equal(interpretVideoReadiness({ connected: false }).code, 'client_unavailable');
  assert.equal(interpretVideoReadiness({ connected: true }).code, 'login_required');
  assert.equal(interpretVideoReadiness({ connected: true, hasSession: true }).code, 'client_not_ready');
  assert.equal(interpretVideoReadiness({ connected: true, hasSession: true, chatReady: true }).code, 'client_incompatible');
  const ready = interpretVideoReadiness({ connected: true, hasSession: true, chatReady: true, compatible: true });
  assert.equal(ready.ready, true); assert.equal(ready.generation_permission, 'not_probed');
});

test('readiness coalesces concurrent probes and expires its cache', async () => {
  let calls = 0, time = 0, release;
  const probe = createReadinessProbe(async () => { calls++; if (calls === 1) await new Promise(resolve => release = resolve); return { ready: true }; }, { now: () => time, ttlMs: 10 });
  const a = probe(), b = probe({ force: true });
  await Promise.resolve(); assert.equal(calls, 1); release();
  assert.deepEqual(await a, await b);
  await probe(); assert.equal(calls, 1);
  time = 11; await probe(); assert.equal(calls, 2);
});

test('a stalled CDP read times out and closes its connection', async () => {
  let closed = false;
  await assert.rejects(boundedCdp(() => new Promise(() => {}), () => { closed = true; }, 10), error => error.code === 'cdp_timeout');
  assert.equal(closed, true);
});

test('three disconnected reads pause a task; the same run recovers without resubmission', async () => {
  let fail = true, reads = 0;
  const state = job('reconnect');
  const step = createVideoTaskStepper({ inspect: async () => { reads++; if (fail) throw new Error('socket disconnected'); return { status: 'running', pending: [] }; }, confirm: () => { throw new Error('must not confirm'); }, extraction: { has: () => false }, save: saved });
  for (let i = 0; i < 3; i++) await step(state);
  assert.equal(state.status, 'unknown'); assert.equal(state.error.code, 'connection_lost'); assert.equal(canWatchVideoJob(state), true);
  assert.ok(state.nextPollAt > Date.now());
  fail = false; await step(state);
  assert.equal(reads, 4); assert.equal(state.status, 'running'); assert.equal(state.error, null); assert.equal(state.runId, '123456789013');
});

test('a slow extraction does not block status reads and duplicate extraction is suppressed', async () => {
  let release, extractions = 0, reads = 0;
  const queue = createExtractionQueue(async () => { extractions++; await new Promise(resolve => release = resolve); }, { concurrency: 1 });
  const first = job('first'), second = job('second');
  const step = createVideoTaskStepper({ inspect: async id => { reads++; return { status: reads === 1 ? 'completed' : 'running', videos: [], pending: [] }; }, confirm: async () => ({}), extraction: queue, save: saved });
  await step(first); await step(first); await step(second);
  assert.equal(reads, 2); assert.equal(second.status, 'running'); assert.equal(first.phase, 'extracting');
  await Promise.resolve(); assert.equal(extractions, 1); release(); await queue.idle();
});

test('extraction concurrency is bounded and failed workers release their slots', async () => {
  let active = 0, max = 0, count = 0, errors = 0;
  const queue = createExtractionQueue(async () => {
    active++; max = Math.max(max, active); count++;
    await new Promise(resolve => setTimeout(resolve, 5)); active--; throw new Error('download failed');
  }, { concurrency: 2, onError: () => errors++ });
  for (let i = 0; i < 5; i++) queue.add(String(i), {});
  await queue.idle(); assert.equal(count, 5); assert.equal(max, 2); assert.equal(errors, 5);
});

test('uncertain confirmation is never automatically clicked again', async () => {
  let confirmations = 0;
  const state = job('confirm');
  const step = createVideoTaskStepper({ inspect: async () => ({ status: 'waiting_input', pending: [{ clarifyId: 'ask' }] }),
    confirm: async (_c, _r, _o, attempted, before) => {
      if (attempted.includes('ask')) return { confirmed: false };
      confirmations++; await before('ask'); throw new Error('connection lost after click');
    }, extraction: { has: () => false }, save: saved });
  await step(state); assert.equal(state.error.code, 'confirmation_unknown'); assert.equal(canWatchVideoJob(state), false);
  await step(state); assert.equal(confirmations, 1); assert.equal(state.status, 'unknown');
});

test('generation monitoring has a deadline and manual recovery can renew it', async () => {
  let reads = 0;
  const state = job('deadline'); state.createdAt = new Date(Date.now() - 3700_000).toISOString();
  const step = createVideoTaskStepper({ inspect: async () => { reads++; return { status: 'running' }; }, extraction: { has: () => false }, save: saved });
  await step(state); assert.equal(reads, 0); assert.equal(state.error.code, 'monitoring_expired'); assert.equal(canWatchVideoJob(state), false);
  state.monitorStartedAt = new Date().toISOString(); await step(state); assert.equal(reads, 1); assert.equal(state.status, 'running');
});
