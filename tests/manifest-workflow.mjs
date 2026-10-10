import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-manifest-'));
process.env.ORBIT_FRAME_MEDIA_DIR=path.join(root,'media');process.env.LOG_DIR=path.join(root,'logs');process.env.LOCAL_API_KEY='test-local-key';
const {config}=await import('../src/config.js');config.dataDir=path.join(root,'data');
const {createCanvas,getCanvas,saveCanvas}=await import('../src/canvas-store.js');
const {composeVideoScene,reserveVideoScene,canvasSceneSummary}=await import('../src/canvas-scenes.js');
const {storeUploadedFrame}=await import('../src/video-frame-upload.js');
const {startImageJob,getImageJob}=await import('../src/image-jobs.js');
const {preflightWorkflow,prepareWorkflow,runWorkflow,cancelWorkflow,exportWorkflow}=await import('../scripts/canvas-workflow.mjs');
const png=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(720,16);png.writeUInt32BE(1280,20);
const sha256=createHash('sha256').update(png).digest('hex');const imageFile=path.join(root,'original.png');await fs.writeFile(imageFile,png);
const mp4=Buffer.alloc(40);mp4.write('ftyp',4);const tasks=new Map();let submissions=0,uploads=0;
const source={source_kind:'cloud_upload_original',source_verification:'matched_upload_path_and_size'};
const server=http.createServer(async(req,res)=>{
 try {
 const url=new URL(req.url,'http://localhost'),buffers=[];for await(const b of req)buffers.push(b);const bytes=Buffer.concat(buffers),body=bytes.length && req.headers['content-type']?.includes('json')?JSON.parse(bytes):{};let result;
 if(req.method==='POST' && url.pathname==='/v1/videos/frames'){uploads++;result=await storeUploadedFrame(bytes);}
 else if(url.pathname==='/v1/images/capabilities')result={providers:[{id:'openai-compatible',requested_model:'gpt-image-2.5'}]};
 else if(req.method==='POST' && url.pathname==='/v1/images/jobs')result=await startImageJob(body,async input=>{assert.equal(input.reference_files.length,1);assert.deepEqual(await fs.readFile(input.reference_files[0]),png);return {images:[png]};});
 else if(/^\/v1\/images\/jobs\//.test(url.pathname))result=await getImageJob(url.pathname.split('/')[4],{waitMs:50});
 else if(req.method==='POST' && url.pathname==='/v1/canvases')result=await createCanvas(body);
 else if(/^\/v1\/canvases\/[^/]+\/video-scenes\/[^/]+\/generate$/.test(url.pathname)){
  const [, , ,id, ,card]=url.pathname.split('/');const input=await reserveVideoScene(id,card);
  if(!tasks.has(input.task_id)){submissions++;tasks.set(input.task_id,{task_id:input.task_id,status:'completed',frames:[{role:'first_frame',sha256:input.first_frame.sha256}],model_verification:'requested_only',delivery:{policy:'cloud_only'},videos:[{id:'mock-video',width:720,height:1280,duration:5,...source}]});}result=tasks.get(input.task_id);
 }else if(/^\/v1\/canvases\/[^/]+\/video-scenes$/.test(url.pathname)){
  const id=url.pathname.split('/')[3];result=req.method==='POST'?await composeVideoScene(id,body):canvasSceneSummary(await getCanvas(id));
 }else if(/^\/v1\/canvases\/[^/]+$/.test(url.pathname)){const id=url.pathname.split('/')[3];result=req.method==='PUT'?await saveCanvas(id,body):await getCanvas(id);}
 else if(/^\/v1\/videos\/tasks\//.test(url.pathname)){const id=url.pathname.split('/')[4];result=tasks.get(id);if(url.pathname.endsWith('/cancel'))result={...result,cancellation:{state:'already_completed',confirmed:true}};}
 else if(url.pathname==='/v1/videos/files/mock-video/source')result=source;
 else if(url.pathname==='/v1/videos/files/mock-video'){res.end(mp4);return;}
 else throw Error('Unexpected route '+url.pathname);
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch(error){res.writeHead(error.conflict?409:400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:error.message,submitted:false}}));}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));config.port=server.address().port;
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
async function manifest(name,overrides={}) {
 const file=path.join(root,name+'.json');await fs.writeFile(file,JSON.stringify({project:name,ratio:'9:16',images:[{image_id:'original',prompt:'source image',asset_paths:{generated_image:imageFile,sha256}}],shots:[{shot_id:'shot-1',prompt:'slight motion',first_frame_source:'original',mode:'image_to_video',model:'Seedance 2.5',duration:5}],...overrides}));return {manifest_path:file};
}

