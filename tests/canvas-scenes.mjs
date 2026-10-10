import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-scene-'));
process.env.ORBIT_FRAME_MEDIA_DIR=path.join(root,'media');
process.env.DOUBAO_CDP_ENDPOINT='http://127.0.0.1:0';
const {config}=await import('../src/config.js');config.dataDir=path.join(root,'data');
const {createCanvas,getCanvas,saveCanvas}=await import('../src/canvas-store.js');
const {composeVideoScene,reserveVideoScene,canvasSceneSummary,releaseRejectedScene}=await import('../src/canvas-scenes.js');
const {createApp}=await import('../src/gateway.js');
after(()=>fs.rm(root,{recursive:true,force:true}));
await fs.mkdir(path.join(config.mediaDir,'generated'),{recursive:true});
function png(n){const b=Buffer.alloc(33,n);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IHDR',12);b.writeUInt32BE(1280,16);b.writeUInt32BE(720,20);return b;}
await fs.writeFile(path.join(config.mediaDir,'generated','a.png'),png(1));await fs.writeFile(path.join(config.mediaDir,'generated','b.png'),png(2));
const args={prompt:'从首帧缓慢过渡到尾帧',first_frame:{path:'generated/a.png'},last_frame:{path:'generated/b.png'}};

test('scene composition binds all three roles and updates preserve unrelated cards',async()=>{
 const doc=await createCanvas({cards:[{id:'keep',type:'note',x:0,y:0,text:'keep me'}]});
 const first=await composeVideoScene(doc.id,args);let input=first.scenes[0];
 assert.equal(first.card_id,input.card_id);assert.equal(input.mode,'first_last_frame');assert.deepEqual(input.missing,[]);
 const saved=await getCanvas(doc.id);assert.equal(saved.edges.length,3);assert.ok(saved.cards.some(c=>c.id==='keep'));
 const changed=await composeVideoScene(doc.id,{card_id:input.card_id,prompt:'只用首帧',first_frame:{path:'generated/b.png'}});
 assert.equal(changed.scenes.length,1);assert.equal(changed.scenes[0].mode,'image_to_video');assert.equal(changed.scenes[0].first_frame.path,'generated/b.png');
 assert.equal((await getCanvas(doc.id)).edges.filter(e=>e.to===input.card_id).length,2);
 assert.equal((await getCanvas(doc.id)).cards.length,4,'updating owned inputs does not accumulate duplicate cards');
});

test('two reservations share a key and freeze the prompt and frame inputs',async()=>{
 const doc=await createCanvas({});const composed=await composeVideoScene(doc.id,args);
 const [a,b]=await Promise.all([reserveVideoScene(doc.id,composed.card_id),reserveVideoScene(doc.id,composed.card_id)]);
 assert.equal(a.idempotency_key,b.idempotency_key);assert.equal(a.task_id,b.task_id);
 await assert.rejects(composeVideoScene(doc.id,{...args,card_id:composed.card_id,prompt:'replace'}),e=>e.invalid);
 const loaded=await getCanvas(doc.id);loaded.cards.find(c=>c.type==='note').text='later edit';loaded.cards.find(c=>c.type==='image').asset.path='generated/b.png';
 await saveCanvas(doc.id,loaded);const frozen=canvasSceneSummary(await getCanvas(doc.id)).scenes[0];
 assert.equal(frozen.prompt,args.prompt);assert.equal(frozen.first_frame.path,'generated/a.png');assert.equal(frozen.editable,false);
 await releaseRejectedScene(doc.id,composed.card_id,a.idempotency_key);assert.equal(canvasSceneSummary(await getCanvas(doc.id)).scenes[0].editable,true);
});

test('scene API rejects missing roles before submitting and resumes known tasks without generation',async()=>{
 const server=createApp().listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:`Bearer ${config.localApiKey}`,'Content-Type':'application/json'};
 try {
  const doc=await createCanvas({cards:[{id:'empty',type:'video',x:0,y:0,prompt:'',duration:5,ratio:'16:9'}]});
  const endpoint=`${base}/v1/canvases/${doc.id}/video-scenes/empty/generate`;
  assert.equal((await fetch(endpoint,{method:'POST',body:'{}'})).status,401);
  const bad=await fetch(endpoint,{method:'POST',headers,body:'{}'});assert.equal(bad.status,400);assert.equal((await bad.json()).error.submitted,false);
  assert.equal((await getCanvas(doc.id)).version,1);
  const composed=await composeVideoScene(doc.id,args),reserved=await reserveVideoScene(doc.id,composed.card_id);
  const jobDir=path.join(config.dataDir,'enterprise-video-jobs');await fs.mkdir(jobDir,{recursive:true});
  await fs.writeFile(path.join(jobDir,reserved.task_id+'.json'),JSON.stringify({id:reserved.task_id,status:'completed',options:{duration:5,ratio:'16:9',mode:'first_last_frame'},frames:[],videos:[],confirmedIds:[],createdAt:new Date().toISOString()}));
  const before=(await getCanvas(doc.id)).version;
  const resumed=await fetch(`${base}/v1/canvases/${doc.id}/video-scenes/${composed.card_id}/generate`,{method:'POST',headers,body:'{}'});
  assert.equal(resumed.status,200);assert.equal((await resumed.json()).task_id,reserved.task_id);assert.equal((await getCanvas(doc.id)).version,before);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
