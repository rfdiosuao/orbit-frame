import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-fixes-'));
process.env.ORBIT_FRAME_MEDIA_DIR=path.join(root,'media');process.env.LOG_DIR=path.join(root,'logs');process.env.LOCAL_API_KEY='test-only-local';
const {config}=await import('../src/config.js');config.dataDir=path.join(root,'data');
const {createCanvas,getCanvas,saveCanvas}=await import('../src/canvas-store.js');
const {composeVideoScene,reserveVideoScene}=await import('../src/canvas-scenes.js');
const {startImageJob,getImageJob,cancelImageJob}=await import('../src/image-jobs.js');
const {saveImageProviderSettings,imageCapabilities,generateCompatibleImage}=await import('../src/image-providers.js');
const {cancelEnterpriseVideoJob}=await import('../src/enterprise-video-jobs.js');
after(()=>fs.rm(root,{recursive:true,force:true}));
const png=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(720,16);png.writeUInt32BE(1280,20);
const sha256=createHash('sha256').update(png).digest('hex');
await fs.mkdir(path.join(config.mediaDir,'uploads'),{recursive:true});await fs.writeFile(path.join(config.mediaDir,'uploads/a.png'),png);
const asset={path:'uploads/a.png',preview_url:'/v1/videos/frames/a.png',width:720,height:1280,bytes:33,sha256,asset_id:'sha256:'+sha256,provider:'local-upload',model_verification:'not_applicable'};

test('frozen scenes reject whole-document input/key/edge changes while allowing layout and shared source edits',async()=>{
 const doc=await createCanvas({}),scene=await composeVideoScene(doc.id,{prompt:'original',first_frame:asset});await reserveVideoScene(doc.id,scene.card_id);
 const original=await getCanvas(doc.id);
 for(const change of [v=>v.prompt='changed',v=>v.model='Seedance 2.5',v=>v.duration=6,v=>v.ratio='1:1',v=>v.request_key=null,v=>v.task_id=randomUUID(),v=>v.input_frames=[]]){
  const body=structuredClone(original);change(body.cards.find(c=>c.id===scene.card_id));await assert.rejects(saveCanvas(doc.id,body),e=>e.invalid && /冻结/.test(e.message));
 }
 const disconnected=structuredClone(original);disconnected.edges=[];await assert.rejects(saveCanvas(doc.id,disconnected),e=>e.invalid);
 const moved=structuredClone(original);moved.cards.find(c=>c.id===scene.card_id).x+=10;moved.cards.find(c=>c.type==='note').text='later shared edit';assert.ok(await saveCanvas(doc.id,moved));
});

test('canvas asset provenance and parent hashes persist across reloads',async()=>{
 const enriched={...asset,requested_model:'test-model',source_task_id:randomUUID(),parent_assets:[{asset_id:asset.asset_id,path:asset.path,sha256}]};
 const doc=await createCanvas({cards:[{id:'image',type:'image',x:0,y:0,asset:enriched}]});
 const result=(await getCanvas(doc.id)).cards[0].asset;assert.equal(result.sha256,sha256);assert.equal(result.provider,enriched.provider);assert.equal(result.source_task_id,enriched.source_task_id);assert.deepEqual(result.parent_assets,enriched.parent_assets);
});

test('canvas and scene preparations reuse IDs under concurrent and interrupted retries',async()=>{
 const key=randomUUID();const [a,b]=await Promise.all([createCanvas({title:'retry',idempotency_key:key}),createCanvas({title:'retry',idempotency_key:key})]);assert.equal(a.id,b.id);
 const args={prompt:'same scene',first_frame:asset,idempotency_key:key};const [x,y]=await Promise.all([composeVideoScene(a.id,args),composeVideoScene(a.id,args)]);assert.equal(x.card_id,y.card_id);assert.equal((await getCanvas(a.id)).cards.length,3);
 await assert.rejects(composeVideoScene(a.id,{...args,prompt:'different'}),e=>e.invalid);await assert.rejects(createCanvas({title:'different',idempotency_key:key}),e=>e.invalid);
});

async function waitImage(id){let job;for(let i=0;i<60;i++){job=await getImageJob(id,{waitMs:25});if(job.status!=='running')return job;}throw Error('mock image did not finish');}
test('image jobs upload private original copies and persist actual parent hashes',async()=>{
 const key=randomUUID();let received;
 await startImageJob({prompt:'edit original',provider:'doubao-desktop',reference_images:[asset],idempotency_key:key},async(body)=>{received=body;assert.deepEqual(await fs.readFile(body.reference_files[0]),png);return {images:[png]};});
 const job=await waitImage(key);assert.equal(job.status,'completed');assert.equal(job.reference_images[0].sha256,sha256);assert.equal(job.images[0].parent_assets[0].sha256,sha256);assert.equal(job.images[0].source_task_id,key);assert.equal(job.images[0].sha256,sha256);assert.equal(received.idempotency_key,key);
 await assert.rejects(startImageJob({prompt:'changed',provider:'doubao-desktop',reference_images:[asset],idempotency_key:key},async()=>{}),/同一请求编号/);
});

test('known upstream cancellation and failure are terminal instead of unknown',async()=>{
 for(const status of ['failed','cancelled']){
  const id=randomUUID();await startImageJob({prompt:status,provider:'doubao-desktop',idempotency_key:id},async(_,callbacks)=>{await callbacks.onReceipt({conversationId:'38445132156657666',runId:'58004820066283010'});throw Object.assign(Error(status),{upstream_status:status});});assert.equal((await waitImage(id)).status,status);
 }
});

