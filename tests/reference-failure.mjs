import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractReferenceFailure} from '../src/reference-failure.js';
import {createVideoTaskStepper, canWatchVideoJob, reassessVideoReferenceFailure} from '../src/video-task-runtime.js';

const snapshot=(text,user_type=2)=>({messages:[{user_type,message_id:'message',content_block:[{block_id:'block',block_type:10000,content:{text_block:{text}}}]}]});
test('explicit attachment failures reject redraws; user instructions and conditional warnings are not failure evidence',()=>{
  for(const text of ['我无法读取上传的原图，所以重新画一张。','你的首帧附件无法访问。','我读不到你上传的图片。','I cannot access the uploaded image.']) assert.equal(extractReferenceFailure(snapshot(text))?.code,'reference_unreadable');
  assert.equal(extractReferenceFailure(snapshot('如果无法读取上传的原图，请停止。')),null);
  assert.equal(extractReferenceFailure(snapshot('无法读取上传的原图',1)),null);
  assert.equal(extractReferenceFailure(snapshot('已经使用你的原图生成视频。')),null);
});
test('the real GEN-1 URL-route recovery is not an unreadable original, but another genuine failure still rejects it',()=>{
  const real = '附件 URL 无法直接访问，我先上传本地首帧图片获取可用链接';
  assert.equal(extractReferenceFailure(snapshot(real)),null);
  for(const text of [real+'。但我无法读取上传的原图，所以改用文字重绘。',
    '我无法读取上传的原图，所以重新绘制后上传本地首帧图片获取可用链接。',
    real+'，但本地首帧也无法读取。']) {
    assert.equal(extractReferenceFailure(snapshot(text))?.code,'reference_unreadable');
  }
});
test('the real GEN-4 URL-route recovery preserves rejection of genuine local-frame failures',()=>{
  const real = '附件URL无法被视频服务直接访问，我先把本地首帧图上传获取可用链接';
  assert.equal(extractReferenceFailure(snapshot(real)),null);
  for(const text of [real+'。但本地首帧无法读取，所以重绘。',
    real+'，但原图无法访问。',
    '附件原图无法读取，我先把本地首帧图上传获取可用链接。',
    '附件URL无法被视频服务直接访问，我先把重新绘制的首帧图上传获取可用链接。']) {
    assert.equal(extractReferenceFailure(snapshot(text))?.code,'reference_unreadable');
  }
});
test('explicit reference reassessment keeps the original task, frames, parameters and failure evidence without mutating the upstream',async()=>{
  const frames=[{role:'first_frame',sha256:'original-frame'}],options={duration:10,ratio:'9:16',model:'Seedance 2.5'};
  const job={id:'original',conversationId:'123',runId:'456',frames,options,status:'failed',error:{code:'reference_unreadable',submitted:true},reference_failure:{message_id:'58006254508683778',block_id:'fd4bf1ad-7b04-46df-a967-b94eb547338a'}};
  const calls=[],saved=[],queued=[];
  const result=await reassessVideoReferenceFailure(job,{inspect:async(c,r,args)=>{calls.push([c,r,args]);return {status:'completed',pending:[],videos:[],reference_failure:null};},extraction:{has:()=>false,add:(id,state)=>queued.push([id,state.status])},save:async j=>saved.push(structuredClone(j))});
  assert.equal(result,true);assert.deepEqual(calls,[['123','456',{fresh:true,deliveryRunId:null}]]);
  assert.equal(saved[0].status,'failed');assert.equal(saved[0].failureHistory[0].error.code,'reference_unreadable');
  assert.deepEqual(queued,[['original','completed']]);assert.equal(job.phase,'extracting');assert.equal(canWatchVideoJob(job),false);
  assert.equal(job.id,'original');assert.equal(job.runId,'456');assert.equal(job.frames,frames);assert.equal(job.options,options);
  assert.equal(job.failureHistory[0].reference_failure.message_id,'58006254508683778');
});
test('the real GEN-2-v2 URL read-route recovery still rejects unreadable original frames and redraws',()=>{
  const real='附件 URL 无法被视频服务读取，我先把本地首帧图上传获取可用链接。';
  assert.equal(extractReferenceFailure(snapshot(real)),null);
  for(const text of [real+'但本地首帧无法读取。',
    '附件原图无法被视频服务读取，我先把本地首帧图上传获取可用链接。',
    '附件 URL 无法被视频服务读取，我先把重新绘制的首帧图上传获取可用链接。'])
    assert.equal(extractReferenceFailure(snapshot(text))?.code,'reference_unreadable');
});
test('completed media does not override a genuine original-reference failure during reassessment',async()=>{
  const job={id:'original',conversationId:'123',runId:'456',frames:[{role:'first_frame'}],status:'failed',error:{code:'reference_unreadable'}};
  let queued=0;
  await reassessVideoReferenceFailure(job,{inspect:async()=>({status:'completed',videos:[{kind:'file'}],reference_failure:{code:'reference_unreadable'}}),extraction:{has:()=>false,add:()=>queued++},save:async()=>{}});
  assert.equal(queued,0);assert.equal(job.status,'failed');assert.equal(job.error.code,'reference_unreadable');
  assert.equal(job.recoveryHistory[0].outcome,'reference_failure_still_present');
});
test('uncertain reassessment preserves failure and an unrelated terminal failure is not reopened',async()=>{
  const job={id:'original',conversationId:'123',runId:'456',frames:[{role:'first_frame'}],status:'failed',error:{code:'reference_unreadable'}};
  let reads=0;
  const dependencies={inspect:async()=>{reads++;throw Error('socket disconnected');},extraction:{has:()=>false,add:()=>{throw Error('must not extract');}},save:async()=>{}};
  await reassessVideoReferenceFailure(job,dependencies);assert.equal(job.status,'failed');assert.equal(job.error.code,'reference_unreadable');assert.equal(job.recoveryHistory[0].outcome,'observation_failed');
  job.error={code:'different_failure'};assert.equal(await reassessVideoReferenceFailure(job,dependencies),false);assert.equal(reads,1);
});
test('a completed redraw cannot enter cloud extraction when the original frame was unreadable',async()=>{
  let extracted=0;const job={id:'reference',conversationId:'123',runId:'456',status:'running',createdAt:new Date().toISOString(),frames:[{role:'first_frame'}]};
  const step=createVideoTaskStepper({inspect:async()=>({status:'completed',reference_failure:{code:'reference_unreadable'}}),extraction:{has:()=>false,add:()=>extracted++},save:async()=>{}});
  await step(job);assert.equal(job.status,'failed');assert.equal(job.error.code,'reference_unreadable');assert.equal(extracted,0);
});
test('an active unreadable reference attempts to cancel only the original run and preserves an uncertain cancellation',async()=>{
  const calls=[];const job={id:'reference',conversationId:'123',runId:'456',status:'running',createdAt:new Date().toISOString(),frames:[{role:'first_frame'}]};
  const step=createVideoTaskStepper({inspect:async()=>({status:'waiting_input',reference_failure:{code:'reference_unreadable'}}),extraction:{has:()=>false},save:async()=>{},cancel:async(c,r)=>{calls.push([c,r]);throw Error('lost ACK');}});
  await step(job);assert.deepEqual(calls,[['123','456']]);assert.equal(job.status,'failed');assert.equal(job.cancellation.confirmed,false);assert.equal(job.cancellation.state,'unknown');
});
test('auto-confirm jobs keep observing an unrecognized question and resume the same run after a manual answer',async()=>{
  let answered=false,reads=0,extracted=0;const job={id:'question',conversationId:'123',runId:'456',status:'running',autoConfirm:true,createdAt:new Date().toISOString()};
  const step=createVideoTaskStepper({inspect:async()=>{reads++;return answered?{status:'completed',pending:[]}:{status:'waiting_input',pending:[{clarifyId:'unrecognized'}]};},confirm:async()=>({confirmed:false}),extraction:{has:()=>false,add:()=>extracted++},save:async()=>{}});
  await step(job);assert.equal(job.status,'waiting_input');assert.equal(canWatchVideoJob(job),true);
  answered=true;await step(job);assert.equal(reads,2);assert.equal(extracted,1);assert.equal(job.runId,'456');
});
