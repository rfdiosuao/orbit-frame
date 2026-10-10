#!/usr/bin/env node
// Source-only snapshot: allowlisted directories, no credentials or runtime data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['src', 'public', 'scripts', 'tests', 'docs', 'skills', 'deployment', 'toonflow', 'vendor/doubao-free-api'];
const rootFiles = ['package.json', 'package-lock.json', '.env.example', '.gitignore', 'AGENTS.md', 'README.md', '先读这个.md',
  'Mac-一键安装.command', 'Mac-连接豆包.command', 'Mac-启动.command', 'Mac-检查.command', 'Mac-MCP配置.command', 'Mac-后台运行.command'];
const excluded = new Set(['node_modules', '.git', '.claude', 'data', 'logs', 'dist', '.cache', '.idea', '__MACOSX']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.access(file).then(() => true).catch(() => false);

export function standardUtf8Zip(input) {
  // ditto stores UTF-8 filenames but omits the standard language flag.
  // Mark both directory and local records so Python/Agent extractors work too.
  const bytes = Buffer.from(input);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw Error('压缩包索引无效，未交付。');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff || size === 0xffffffff) throw Error('此源码打包入口不支持 ZIP64。');
  let at = start;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw Error('压缩包文件索引无效。');
    const length = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    const filename = bytes.subarray(at + 46, at + 46 + length), local = bytes.readUInt32LE(at + 42);
    if (!Buffer.from(filename.toString('utf8')).equals(filename) || bytes.readUInt32LE(local) !== 0x04034b50 ||
        !bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).equals(filename)) {
      throw Error('压缩包文件名不是一致的 UTF-8，未交付。');
    }
    bytes.writeUInt16LE(bytes.readUInt16LE(at + 8) | 0x0800, at + 8);
    bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 0x0800, local + 6);
    at += 46 + length + extra + comment;
  }
  if (at !== start + size) throw Error('压缩包索引长度不一致。');
  return bytes;
}

async function collect(directory, files) {
  if (!await exists(path.join(root, directory))) return;
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name === '.DS_Store' ||
        entry.name.startsWith('.env') && entry.name !== '.env.example' ||
        /\.(log|sqlite(?:3)?|db|pem|p12|key|dmg)$/i.test(entry.name)) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('源码目录有符号链接，未打包；请先确认文件来源。');
    if (entry.isDirectory()) await collect(relative, files);
    else if (entry.isFile()) files.push(relative);
  }
}

async function privateFingerprints() {
  // Keep comparison values only in memory; never serialize them or their hashes.
  const values = [];
  const env = await fs.readFile(path.join(root, '.env'), 'utf8').catch(() => '');
  for (const line of env.split(/\r?\n/)) {
    const match = /^\s*([A-Z_]*(?:KEY|TOKEN|COOKIE|SECRET|SESSIONID)[A-Z_]*)\s*=\s*(.+)/.exec(line);
    const value = match?.[2]?.trim().replace(/^['"]|['"]$/g, '');
    if (value && value.length >= 16 && value !== 'local-dev-key-change-me') values.push(Buffer.from(value));
  }
  const settings = await fs.readFile(path.join(root, 'data/image-provider.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  if (settings.api_key?.length >= 16) values.push(Buffer.from(settings.api_key));
  return values;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--output-dir')) throw Error('使用 build-package.mjs [--output-dir DIR]');
  const output = path.resolve(root, args[1] || 'data/exports');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const name = `orbit-frame-macos-${date}`;
  const archive = path.join(output, name + '.zip');
  if (await exists(archive)) throw Error('同名部署包已存在，未覆盖；请换一个 --output-dir。');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-frame-package-'));
  const target = path.join(stage, name);
  try {
    const files = [...rootFiles];
    for (const directory of directories) await collect(directory, files);
    files.sort();
    const fingerprints = await privateFingerprints(), checksums = {};
    for (const relative of files) {
      const source = path.join(root, relative), destination = path.join(target, relative);
      const bytes = await fs.readFile(source);
      if (fingerprints.some(secret => bytes.includes(secret)) || /(?:agt_codex_|sk-proj-)[A-Za-z0-9_-]{20,}/.test(bytes.toString('utf8'))) {
        throw Error('源码中检测到疑似私有凭据，已停止打包；未输出敏感内容。');
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { mode: /\.command$/.test(relative) || relative === 'deployment/mac-runner.sh' || relative === 'scripts/service.sh' ? 0o755 : 0o644 });
      checksums[relative] = hash(bytes);
    }
    for (const [relative, checksum] of Object.entries(checksums)) {
      if (hash(await fs.readFile(path.join(root, relative))) !== checksum) throw Error('打包过程中源码有变化，请重新运行以取得一致快照。');
    }
    let commit = null;
    try { commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 3000 })).stdout.trim(); } catch {}
    const manifest = { name, created_at: new Date().toISOString(), source: 'local_working_tree_snapshot', base_commit: commit,
      node_requirement: '>=22.13', platform: 'macOS', files: checksums,
      exclusions: ['.git', 'node_modules', '.env', 'data', 'logs', 'vendor/dist', 'client_profiles', '.claude', '.mcp.json', 'local_deployment_record'] };
    await fs.writeFile(path.join(target, 'deployment-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noqtn', target, archive], { timeout: 30_000 });
    await fs.chmod(archive, 0o600);
    const bytes = standardUtf8Zip(await fs.readFile(archive));
    await fs.writeFile(archive, bytes);
    const checksum = hash(bytes);
    await fs.writeFile(archive + '.sha256', `${checksum}  ${path.basename(archive)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ file: archive, bytes: bytes.length, sha256: checksum, source_files: files.length,
      credentials_included: false, generated_media_included: false, account_profiles_included: false }, null, 2));
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && (await fs.realpath(path.resolve(process.argv[1])).catch(() => '')) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.code ? '打包未完成，请检查文件权限及系统工具。' : error.message); process.exitCode = 1; });
}
