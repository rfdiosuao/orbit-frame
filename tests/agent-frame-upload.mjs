import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-agent-frames-'));
const media = path.join(dir, 'media');
await fs.mkdir(media);
process.env.ORBIT_FRAME_MEDIA_DIR = media;
const { prepareVideoFrames } = await import('../scripts/frame-workflow.mjs');
after(() => fs.rm(dir, { recursive: true, force: true }));
function png(n) { const b=Buffer.alloc(33,n);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IHDR',12);b.writeUInt32BE(1280,16);b.writeUInt32BE(720,20);return b; }
const first=path.join(dir,'首帧 one.png'), last=path.join(dir,'尾帧 two.png');
await fs.writeFile(first,png(1));await fs.writeFile(last,png(2));

test('validates all files before upload and never ignores conflicting frame roles', async()=>{
  let calls=0;const upload=async f=>{calls++;return {path:`uploads/test-${calls}.png`};};
  for(const args of [{last_frame_path:last},{first_frame_path:first,last_frame_path:'/does-not-exist.png'},
    {mode:'text_to_video',first_frame_path:first},{mode:'image_to_video',first_frame_path:first,last_frame_path:last},
    {mode:'first_last_frame',first_frame_path:first},{first_frame:{path:first},first_frame_path:first},
    {first_frame_path:'https://example.com/a.png'}]) {
    await assert.rejects(prepareVideoFrames(args,{upload}),e=>e.diagnostic?.submitted===false);
  }
  assert.equal(calls,0);
  const result=await prepareVideoFrames({first_frame_path:first,last_frame_path:last},{upload});
  assert.equal(result.mode,'first_last_frame');assert.equal(calls,2);
  assert.equal(result.first_frame.sha256,createHash('sha256').update(png(1)).digest('hex'));
  assert.equal(result.last_frame.sha256,createHash('sha256').update(png(2)).digest('hex'));
});

test('importing a nested generated file keeps provider provenance while rechecking bytes and using the uploaded preview',async()=>{
  const folder=path.join(media,'workflow');await fs.mkdir(folder);const file=path.join(folder,'edited.png');await fs.writeFile(file,png(3));
  await fs.writeFile(file+'.meta.json',JSON.stringify({provider:'openai-compatible',requested_model:'gpt-image-2.5',source_task_id:'original-image-task',sha256:'0'.repeat(64),width:1,preview_url:'/stale'}));
  const result=await prepareVideoFrames({first_frame_path:file},{upload:async()=>({path:'uploads/imported.png',preview_url:'/v1/videos/frames/imported.png',provider:'local-upload'})});
  assert.equal(result.first_frame.provider,'openai-compatible');assert.equal(result.first_frame.source_task_id,'original-image-task');assert.equal(result.first_frame.width,1280);
  assert.equal(result.first_frame.sha256,createHash('sha256').update(png(3)).digest('hex'));assert.equal(result.first_frame.preview_url,'/v1/videos/frames/imported.png');
});

async function mockGateway(work) {
  const uploads=[], submissions=[];
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-only-key');
    const buffers=[];for await(const chunk of req)buffers.push(chunk);const body=Buffer.concat(buffers);
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/videos/frames') {uploads.push(body);res.writeHead(201);res.end(JSON.stringify({path:`uploads/image-${uploads.length}.png`,preview_url:`/v1/videos/frames/image-${uploads.length}.png`,width:1280,height:720}));}
    else if(req.url==='/v1/videos/generations') {const input=JSON.parse(body);submissions.push(input);res.writeHead(202);res.end(JSON.stringify({task_id:'a'.repeat(64),status:'running',mode:input.mode,frames:[input.first_frame,input.last_frame].filter(Boolean)}));}
    else {res.writeHead(404);res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const env={...process.env,PORT:String(server.address().port),LOCAL_API_KEY:'test-only-key'};
  try {await work({env,uploads,submissions});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}

test('CLI uploads arbitrary local files and infers first/last mode over a real HTTP connection',async()=>mockGateway(async({env,uploads,submissions})=>{
  const missing=spawn(process.execPath,['scripts/doubao-video.mjs','submit','test','--first-frame'],{env});
  let rejected='';missing.stdout.on('data',b=>rejected+=b);missing.stderr.resume();
  assert.equal(await new Promise(r=>missing.on('close',r)),1);assert.equal(JSON.parse(rejected).error.submitted,false);assert.equal(submissions.length,0);
  for(const count of [1,2]) {
    const child=spawn(process.execPath,['scripts/doubao-video.mjs','submit','a smooth transition','--first-frame',first,...(count===2?['--last-frame',last]:[]),'--async'],{env});
    let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.resume();
    assert.equal(await new Promise(r=>child.on('close',r)),0,stdout);
    assert.ok(!stdout.includes('test-only-key'));
    assert.equal(JSON.parse(stdout).mode,count===1?'image_to_video':'first_last_frame');
  }
  assert.deepEqual(uploads,[png(1),png(1),png(2)]);
  assert.equal(submissions.length,2);assert.equal(submissions[1].first_frame.path,'uploads/image-2.png');assert.equal(submissions[1].last_frame.path,'uploads/image-3.png');
}));

test('MCP discovers uploads and scenes and directly uploads both local frames without a browser',async()=>mockGateway(async({env,uploads,submissions})=>{
  const child=spawn(process.execPath,['scripts/orbit-frame-mcp.mjs'],{env});child.stderr.resume();
  let buffer='',sequence=0,output='';const pending=new Map();
  child.stdout.on('data',b=>{output+=b;buffer+=b;let at;while((at=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);pending.get(message.id)?.(message.result);pending.delete(message.id);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,t=setTimeout(()=>reject(Error('MCP timeout')),10000);pending.set(id,v=>{clearTimeout(t);resolve(v);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  try {
    await rpc('initialize',{});const listed=await rpc('tools/list',{});
    for(const name of ['upload_frame','list_media','get_canvas','compose_video_scene']) assert.ok(listed.tools.some(t=>t.name===name));
    const result=await rpc('tools/call',{name:'generate_and_wait',arguments:{prompt:'transition',first_frame_path:first,last_frame_path:last,wait:false}});
    assert.equal(result.isError,undefined);assert.equal(result.structuredContent.mode,'first_last_frame');
    assert.deepEqual(uploads,[png(1),png(2)]);assert.equal(submissions.length,1);
    const bad=await rpc('tools/call',{name:'generate_and_wait',arguments:{prompt:'bad',last_frame_path:last,wait:false}});
    assert.equal(bad.isError,true);assert.equal(submissions.length,1);assert.equal(uploads.length,2);assert.ok(!output.includes('test-only-key'));
  }finally{child.kill();}
}));
