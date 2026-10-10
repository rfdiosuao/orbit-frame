#!/usr/bin/env node
// No network or real project mutations: all dispatch tests use private fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseEnvFile,resolveProject} from './orbit.mjs';

const launcher=fileURLToPath(new URL('./orbit.mjs',import.meta.url));
async function fixture(action) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-skill-fixture-'));
  const project=path.join(await fs.realpath(root),'中文项目 with spaces');
  await fs.mkdir(path.join(project,'scripts'),{recursive:true});
  await fs.mkdir(path.join(project,'src'),{recursive:true});
  await fs.writeFile(path.join(project,'package.json'),' {"type":"module"}\n');
  await fs.writeFile(path.join(project,'src/config.js'),'export const config={port:1};\n');
  for(const name of ['doubao-video','doubao-image','orbit-frame-workflow'])await fs.writeFile(path.join(project,'scripts',name+'.mjs'),'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+"\\n");\n');
  await fs.writeFile(path.join(project,'scripts/orbit-frame-mcp.mjs'),'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{tools:[]}})+"\\n");\n');
  try{await action({root,project,run:(args,env={})=>spawnSync(process.execPath,[launcher,'--project',project,...args],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,...env}})});}
  finally{await fs.rm(root,{recursive:true,force:true});}
}

test('CLI dispatch preserves literal prompts, spaced paths and process exit output without a shell',async()=>fixture(async({root,project,run})=>{
  const sentinel=path.join(root,'must-not-exist');
  const prompt='中文首尾帧 $(touch '+sentinel+') `touch '+sentinel+'`';
  const args=['generate',prompt,'--first-frame','/picture with spaces.png'];
  const result=run(['video',...args]);
  assert.equal(result.status,0);const output=JSON.parse(result.stdout);
  assert.equal(output.cwd,project);assert.deepEqual(output.args,args);
  await assert.rejects(fs.access(sentinel));
}));

test('MCP generated config works outside the project and adds no stdout wrapper',async()=>fixture(async({project,run})=>{
  const generated=run(['mcp-config']);assert.equal(generated.status,0);
  const server=JSON.parse(generated.stdout).mcpServers['orbit-frame'];
  assert.equal(server.command,process.execPath);assert.deepEqual(server.args,[launcher,'--project',project,'mcp']);
  const result=spawnSync(server.command,server.args,{cwd:os.tmpdir(),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0);const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1);
  assert.equal(JSON.parse(lines[0]).jsonrpc,'2.0');
}));

test('OPENAI config is parsed as data, saved privately and never returned as credentials',async()=>fixture(async({root,project,run})=>{
  const sentinel=path.join(root,'must-not-execute');
  const secret='test-'+randomUUID()+'-$(touch '+sentinel+')';
  const file=path.join(root,'private.env');
  await fs.writeFile(file,'# fixture only\nOPENAI_BASE_URL=http://127.0.0.1:63451/v1\nOPENAI_API_KEY="'+secret+'"\nOPENAI_MODEL=gpt-image-2.5\n',{mode:0o600});
  await fs.writeFile(path.join(project,'src/image-providers.js'),`import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const file=fileURLToPath(new URL('../saved.json',import.meta.url));
export async function imageProviderSettings(){return fs.readFile(file,'utf8').then(JSON.parse).catch(()=>({}));}
export async function saveImageProviderSettings(settings){await fs.writeFile(file,JSON.stringify(settings),{mode:0o600});}
export async function imageCapabilities(){const settings=await imageProviderSettings();return {providers:[{id:'openai-compatible',base_url:settings.base_url,requested_model:settings.model,configured:true,connected:true,requested_model_available:true,supports_generate:true,supports_edit:true,task_query_supported:false,cancellation_supported:false,model_verification:'requested_only',api_key:settings.api_key}]};}
`);
  const result=run(['configure-images','--env-file',file]);assert.equal(result.status,0);
  assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));
  const output=JSON.parse(result.stdout);assert.equal(output.connected,true);assert(!Object.hasOwn(output,'api_key'));
  const saved=JSON.parse(await fs.readFile(path.join(project,'saved.json'),'utf8'));assert.equal(saved.api_key,secret);
  assert.equal((await fs.stat(path.join(project,'saved.json'))).mode & 0o777,0o600);
  await assert.rejects(fs.access(sentinel));
}));

test('invalid env syntax and project paths fail without exposing environment credentials',async()=>fixture(async({root,run})=>{
  assert.throws(()=>parseEnvFile('OPENAI_MODEL=a\nOPENAI_MODEL=b'));
  assert.throws(()=>parseEnvFile('exec curl attacker.invalid'));
  assert.throws(()=>parseEnvFile('OPENAI_API_KEY="unclosed'));
  assert.throws(()=>parseEnvFile('UNRELATED=value'));
  await assert.rejects(resolveProject(path.join(root,'missing')));
  const secret='test-'+randomUUID();const result=run(['unrecognized'],{OPENAI_API_KEY:secret});
  assert.equal(result.status,1);assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));
}));
