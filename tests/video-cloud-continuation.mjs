import {test} from 'node:test';
import assert from 'node:assert/strict';
import {continueCloudDeliveryOnce} from '../src/video-cloud-continuation.js';
const state={videos:[{kind:'file'}]}, missing={status:'video_missing'};
const job=()=>({conversationId:'38445420907112962',runId:'58007921091859714',status:'video_missing'});
test('cloud-only continuation persists intent before sending, keeps the original generation run, and resumes a delivery run',async()=>{
 const j=job(), saved=[];let calls=0;
 const options={save:async value=>saved.push(structuredClone(value)),request:async id=>{calls++;assert.equal(saved[0].deliveryAttempted,true);assert.equal(id,j.conversationId);return{conversationId:id,runId:'58007921091859999'};}};
 assert.equal(await continueCloudDeliveryOnce(j,state,missing,options),true);
 assert.equal(j.runId,'58007921091859714');assert.equal(j.deliveryRunId,'58007921091859999');assert.equal(j.phase,'extracting');
 assert.equal(await continueCloudDeliveryOnce(j,state,missing,options),false);assert.equal(calls,1);
});
test('a lost delivery ACK survives reload without resending, and missing attachment or completed tasks never send',async()=>{
 let calls=0;const j=job(),options={save:async()=>{},request:async()=>{calls++;throw new Error('lost ACK');}};
 await continueCloudDeliveryOnce(j,state,missing,options);assert.equal(j.status,'unknown');assert.equal(j.error.code,'delivery_unknown');
 assert.equal(await continueCloudDeliveryOnce(JSON.parse(JSON.stringify(j)),state,missing,options),false);
 assert.equal(await continueCloudDeliveryOnce(job(),{videos:[{kind:'creation'}]},missing,options),false);
 assert.equal(await continueCloudDeliveryOnce(job(),state,{status:'completed'},options),false);assert.equal(calls,1);
});
test('a completed original native card with matching parameters requests delivery once without making the card downloadable',async()=>{
 const j={...job(),options:{duration:10,ratio:'9:16'},frames:[{role:'first_frame',sha256:'original'}]};
 const card={kind:'creation',creationId:'10727376274690',vid:'v0d69cg10004db4t6hq7dldb3b8eq3r0',duration:10.049,width:720,height:1280};
 const s={status:'completed',videos:[card]};let calls=0;
 const options={save:async()=>{},request:async id=>{calls++;return{conversationId:id,runId:'58007921091859999'};}};
 assert.equal(await continueCloudDeliveryOnce(j,s,missing,options),true);
 assert.equal(j.runId,'58007921091859714');assert.equal(j.frames[0].sha256,'original');
 assert.equal(card.kind,'creation');assert.equal(j.videos,undefined);
 assert.equal(await continueCloudDeliveryOnce(j,s,missing,options),false);assert.equal(calls,1);
 for(const change of [{status:'running'},{videos:[{...card,creationId:''}]},{videos:[{...card,vid:''}]},
   {videos:[{...card,duration:20}]},{videos:[{...card,width:1280,height:720}]}])
   assert.equal(await continueCloudDeliveryOnce({...job(),options:{duration:10,ratio:'9:16'}},{...s,...change},missing,options),false);
 assert.equal(calls,1);
});
