import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmsRestart } from '../scripts/service-restart.mjs';

test('restart succeeds only for a new healthy gateway owned by the new project supervisor', () => {
  const state = { before: { supervisor: 10, gateway: 11 }, afterSupervisor: 20,
    expectedEntry: '/project with spaces/src/index.js',
    rows: [{ pid: 21, ppid: 20, command: '/node /project with spaces/src/index.js' }],
    status: { ok: true, service: 'doubao-relay', pid: 21 } };
  assert.equal(confirmsRestart(state), true);
  assert.equal(confirmsRestart({ ...state, afterSupervisor: 10 }), false);
  assert.equal(confirmsRestart({ ...state, status: { ...state.status, pid: 11 } }), false);
  assert.equal(confirmsRestart({ ...state, status: { ...state.status, pid: 99 } }), false);
  assert.equal(confirmsRestart({ ...state, rows: [{ ...state.rows[0], ppid: 999 }] }), false);
  assert.equal(confirmsRestart({ ...state, rows: [{ ...state.rows[0], command: '/node /another/src/index.js' }] }), false);
  assert.equal(confirmsRestart({ ...state, status: { ...state.status, ok: false } }), false);
});
