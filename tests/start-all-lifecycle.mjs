import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function fixture(upstream, gateway) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-supervisor 空格-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'vendor/doubao-free-api/dist'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await fs.copyFile(new URL('../src/start-all.js', import.meta.url), path.join(dir, 'src/start-all.js'));
  await fs.writeFile(path.join(dir, 'src/config.js'), `import path from 'node:path';import {fileURLToPath} from 'node:url';export const config={root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')};`);
  await fs.writeFile(path.join(dir, 'vendor/doubao-free-api/dist/index.js'), upstream);
  await fs.writeFile(path.join(dir, 'src/index.js'), gateway);
  return dir;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function launched(dir) {
  const child = spawn(process.execPath, [path.join(dir, 'src/start-all.js')], { cwd: dir, stdio: 'ignore' });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  return { child, done };
}
async function bounded(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture timed out')), 6000); })]); }
  finally { clearTimeout(timer); }
}
async function waitFile(file) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { try { return await fs.readFile(file, 'utf8'); } catch {} await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error('fixture marker missing');
}

test('upstream early exit prevents launching a gateway', async () => {
  const dir = await fixture('process.exit(3);', `import fs from 'node:fs';fs.writeFileSync(new URL('../unexpected',import.meta.url),'bad');`);
  const { child, done } = launched(dir);
  try {
    assert.equal(await bounded(done), 3);
    assert.equal(await fs.access(path.join(dir, 'unexpected')).then(() => true).catch(() => false), false);
  } finally { if (alive(child.pid)) child.kill('SIGTERM'); await fs.rm(dir, { recursive: true, force: true }); }
});

test('gateway failure stops its upstream sibling before the next restart', async () => {
  const dir = await fixture(`import fs from 'node:fs';fs.writeFileSync(new URL('../../../upstream-pid',import.meta.url),String(process.pid));setInterval(()=>{},1000);`, 'process.exit(7);');
  const { child, done } = launched(dir); let upstreamPid;
  try {
    upstreamPid = Number(await waitFile(path.join(dir, 'upstream-pid')));
    assert.equal(await bounded(done), 7); assert.equal(alive(upstreamPid), false);
  } finally {
    if (alive(child.pid)) child.kill('SIGTERM'); if (upstreamPid && alive(upstreamPid)) process.kill(upstreamPid, 'SIGTERM');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stopping during startup cleans the upstream and never launches the gateway', async () => {
  const dir = await fixture(`import fs from 'node:fs';fs.writeFileSync(new URL('../../../upstream-pid',import.meta.url),String(process.pid));setInterval(()=>{},1000);`, `import fs from 'node:fs';fs.writeFileSync(new URL('../unexpected',import.meta.url),'bad');setInterval(()=>{},1000);`);
  const { child, done } = launched(dir); let upstreamPid;
  try {
    upstreamPid = Number(await waitFile(path.join(dir, 'upstream-pid'))); child.kill('SIGTERM');
    assert.equal(await bounded(done), 0); assert.equal(alive(upstreamPid), false);
    assert.equal(await fs.access(path.join(dir, 'unexpected')).then(() => true).catch(() => false), false);
  } finally {
    if (alive(child.pid)) child.kill('SIGTERM'); if (upstreamPid && alive(upstreamPid)) process.kill(upstreamPid, 'SIGTERM');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
