#!/usr/bin/env node
// Portable dispatcher. It does not contain credentials or invoke a shell.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

const here=path.dirname(fileURLToPath(import.meta.url));
const required=['src/config.js','scripts/doubao-video.mjs','scripts/doubao-image.mjs','scripts/orbit-frame-mcp.mjs','scripts/orbit-frame-workflow.mjs'];
const entries={video:'scripts/doubao-video.mjs',image:'scripts/doubao-image.mjs',workflow:'scripts/orbit-frame-workflow.mjs',mcp:'scripts/orbit-frame-mcp.mjs'};

async function isProject(directory) {
  return (await Promise.all(required.map(file=>fs.stat(path.join(directory,file)).then(s=>s.isFile()).catch(()=>false)))).every(Boolean);
}
function ancestors(directory) {
  const result=[];let current=path.resolve(directory);
  while(true){result.push(current);const parent=path.dirname(current);if(parent===current)break;current=parent;}
  return result;
}
export async function resolveProject(explicit) {
  const chosen=explicit || process.env.ORBIT_FRAME_PROJECT_DIR;
  if(chosen){const absolute=path.resolve(chosen);if(await isProject(absolute))return fs.realpath(absolute);throw Error('指定目录不是完整 Orbit Frame 项目，请检查 --project 或 ORBIT_FRAME_PROJECT_DIR');}
  for(const candidate of new Set([...ancestors(process.cwd()),...ancestors(here)]))if(await isProject(candidate))return fs.realpath(candidate);
  throw Error('未找到 Orbit Frame 项目，请传 --project /完整项目路径');
}
export function parseEnvFile(text) {
  const allowed=new Set(['OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL']);const result={};
  for(const row of text.split(/\r?\n/)) {
    const line=row.trim();if(!line || line.startsWith('#'))continue;
    const match=line.match(/^(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
    if(!match || !allowed.has(match[1]) || Object.hasOwn(result,match[1]))throw Error('配置文件只接受三个不重复的 OPENAI_* 字段；不会执行 shell 语句');
    let value=match[2].trim();
    if(value.startsWith('"') || value.startsWith("'")) {
      if(value.length<2 || value.at(-1)!==value[0])throw Error('配置值的引号未闭合');
      value=value.slice(1,-1);
    }
    if(!value || /[\u0000-\u001f]/.test(value))throw Error('配置值不能为空或包含控制字符');
    result[match[1]]=value;
  }
  return result;
}
function print(value){process.stdout.write(JSON.stringify(value)+'\n');}
async function configureImages(project,rest) {
  if(rest.length && !(rest.length===2 && rest[0]==='--env-file'))throw Error('configure-images 仅接受 --env-file /本机私有配置文件');
  let input=process.env;
  if(rest.length){const file=path.resolve(rest[1]),stat=await fs.stat(file);if(!stat.isFile() || stat.size>65536)throw Error('配置文件必须是小于 64 KB 的普通文件');input=parseEnvFile(await fs.readFile(file,'utf8'));}
  const provider=await import(pathToFileURL(path.join(project,'src/image-providers.js')).href);
  const current=await provider.imageProviderSettings();
  const api_key=input.OPENAI_API_KEY || current.api_key;
  if(!api_key || /^(?:YOUR_|REPLACE_|<)/.test(api_key))throw Error('请在本机私有配置或生图设置页填写实际服务密钥');
  await provider.saveImageProviderSettings({base_url:input.OPENAI_BASE_URL || current.base_url || 'http://127.0.0.1:63451/v1',api_key,model:input.OPENAI_MODEL || current.model || 'gpt-image-2.5',edit_enabled:true});
  const capabilities=await provider.imageCapabilities({probe:true});
  const external=capabilities.providers.find(p=>p.id==='openai-compatible');
  print({saved_to_local_project:true,provider:external.id,base_url:external.base_url,requested_model:external.requested_model,configured:external.configured,connected:external.connected,model_available:external.requested_model_available,supports_generate:external.supports_generate,supports_edit:external.supports_edit,task_query_supported:external.task_query_supported,cancellation_supported:external.cancellation_supported,model_verification:external.model_verification});
  if(external.connected!==true || external.requested_model_available!==true)process.exitCode=2;
}
async function delegate(project,entry,args) {
  const child=spawn(process.execPath,[path.join(project,entry),...args],{cwd:project,env:process.env,stdio:'inherit',shell:false});
  const onInt=()=>child.kill('SIGINT'),onTerm=()=>child.kill('SIGTERM');
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
  try {const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code ?? (signal==='SIGINT'?130:143)));});process.exitCode=code;}
  finally{process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);}
}
export async function main(argv=process.argv.slice(2)) {
  let explicit;const args=[...argv];
  if(args[0]==='--project'){explicit=args[1];if(!explicit || explicit.startsWith('--'))throw Error('--project 需要项目路径');args.splice(0,2);}
  const [command,...rest]=args;
  if(!command || ['help','--help','-h'].includes(command)) {
    process.stdout.write('Orbit Frame Skill launcher\n  orbit.mjs [--project DIR] video|image|workflow <project CLI arguments>\n  orbit.mjs [--project DIR] mcp\n  orbit.mjs [--project DIR] mcp-config\n  orbit.mjs [--project DIR] health\n  orbit.mjs [--project DIR] configure-images [--env-file FILE]\nProject can also be selected using ORBIT_FRAME_PROJECT_DIR. Delegated relative paths resolve from the project; prefer absolute media/output/manifest paths. configure-images reads OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL or preserves existing local settings. No credentials appear in its output.\n');return;
  }
  if(!Object.hasOwn(entries,command) && !['health','mcp-config','configure-images'].includes(command))throw Error('未知入口，请使用 video、image、workflow、mcp、health、mcp-config 或 configure-images');
  const project=await resolveProject(explicit);
  if(command==='configure-images')return configureImages(project,rest);
  if(['health','mcp-config','mcp'].includes(command) && rest.length)throw Error('此入口不接受额外参数');
  if(command==='mcp-config')return print({mcpServers:{'orbit-frame':{type:'stdio',command:process.execPath,args:[fileURLToPath(import.meta.url),'--project',project,'mcp']}}});
  if(command==='health') {
    const {config}=await import(pathToFileURL(path.join(project,'src/config.js')).href);
    const response=await fetch(`http://127.0.0.1:${config.port}/health`,{signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('网关健康检查失败');const state=await response.json();
    return print({ok:state.ok,service:state.service,pid:state.pid,started_at:state.started_at,project_dir:project,image_job_reference_policy:state.image_job_reference_policy});
  }
  return delegate(project,entries[command],rest);
}
if(process.argv[1] && (await fs.realpath(path.resolve(process.argv[1])).catch(()=>''))===fileURLToPath(import.meta.url))main().catch(()=>{
  // Avoid serializing input, env or upstream errors that may carry secrets.
  process.stdout.write(JSON.stringify({status:'error',message:'Skill 调用失败；请检查项目路径、命令参数、私有配置及本地服务。可用 help 查看入口。'})+'\n');process.exitCode=1;
});
