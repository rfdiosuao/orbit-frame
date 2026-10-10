import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

for (const status of ['completed','waiting_input','failed','running']) test(`CLI workflow ${status}`,async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'orbit-cli-test-'));let posts=0,queries=0;
 const bytes=Buffer.from('0000ftypmock-video');
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer test-only-key');
  if(req.method==='POST'){posts++;res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({task_id:'test-task',status:'running'}));}
  else if(req.url.includes('/tasks/')){queries++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({task_id:'test-task',status,delivery:{policy:'cloud_only'},videos:status==='completed'?[{id:'a'.repeat(32),source_kind:'cloud_upload_original',source_verification:'matched_upload_path_and_size'}]:[]}));}
  else if(req.url.endsWith('/source')) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source_kind:'cloud_upload_original',source_verification:'matched_upload_path_and_size'}));}
  else {res.setHeader('Content-Type','video/mp4');res.end(bytes);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const output=path.join(dir,'result.mp4');
  const child=spawn(process.execPath,['scripts/doubao-video.mjs','generate','test prompt','--output',output,'--timeout-seconds',status==='running'?'1':'5'],{env:{...process.env,PORT:String(server.address().port),LOCAL_API_KEY:'test-only-key'}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise(r=>child.on('close',r));
  assert.equal(code,status==='completed'?0:['waiting_input','running'].includes(status)?2:1,stderr);
  assert.equal(posts,1);assert.ok(queries>=1);assert.ok(!stdout.includes('test-only-key'));
  const result=JSON.parse(stdout);assert.equal(result.status,status);if(status==='running')assert.equal(result.timed_out,true);
  if(status==='completed'){assert.equal(result.file,output);assert.deepEqual(await readFile(output),bytes);}
  else await assert.rejects(readFile(output),{code:'ENOENT'});
 } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
