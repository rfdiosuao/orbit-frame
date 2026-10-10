#!/usr/bin/env node
// Defaults to local read-only load. Live generation must be explicitly requested.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { config } from '../src/config.js';
const args = process.argv.slice(2), at = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const mode = at('--mode', 'read-only');
if (!['read-only', 'mcp-image', 'mcp-video'].includes(mode)) throw new Error('Unsupported stress mode');
if (mode !== 'read-only' && !args.includes('--live')) throw new Error('Use --live only after the user authorizes real generation');
const folder = path.resolve(at('--output', path.join(config.dataDir, 'stress', `${Date.now()}`)));
await fs.mkdir(folder, { recursive: true, mode: 0o700 });
const base = `http://127.0.0.1:${config.port}`, headers = { Authorization: `Bearer ${config.localApiKey}` };
const run = { mode, started_at: new Date().toISOString(), report: null };
let child;
async function mcpCall(name, input) {
  child ||= spawn(process.execPath, [path.join(config.root, 'scripts/orbit-frame-mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', sequence = 0;
  const read = data => { buffer += data; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); } };
  child.stdout.on('data', read);
  child.stderr.on('data', () => {}); // Never print upstream diagnostics or credentials.
  const request = (method, params, timeout = 750_000) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timed out')); }, timeout);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2025-06-18' }, 15_000);
  const result = await request('tools/call', { name, arguments: input }, Math.max(750_000, (Number(input.timeout_seconds || 600) + 30) * 1000));
  child.stdout.off('data', read);
  if (result.isError) return { status: 'failed', error: result.structuredContent?.error || { code: 'mcp_error' } };
  return result.structuredContent;
}
try {
  if (mode === 'read-only') {
    const taskId = at('--task', '');
    const endpoint = taskId ? `/v1/videos/tasks/${encodeURIComponent(taskId)}` : '/v1/videos/tasks?limit=100';
    const count = Math.max(1, Math.min(500, Number(at('--requests', 100)) || 100));
    const concurrency = Math.max(1, Math.min(32, Number(at('--concurrency', 10)) || 10));
    const times = [], statuses = []; let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { while (next++ < count) { const start = performance.now(); const response = await fetch(base + endpoint, { headers, signal: AbortSignal.timeout(15_000) }); await response.arrayBuffer(); times.push(performance.now() - start); statuses.push(response.status); } }));
    times.sort((a, b) => a - b);
    const unauthorized = await fetch(base + '/v1/videos/tasks');
    run.report = { requests: count, concurrency, successful: statuses.filter(s => s === 200 || s === 202).length,
      p50_ms: Math.round(times[Math.floor(times.length * .5)]), p95_ms: Math.round(times[Math.min(times.length - 1, Math.floor(times.length * .95))]), max_ms: Math.round(times.at(-1)), unauthorized_status: unauthorized.status };
  } else {
    const planFile = at('--plan', '');
    const input = planFile ? JSON.parse(await fs.readFile(planFile, 'utf8')) : { prompt: '原创山海经微电影结尾分镜：成年女性探险家穿白色户外夹克与黑色长裤，站在星夜云海石桥上，巨大白色九尾狐的九条尾巴发出淡金色光芒，天空极光倒映云海，电影实拍质感，横屏16:9，不要文字。', ratio: '16:9' };
    const requestFile = path.join(folder, 'request.json');
    let saved;
    try { saved = JSON.parse(await fs.readFile(requestFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved) {
      // Only the same immutable plan may resume a persisted request.
      const normalize = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'idempotency_key').sort(([a], [b]) => a.localeCompare(b)));
      if (JSON.stringify(normalize(input)) !== JSON.stringify(normalize(saved)) || input.idempotency_key && input.idempotency_key !== saved.idempotency_key) throw new Error('Output folder already belongs to a different plan; use its original plan to resume');
      Object.assign(input, saved);
    } else {
      input.idempotency_key ||= randomUUID();
      await fs.writeFile(requestFile, JSON.stringify(input, null, 2), { flag: 'wx', mode: 0o600 });
    }
    run.report = await mcpCall(mode === 'mcp-image' ? 'generate_image' : 'generate_and_wait', input);
    if (run.report.status === 'completed') {
      const file = mode === 'mcp-video' ? run.report.file : run.report.images?.[0]?.file;
      if (!file) throw new Error('Completed result has no local file');
      const bytes = await fs.readFile(file);
      run.file_check = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
} catch (error) { run.error = error.message; process.exitCode = 1; }
finally {
  child?.kill(); run.completed_at = new Date().toISOString();
  await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(run, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(run));
if (run.report?.status && run.report.status !== 'completed') process.exitCode = 2;
