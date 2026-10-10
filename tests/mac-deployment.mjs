import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEnv, deploymentFields, resolvePorts, supportsNode, launchAgentPlist, assertFreePort } from '../deployment/mac-deploy.mjs';
const exec = promisify(execFile);

test('deployment refuses mismatched ports, remote upstreams and secret-bearing URLs', () => {
  assert.deepEqual(resolvePorts({}), { port: 8787, upstreamPort: 8000, base: 'http://127.0.0.1:8787' });
  assert.equal(resolvePorts({ PORT: '18787', SERVER_PORT: '18000', UPSTREAM_URL: 'http://localhost:18000' }).upstreamPort, 18000);
  for (const fields of [
    { UPSTREAM_URL: 'http://127.0.0.1:8001' }, { PORT: '8000' }, { PORT: '0' },
    { UPSTREAM_URL: 'http://user:fake-secret@127.0.0.1:8000' },
    { UPSTREAM_URL: 'http://remote.test:8000' }, { UPSTREAM_URL: 'http://127.0.0.1:8000/?key=fake-secret' },
    { SERVER_HOST: '0.0.0.0' }, { SERVER_ENV: 'prod' }
  ]) assert.throws(() => resolvePorts(fields));
  assert.throws(() => resolvePorts({}, { SERVER_PORT: '8001' }));
});

test('deployment parser exposes no credential fields and never executes env content', () => {
  const fields = deploymentFields('PORT=18787 # local\nLOCAL_API_KEY=fixture-secret\nOPENAI_API_KEY=other-fixture\nexport DOUBAO_APP="/目录 空格/Doubao.app"\n');
  assert.deepEqual(fields, { PORT: '18787', DOUBAO_APP: '/目录 空格/Doubao.app' });
  assert.equal(supportsNode('22.12.9'), false); assert.equal(supportsNode('22.13.0'), true); assert.equal(supportsNode('24.19.0'), true);
});

test('first installation creates private env once and preserves existing configuration on retry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit deploy 空格-'));
  try {
    await fs.writeFile(path.join(dir, '.env.example'), 'PORT=8787\nLOCAL_API_KEY=\n');
    const results = await Promise.all([createEnv(dir), createEnv(dir)]);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal((await fs.stat(path.join(dir, '.env'))).mode & 0o777, 0o600);
    await fs.writeFile(path.join(dir, '.env'), 'PORT=18787\nLOCAL_API_KEY=fixture-kept\n');
    assert.equal((await createEnv(dir)).created, false);
    assert.equal(await fs.readFile(path.join(dir, '.env'), 'utf8'), 'PORT=18787\nLOCAL_API_KEY=fixture-kept\n');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('occupied port is refused without terminating its owner', async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(assertFreePort(server.address().port), /端口已占用/);
    assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('launchd config encodes literal Chinese, spaces and XML characters without credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-plist-'));
  try {
    const xml = launchAgentPlist('/应用 空格/项目&<测试>', '/Node 空格/bin/node');
    const file = path.join(dir, 'fixture.plist'); await fs.writeFile(file, xml);
    if (process.platform === 'darwin') await exec('/usr/bin/plutil', ['-lint', file]);
    assert.ok(xml.includes('项目&amp;&lt;测试&gt;'));
    assert.ok(xml.includes('src/start-all.js')); assert.ok(!xml.includes('LOCAL_API_KEY')); assert.ok(!xml.includes('OPENAI_API_KEY'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('autostart dry-run does not create configuration or data; MCP config follows relocated paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '新 Mac 路径 空格-'));
  try {
    await fs.mkdir(path.join(dir, 'deployment'));
    await fs.copyFile(new URL('../deployment/mac-deploy.mjs', import.meta.url), path.join(dir, 'deployment/mac-deploy.mjs'));
    if (process.platform !== 'darwin') return;
    const dry = await exec(process.execPath, [path.join(dir, 'deployment/mac-deploy.mjs'), 'autostart', '--dry-run'], { env: { ...process.env, LOCAL_API_KEY: 'fixture-env-secret' } });
    assert.ok(dry.stdout.includes('src/start-all.js')); assert.ok(!dry.stdout.includes('fixture-env-secret'));
    assert.equal(await fs.access(path.join(dir, 'data')).then(() => true).catch(() => false), false);
    const result = await exec(process.execPath, [path.join(dir, 'deployment/mac-deploy.mjs'), 'mcp-config']);
    const config = JSON.parse(result.stdout).mcpServers['orbit-frame'];
    const canonical = await fs.realpath(dir);
    assert.deepEqual(config.args, [path.join(canonical, 'scripts/orbit-frame-mcp.mjs')]);
    assert.equal(config.command, process.execPath);
    assert.equal(config.env.ORBIT_FRAME_OUTPUT_DIR, path.join(canonical, 'data/exports'));
    assert.equal((await fs.stat(path.join(dir, 'data/mcp-config.json'))).mode & 0o777, 0o600);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
