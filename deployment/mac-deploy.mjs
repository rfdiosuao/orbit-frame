#!/usr/bin/env node
// New-Mac bootstrap. No credentials in command arguments, plist or reports.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'local.doubao-relay';
const registry = 'https://registry.npmmirror.com';
const cli = path.join(root, 'node_modules/doubao-cli/bin/doubao.mjs');
const commands = new Set(['install', 'bridge', 'start', 'doctor', 'mcp-config', 'autostart', 'remove-autostart', 'help']);

export function supportsNode(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 22 || major === 22 && minor >= 13;
}

// Parse only deployment fields. Never return or serialize secret values.
export function deploymentFields(text = '') {
  const wanted = new Set(['PORT', 'UPSTREAM_URL', 'SERVER_HOST', 'SERVER_PORT', 'SERVER_ENV', 'DOUBAO_APP', 'DOUBAO_CDP_ENDPOINT']);
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (!match || !wanted.has(match[1])) continue;
    let value = match[2].trim();
    if (/^["']/.test(value)) {
      const end = value.indexOf(value[0], 1);
      if (end < 0) throw Error('部署配置中有未闭合的引号，请检查 .env。');
      value = value.slice(1, end);
    } else value = value.replace(/\s*#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

export function resolvePorts(fields = {}, environment = {}) {
  const values = { ...fields };
  for (const name of ['PORT', 'UPSTREAM_URL', 'SERVER_HOST', 'SERVER_PORT', 'SERVER_ENV']) {
    if (environment[name] !== undefined) values[name] = environment[name];
  }
  const port = Number(values.PORT || 8787), upstreamPort = Number(values.SERVER_PORT || 8000);
  if (![port, upstreamPort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535) || port === upstreamPort) {
    throw Error('PORT 与 SERVER_PORT 必须是不同的 1024–65535 整数。');
  }
  let url;
  try { url = new URL(values.UPSTREAM_URL || 'http://127.0.0.1:8000'); } catch { throw Error('UPSTREAM_URL 格式不正确。'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' || Number(url.port || 80) !== upstreamPort ||
      values.SERVER_HOST && !['localhost', '127.0.0.1'].includes(values.SERVER_HOST) ||
      values.SERVER_ENV && values.SERVER_ENV !== 'dev') {
    throw Error('此部署入口用于本机：UPSTREAM_URL 与 SERVER_PORT 必须对应，SERVER_HOST 使用 127.0.0.1，SERVER_ENV 使用 dev。');
  }
  return { port, upstreamPort, base: `http://127.0.0.1:${port}` };
}

export async function createEnv(directory) {
  const target = path.join(directory, '.env');
  try {
    await fs.writeFile(target, await fs.readFile(path.join(directory, '.env.example')), { flag: 'wx', mode: 0o600 });
    return { created: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { created: false };
  }
}

export async function assertFreePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(Error(`本机 ${port} 端口已占用。先停止原服务；此脚本不会终止其他进程。`)));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  await new Promise(resolve => server.close(resolve));
}

const escapeXml = value => String(value).replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
export function launchAgentPlist(project, node) {
  const element = value => `<string>${escapeXml(value)}</string>`;
  const searchPath = `${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${element(label)}
  <key>ProgramArguments</key><array>${element(node)}${element(path.join(project, 'src/start-all.js'))}</array>
  <key>WorkingDirectory</key>${element(project)}
  <key>EnvironmentVariables</key><dict><key>PATH</key>${element(searchPath)}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key>${element(path.join(project, 'data/logs/service.out.log'))}
  <key>StandardErrorPath</key>${element(path.join(project, 'data/logs/service.err.log'))}
</dict></plist>
`;
}

function systemReady() {
  if (process.platform !== 'darwin') throw Error('本部署包的完整客户端桥接只适用于 macOS。');
  if (!supportsNode(process.versions.node)) throw Error('需要 Node.js 22.13 以上；建议安装 Node.js 24 LTS。');
}
async function exists(file) { return fs.access(file).then(() => true).catch(() => false); }
async function settings() {
  const fields = deploymentFields(await fs.readFile(path.join(root, '.env'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw Error('尚未安装：请先运行 Mac-一键安装.command。');
    throw error;
  }));
  return { ...resolvePorts(fields, process.env), fields };
}
async function dependencies() {
  if (!await exists(cli) || !await exists(path.join(root, 'vendor/doubao-free-api/dist/index.js'))) {
    throw Error('项目依赖尚未安装和构建，请先运行 Mac-一键安装.command。');
  }
}

function childCommand(program, args, cwd = root, extra = {}) {
  return spawn(program, args, { cwd, env: process.env, stdio: 'inherit', shell: false, ...extra });
}
async function childExit(child) {
  const onInt = () => child.kill('SIGINT'), onTerm = () => child.kill('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1))); });
    if (code) throw Error('子步骤未完成，请检查上方输出后重试。');
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
}
async function run(program, args, cwd = root) { return childExit(childCommand(program, args, cwd)); }
async function getJson(url, headers, timeout = 5000) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (!response.ok) throw Error(`本机检查返回 HTTP ${response.status}。`);
  return response.json();
}
async function gatewayBelongsHere(health) {
  if (!health?.ok || health.service !== 'doubao-relay' || !Number.isInteger(health.pid) || health.pid <= 0) return false;
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(health.pid), '-o', 'command='], { timeout: 3000 });
    return stdout.trim().endsWith(` ${path.join(root, 'src/index.js')}`);
  } catch { return false; }
}
async function waitGateway(base, isStopped = () => false) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !isStopped()) {
    try { if (await gatewayBelongsHere(await getJson(`${base}/health`, undefined, 1200))) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw Error('本项目网关未能启动，请检查上方日志及端口配置。');
}

async function install() {
  await createEnv(root); await settings();
  console.log('1/4 安装锁定的项目依赖…');
  await run('npm', ['ci', '--registry', registry, '--no-audit', '--no-fund']);
  console.log('2/4 安装并构建本机上游…');
  const upstream = path.join(root, 'vendor/doubao-free-api');
  await run('npm', ['ci', '--registry', registry, '--no-audit', '--no-fund'], upstream);
  await run('npm', ['run', 'build'], upstream);
  console.log('3/4 安装网页登录所需的浏览器…');
  await run(process.execPath, [path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium']);
  console.log('4/4 初始化本机目录与自动密钥…');
  const { config } = await import(pathToFileURL(path.join(root, 'src/config.js')).href);
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(config.logDir, { recursive: true, mode: 0o700 });
  console.log('安装完成。已有配置已保留；密钥不会显示。下一步：连接豆包，再启动网关。');
}

async function bridge() {
  await dependencies(); const { fields } = await settings();
  // Config imports dotenv so custom app path/CDP endpoint reaches the CLI.
  await import(pathToFileURL(path.join(root, 'src/config.js')).href);
  const app = process.env.DOUBAO_APP || fields.DOUBAO_APP || '/Applications/Doubao.app';
  if (!await exists(app) || !/\/Doubao\.app\/?$/.test(app)) throw Error('请先将豆包安装到 /Applications/Doubao.app；下载地址 https://www.doubao.com/download 。');
  console.log('将开启豆包的本机调试连接。建议先保存工作并在客户端按 ⌘Q 完全退出。');
  console.log('若 CLI 提示需要重启，请按其提示确认；随后在豆包里登录，保持应用打开。');
  await run(process.execPath, [cli, '--app', 'doubao', 'cdp', 'launch']);
  console.log('桥接已开启。请确认豆包已登录并进入正常聊天页，再启动网关。');
}

async function start() {
  await dependencies(); const { port, upstreamPort, base } = await settings();
  await assertFreePort(port); await assertFreePort(upstreamPort);
  console.log(`启动本机网关：${base}/ 。保持此终端窗口打开，停止时按 Ctrl+C。`);
  const child = childCommand(process.execPath, [path.join(root, 'src/start-all.js')]);
  let stopped = false; child.once('exit', () => { stopped = true; }); child.once('error', () => { stopped = true; });
  const finished = childExit(child); finished.catch(() => {});
  try {
    await waitGateway(base, () => stopped);
    await exec('/usr/bin/open', [`${base}/`], { timeout: 3000 }).catch(() => {});
  } catch (error) {
    child.kill('SIGTERM'); await finished.catch(() => {}); throw error;
  }
  await finished;
}

async function doctor() {
  await dependencies(); const { base } = await settings();
  const { config } = await import(pathToFileURL(path.join(root, 'src/config.js')).href);
  const headers = { Authorization: `Bearer ${config.localApiKey}` };
  const report = { checked_at: new Date().toISOString(), base_url: base, generation_submitted: false, checks: {}, notes: [] };
  async function check(name, work) {
    try { report.checks[name] = Boolean(await work()); } catch { report.checks[name] = false; }
  }
  await check('project_gateway', async () => gatewayBelongsHere(await getJson(`${base}/health`)));
  if (report.checks.project_gateway) {
    await check('unauthenticated_rejected', async () => (await fetch(`${base}/v1/videos/tasks`, { signal: AbortSignal.timeout(5000) })).status === 401);
    await check('local_key_accepted', async () => Array.isArray((await getJson(`${base}/v1/videos/tasks`, headers)).tasks));
    await check('upstream_reachable', async () => (await getJson(`${base}/admin/status`, undefined, 8000)).upstreamOk === true);
    await check('doubao_ready', async () => {
      const state = await getJson(`${base}/v1/videos/readiness?refresh=1`, headers, 15_000);
      report.doubao_code = /^[a-z_]+$/.test(state.code || '') ? state.code : 'check_failed';
      return state.ready === true;
    });
    await check('image_provider_available', async () => {
      const state = await getJson(`${base}/v1/images/capabilities?probe=1`, headers, 15_000);
      return state.providers?.some(provider => provider.id === 'openai-compatible' && provider.connected === true && provider.requested_model_available === true);
    });
  }
  report.ok = ['project_gateway', 'unauthenticated_rejected', 'local_key_accepted', 'upstream_reachable', 'doubao_ready'].every(key => report.checks[key]);
  report.notes.push('连接检查不提交视频或图片，账号额度和实际模型需另做真实验收。');
  if (!report.checks.doubao_ready) report.notes.push('先连接豆包并登录，进入聊天页面；不要把网页登录当作客户端登录。');
  if (!report.checks.image_provider_available) report.notes.push('外接生图未就绪；在本机 /image-provider.html 配置。视频部署可独立完成。');
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.dataDir, 'deployment-check.json');
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

async function mcpConfig() {
  const config = { mcpServers: { 'orbit-frame': { type: 'stdio', command: process.execPath,
    args: [path.join(root, 'scripts/orbit-frame-mcp.mjs')],
    env: { ORBIT_FRAME_OUTPUT_DIR: path.join(root, 'data/exports') } } } };
  await fs.mkdir(path.join(root, 'data'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'data/mcp-config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(config, null, 2));
  console.error('已保存到本机 data/mcp-config.json；把 orbit-frame 项合并进 Agent 的 MCP 配置，保留已有服务器。');
}

async function autostart(dryRun) {
  const file = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist');
  if (dryRun) { console.log(launchAgentPlist(root, process.execPath)); return; }
  await dependencies(); const { port, upstreamPort, base } = await settings();
  if (await exists(file)) throw Error('已有 local.doubao-relay 启动配置，未覆盖。请先确认原配置并停止原服务。');
  await assertFreePort(port); await assertFreePort(upstreamPort);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.join(root, 'data/logs'), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, launchAgentPlist(root, process.execPath), { flag: 'wx', mode: 0o600 });
  let bootstrapped = false;
  try {
    await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { timeout: 10_000 });
    bootstrapped = true;
    await waitGateway(base);
  } catch {
    if (bootstrapped) await exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { timeout: 5000 }).catch(() => {});
    await fs.unlink(file).catch(() => {});
    throw Error('后台启动未通过检查，已撤回本次启动配置。先用前台启动查看日志。');
  }
  console.log(`后台网关已启动，用户登录 Mac 后会自动运行。豆包调试连接仍需单独开启：${base}/`);
}

async function removeAutostart() {
  const file = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist');
  const xml = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') throw Error('没有安装此后台服务。'); throw error; });
  if (!xml.includes(escapeXml(path.join(root, 'src/start-all.js')))) throw Error('后台配置属于其他项目目录，未停止或删除。');
  const target = `gui/${process.getuid()}/${label}`;
  let loaded = false;
  try { await exec('/bin/launchctl', ['print', target], { timeout: 3000 }); loaded = true; } catch {}
  if (loaded) await exec('/bin/launchctl', ['bootout', target], { timeout: 5000 });
  await fs.unlink(file);
  console.log('后台服务已卸载；配置、登录资料、图片、视频和任务记录均保留。');
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'help', ...options] = args;
  if (!commands.has(command) || options.length && !(command === 'autostart' && options.length === 1 && options[0] === '--dry-run')) throw Error('参数不正确，运行 help 查看可用入口。');
  if (command === 'help') {
    console.log('Orbit Frame Mac 部署：install → bridge（登录）→ start → doctor\nmcp-config：生成新机 MCP 配置\nautostart [--dry-run]：可选后台运行\nremove-autostart：卸载本目录的后台服务\n不包含账号和服务密钥；所有检查均不生成媒体。'); return;
  }
  systemReady(); process.umask(0o077);
  if (command === 'install') return install();
  if (command === 'bridge') return bridge();
  if (command === 'start') return start();
  if (command === 'doctor') return doctor();
  if (command === 'mcp-config') return mcpConfig();
  if (command === 'autostart') return autostart(options.includes('--dry-run'));
  if (command === 'remove-autostart') return removeAutostart();
}

if (process.argv[1] && (await fs.realpath(path.resolve(process.argv[1])).catch(() => '')) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Only deliberate local messages are public; raw OS errors may include private paths or env.
    console.error(error.code ? '操作未完成，请检查目录权限、依赖和系统环境。' : error.message);
    process.exitCode = 1;
  });
}
