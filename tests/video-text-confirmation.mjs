import test from 'node:test';
import assert from 'node:assert/strict';
import {textVideoConfirmation,isManualVideoConfirmation} from '../src/video-text-confirmation.js';
import {createVideoTaskStepper} from '../src/video-task-runtime.js';
const options={model:'Seedance 2.0 Fast',duration:5,ratio:'16:9'};
const text='请确认以下视频生成参数：\n- **模型**：Seedance 2.0 Fast\n- **时长**：5 秒\n- **比例**：16:9\n确认后我再开始生成。';
const snapshot=t=>({result:{status:'completed',runId:'58116633029436418',tasks:{total:0},artifacts:[]},messages:[{user_type:2,message_id:'58104919581014530',blocks:[{content:{text_block:{text:t}}}]}]});
const blocks=m=>m.blocks;
test('detects observed text confirmation only when authorized parameters match',()=>{
 assert.equal(textVideoConfirmation(snapshot(text),options,blocks).eligible,true);
 for(const t of [text.replace('5 秒','10 秒'),text.replace('16:9','9:16'),text.replace('Fast','Pro'),text+'需要付费购买'])assert.equal(textVideoConfirmation(snapshot(t),options,blocks).eligible,false);
 assert.equal(textVideoConfirmation(snapshot('确认后我再生成视频'),options,blocks),null);
 const s=snapshot(text);s.result.tasks.total=1;assert.equal(textVideoConfirmation(s,options,blocks),null);
});
test('Seedance 2.5 ordinary pre-generation question with markdown and internal model name',()=>{
 const observed='根据 Seedance 2.5 的调用规范，生成前需要与你确认以下信息：\n**模型**：`seedance_2.5`（固定）\n**时长**：5 秒（用户指定）\n**比例**：`9:16`（用户指定）\n是否按以上信息使用 Seedance 2.5 生成？';
 assert.equal(textVideoConfirmation(snapshot(observed),{model:'Seedance 2.5',duration:5,ratio:'9:16'},blocks).eligible,true);
 assert.equal(textVideoConfirmation(snapshot(observed),options,blocks).eligible,false);
 const s=snapshot(observed);s.result.artifacts=[{type:'video'}];assert.equal(textVideoConfirmation(s,options,blocks),null);
});
test('unmatched parameter question remains waiting and never extracts',async()=>{
 const job={id:'task',conversationId:'38446428543242754',runId:'58116633029436418',status:'running',autoConfirm:true,options};
 const step=createVideoTaskStepper({inspect:async()=>({status:'completed',pending:[],textConfirmation:{id:'text:original:message',eligible:false}}),confirm:async()=>({confirmed:false}),extraction:{has:()=>false,add:()=>assert.fail('confirmation is not a finished video')},save:async()=>{}});
 await step(job);assert.equal(job.status,'waiting_input');assert.equal(job.phase,'awaiting_confirmation');assert.equal(job.error,null);
});
test('text confirmation continues the same job and preserves its original receipt',async()=>{
 const job={id:'task',conversationId:'38446428543242754',runId:'58116633029436418',status:'running',autoConfirm:true,options};let saved=0,extracted=0;
 const step=createVideoTaskStepper({inspect:async()=>({status:'completed',pending:[],textConfirmation:{id:'text:original:message',messageId:'message'}}),confirm:async(c,r,o,attempts,before,ack)=>{await before('text:original:message');await ack({conversationId:c,runId:'58116633029436419'});return {confirmed:true,clarifyId:'text:original:message',runId:'58116633029436419'};},extraction:{has:()=>false,add:()=>extracted++},save:async()=>saved++});
 await step(job);assert.equal(job.runId,'58116633029436418');assert.equal(job.generationRunId,'58116633029436419');assert.equal(job.status,'running');assert.equal(extracted,0);assert.ok(saved>=3);assert.deepEqual(job.confirmationAttemptedIds,['text:original:message']);
});
test('lost text confirmation ACK is never resent automatically',async()=>{
 const job={id:'task',conversationId:'38446428543242754',runId:'58116633029436418',status:'running',autoConfirm:true,options};let sends=0;
 const step=createVideoTaskStepper({inspect:async()=>({status:'completed',pending:[],textConfirmation:{id:'text:original:message'}}),confirm:async(c,r,o,attempts,before)=>{if(attempts.includes('text:original:message'))return {confirmed:false};await before('text:original:message');sends++;throw Error('connection lost');},extraction:{has:()=>false,add:()=>assert.fail('must not extract')},save:async()=>{}});
 await step(job);await step(job);assert.equal(sends,1);assert.equal(job.status,'unknown');
});

test('only adopts an immediately following explicit manual confirmation',()=>{
 const s={result:{runId:'new'},root:{blocks:[{content:{text_block:{text:'确认'}}}]},conversation:{messages:[{user_type:1,message_id:'old',index_in_conv:'1'},{user_type:1,message_id:'new',index_in_conv:'3'}]}};
 assert.equal(isManualVideoConfirmation(s,'old',blocks),true);
 s.root.blocks[0].content.text_block.text='再生成两条';assert.equal(isManualVideoConfirmation(s,'old',blocks),false);
 s.root.blocks[0].content.text_block.text='确认';s.conversation.messages.push({user_type:1,message_id:'other',index_in_conv:'2'});assert.equal(isManualVideoConfirmation(s,'old',blocks),false);
});
