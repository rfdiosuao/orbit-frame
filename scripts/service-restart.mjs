#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
const exec = promisify(execFile);
const target = `gui/${process.getuid()}/local.doubao-relay`;
const entry = `${config.root}/src/index.js`;
const base = `http://127.0.0.1:${config.port}`;

async function command(program, args, timeout = 3000) {
  const result = await exec(program, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  return result.stdout;
}
async function supervisor() {
  return Number(/^\s*pid = (\d+)/m.exec(await command('/bin/launchctl', ['print', target]))?.[1]) || null;
}
async function processes() {
  return (await command('/bin/ps', ['-axo', 'pid=,ppid=,command='])).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}
async function health() {
  const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('Gateway health HTTP failure');
  return response.json();
}

export function confirmsRestart({ before, afterSupervisor, rows, status, expectedEntry }) {
  return Boolean(afterSupervisor && afterSupervisor !== before.supervisor && status?.ok === true &&
    status.service === 'doubao-relay' && Number.isInteger(status.pid) && status.pid !== before.gateway &&
    rows.some(row => row.pid === status.pid && row.ppid === afterSupervisor && row.command.endsWith(` ${expectedEntry}`)));
}

export async function restartService() {
  // Every OS query has a deadline. Never run unbounded lsof, which can block
  // on unrelated network volumes before restart is even requested.
  const oldSupervisor = await supervisor();
  const oldRows = await processes();
  const before = { supervisor: oldSupervisor,
    gateway: oldRows.find(row => row.ppid === oldSupervisor && row.command.endsWith(` ${entry}`))?.pid || null };
  await command('/bin/launchctl', ['kickstart', '-k', target], 10_000);
  const deadline = Date.now() + 20_000;
  let lastFailure = 'No new gateway has reported readiness';
  while (Date.now() < deadline) {
    try {
      const afterSupervisor = await supervisor();
      const status = await health();
      const rows = await processes();
      if (confirmsRestart({ before, afterSupervisor, rows, status, expectedEntry: entry })) {
        return { before, supervisor_pid: afterSupervisor, gateway_pid: status.pid,
          started_at: status.started_at, image_job_reference_policy: status.image_job_reference_policy };
      }
      lastFailure = 'Health response does not belong to the new project gateway';
    } catch { lastFailure = 'New gateway or service state is unavailable'; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Gateway restart was not verified: ${lastFailure}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await restartService())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