test('preflight rejects cycles, wrong roles and hash changes before any upload or generation',async()=>{
 const before=uploads;
 const bad=await manifest('bad-hash',{images:[{image_id:'original',prompt:'source',asset_paths:{generated_image:imageFile,sha256:'0'.repeat(64)}}]});
 assert.equal((await preflightWorkflow(bad)).images[0].status,'invalid');await assert.rejects(prepareWorkflow(bad),/SHA256/);
 const cycle=await manifest('cycle',{images:[{image_id:'a',prompt:'a',required_reference_ids:['b']},{image_id:'b',prompt:'b',required_reference_ids:['a']}],shots:[]});await assert.rejects(preflightWorkflow(cycle),/cycle/);
 const roles=await manifest('roles',{shots:[{shot_id:'s',prompt:'p',first_frame_source:'original',mode:'text_to_video'}]});await assert.rejects(preflightWorkflow(roles),/ignore/);
 assert.equal(uploads,before);assert.equal(submissions,0);
});

test('concurrent preparation retains one canvas, one scene and immutable input provenance',async()=>{
 const args=await manifest('prepare');const [a,b]=await Promise.all([prepareWorkflow(args),prepareWorkflow(args)]);
 assert.equal(a.canvas_id,b.canvas_id);assert.equal(a.shots['shot-1'].card_id,b.shots['shot-1'].card_id);
 const doc=await getCanvas(a.canvas_id);assert.equal(doc.cards.length,4);assert.equal(a.images.original.asset.sha256,sha256);
 assert.equal(a.images.original.card_id,(await prepareWorkflow(args)).images.original.card_id);assert.equal(submissions,0);
});

test('bounded dependency runner generates only allowed shots, resumes IDs and exports verified clips',async()=>{
 const args=await manifest('run',{shots:[1,2].map(n=>({shot_id:'shot-'+n,prompt:'slight motion '+n,first_frame_source:'original',model:'Seedance 2.5',duration:5}))});
 await assert.rejects(runWorkflow(args),/live/);const initial=submissions;
 const first=await runWorkflow({...args,live:true,max_new_tasks:1,timeout_seconds:10});assert.equal(first.new_tasks,1);assert.equal(submissions,initial+1);assert.equal(first.shots['shot-2'].task_id,null);
 const second=await runWorkflow({...args,live:true,max_new_tasks:1,timeout_seconds:10});assert.equal(second.new_tasks,1);assert.equal(second.shots['shot-1'].task_id,first.shots['shot-1'].task_id);
 const resumed=await runWorkflow({...args,live:true,max_new_tasks:1,timeout_seconds:10});assert.equal(resumed.new_tasks,0);assert.equal(submissions,initial+2);
 const exported=await exportWorkflow(args,path.join(root,'exports'));assert.equal(exported.complete,true);assert.equal(exported.clips.length,2);assert.equal(exported.clips[0].sha256,createHash('sha256').update(mp4).digest('hex'));
 assert.equal((await exportWorkflow(args,path.join(root,'exports'))).manifest_file,exported.manifest_file);
 const paused=await cancelWorkflow(args);assert.equal(paused.paused,true);assert.equal((await runWorkflow({...args,live:true})).new_tasks,0);
});

test('image dependencies use original reference bytes and consume the same bounded task budget',async()=>{
 const args=await manifest('image-dependency',{images:[{image_id:'edit',prompt:'keep character, change light',required_reference_ids:['original']},{image_id:'original',prompt:'source',asset_paths:{generated_image:imageFile,sha256}}],shots:[{shot_id:'edited-shot',prompt:'small motion',first_frame_source:'edit',model:'Seedance 2.5',duration:5}]});
 const count=submissions;const first=await runWorkflow({...args,live:true,max_new_tasks:1,timeout_seconds:10});assert.equal(first.images.edit.status,'completed');assert.equal(first.new_tasks,1);assert.equal(submissions,count);assert.equal(first.images.edit.asset.parent_assets[0].sha256,sha256);assert.ok(first.shots['edited-shot'].card_id);
 const second=await runWorkflow({...args,live:true,max_new_tasks:1,timeout_seconds:10});assert.equal(second.images.edit.task_id,first.images.edit.task_id);assert.equal(second.shots['edited-shot'].status,'completed');assert.equal(submissions,count+1);
});

test('legacy external timeout remains unknown, dependent shot blocked, and is never resent',async()=>{
 const args=await manifest('unknown',{images:[{image_id:'pending',prompt:'missing external image',source:{provider:'openai-compatible',http_status:408,status:'unknown_do_not_resubmit',idempotency_key:'original-external-key'}}],shots:[{shot_id:'blocked',prompt:'motion',first_frame_source:'pending',model:'Seedance 2.5',duration:5}]});
 const count=submissions;const check=await preflightWorkflow(args);assert.equal(check.ready,false);assert.equal(check.images[0].status,'unknown_do_not_resubmit');
 const state=await runWorkflow({...args,live:true,max_new_tasks:5,timeout_seconds:10});assert.equal(state.images.pending.status,'unknown');assert.equal(state.images.pending.model,'gpt-image-2.5');assert.equal(state.images.pending.legacy_request_key,'original-external-key');assert.equal(state.shots.blocked.status,'blocked');assert.equal(state.new_tasks,0);assert.equal(submissions,count);
});