test('cancel receipt confirms the original run and late workers cannot overwrite cancellation',async()=>{
 const id=randomUUID();let release;const gate=new Promise(r=>release=r);
 await startImageJob({prompt:'cancel original',provider:'doubao-desktop',idempotency_key:id},async(_,callbacks)=>{await callbacks.onReceipt({conversationId:'38445132156657666',runId:'58004820066283010'});await gate;throw Object.assign(Error('local wait interrupted'),{uncertain:true});});
 for(let i=0;i<20;i++){if((await getImageJob(id,{waitMs:25})).run_id)break;}
 const cancelled=await cancelImageJob(id,{cancel:async(c,r)=>{assert.equal(r,'58004820066283010');return {state:'cancelled',accepted:true,confirmed:true};}});assert.equal(cancelled.status,'cancelled');release();await new Promise(r=>setTimeout(r,30));assert.equal((await getImageJob(id)).status,'cancelled');
 const dir=path.join(config.dataDir,'enterprise-video-jobs');await fs.mkdir(dir,{recursive:true});const video=randomUUID();await fs.writeFile(path.join(dir,video+'.json'),JSON.stringify({id:video,status:'running',conversationId:'38445132156657666',runId:'58004820066283010',options:{},createdAt:new Date().toISOString()}));
 const result=await cancelEnterpriseVideoJob(video,{cancel:async()=>({state:'cancelled',accepted:true,confirmed:true})});assert.equal(result.status,'cancelled');assert.equal(result.cancellation.confirmed,true);
});

test('cancellation requested before a receipt is applied when the original run becomes known',async()=>{
 const id=randomUUID();let release;const gate=new Promise(r=>release=r);
 await startImageJob({prompt:'cancel before receipt',provider:'doubao-desktop',idempotency_key:id},async(_,callbacks)=>{await gate;await callbacks.onReceipt({conversationId:'38445132156657666',runId:'58004820066283010'});return {images:[png]};});
 let attempts=0;assert.equal((await cancelImageJob(id,{cancel:async()=>{attempts++;return {state:'cancelled',accepted:true,confirmed:true};}})).cancellation.state,'unknown');release();
 for(let i=0;i<40;i++){const job=await getImageJob(id,{waitMs:25});if(job.status==='cancelled'){assert.equal(job.cancellation.confirmed,true);assert.equal(attempts,1);return;}}
 assert.fail('Original run was not cancelled after receipt');
});

test('external provider uses multipart original bytes, discovers models, keeps secrets local, and preserves uncertain errors',async()=>{
 const captures=[];const server=http.createServer(async(req,res)=>{const buffers=[];for await(const b of req)buffers.push(b);const body=Buffer.concat(buffers);captures.push({path:req.url,body,contentType:req.headers['content-type']});res.setHeader('Content-Type','application/json');if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'gpt-image-2.5'}]}));else res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}],model:'gpt-image-2.5'}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const settings=await saveImageProviderSettings({base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'test-provider-private',model:'gpt-image-2.5',edit_enabled:true});assert.ok(!JSON.stringify(settings).includes('test-provider-private'));assert.equal((await fs.stat(path.join(config.dataDir,'image-provider.json'))).mode&0o777,0o600);
 const cap=await imageCapabilities({probe:true});assert.equal(cap.providers[1].requested_model_available,true);
 const image=await generateCompatibleImage({prompt:'change lighting',model:'gpt-image-2.5',ratio:'9:16',reference_files:[path.join(config.mediaDir,'uploads/a.png')],idempotency_key:randomUUID()});assert.deepEqual(image.images[0],png);const request=captures.at(-1);assert.equal(request.path,'/v1/images/edits');assert.match(request.contentType,/multipart/);assert.ok(request.body.includes(png));
 const id=randomUUID();await startImageJob({prompt:'external pending',provider:'openai-compatible',idempotency_key:id},async()=>{throw Object.assign(Error('provider timeout'),{uncertain:true});});assert.equal((await waitImage(id)).status,'unknown');assert.equal((await cancelImageJob(id)).cancellation.state,'unsupported');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('real stdio MCP rejects unrecognized references and known 400 responses; CLI rejects unknown flags',async()=>{
 const captures=[];const server=http.createServer(async(req,res)=>{const buffers=[];for await(const b of req)buffers.push(b);captures.push({path:req.url,body:JSON.parse(Buffer.concat(buffers)||'{}')});res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'known rejection',submitted:false}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env={...process.env,PORT:String(server.address().port)};const child=spawn(process.execPath,['scripts/orbit-frame-mcp.mjs'],{env});child.stderr.resume();let buffer='',seq=0;const pending=new Map();child.stdout.on('data',b=>{buffer+=b;let at;while((at=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);pending.get(message.id)?.(message.result);pending.delete(message.id);}});
 const rpc=(name,args)=>new Promise((resolve,reject)=>{const id=++seq,t=setTimeout(()=>reject(Error('MCP timeout')),5000);pending.set(id,v=>{clearTimeout(t);resolve(v)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');});
 try{const bad=await rpc('generate_image',{prompt:'test',referenceImages:['ignored.png']});assert.equal(bad.isError,true);assert.equal(bad.structuredContent.error.submitted,false);assert.equal(captures.length,0);
 const rejected=await rpc('generate_image',{prompt:'test'});assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.error.submitted,false);assert.equal(rejected.structuredContent.error.http_status,400);
 const cli=spawn(process.execPath,['scripts/doubao-image.mjs','test','--unknown-image','missing.png'],{env});let output='';cli.stdout.on('data',b=>output+=b);cli.stderr.resume();assert.equal(await new Promise(r=>cli.on('close',r)),1);assert.equal(JSON.parse(output).error.submitted,false);assert.equal(captures.length,1);
 }finally{child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
