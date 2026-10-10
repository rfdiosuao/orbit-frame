import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {textVideoConfirmation} from '../src/video-text-confirmation.js';
import {extractCloudVideos,selectCloudVideos} from '../src/video-delivery.js';
import {createVideoTaskStepper} from '../src/video-task-runtime.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/seedance25-text-and-cloud.json',import.meta.url)));
const snapshot=text=>({result:{status:'completed',runId:'58100000000000001',tasks:{total:0},artifacts:[]},messages:[{user_type:2,message_id:'58100000000000002',blocks:[{content:{text_block:{text}}}]}]});
const options={model:'Seedance 2.5',duration:5,ratio:'16:9'};
const entries=blocks=>blocks.map(block=>({block,messageId:'58100000000000003',group:'main'}));
test('replays real expanded confirmation and punctuation variants without requiring exact prose',()=>{
 for(const text of [fixture.confirmationText,fixture.confirmationText.replace('生成这段 5 秒、16:9 的视频？','生成视频吗？'),fixture.confirmationText.replace('是否按以上信息使用 Seedance 2.5 生成这段 5 秒、16:9 的视频？','请确认上面的参数。')]) {
  for(let i=0;i<3;i++)assert.equal(textVideoConfirmation(snapshot(text),options,m=>m.blocks).eligible,true);
  assert.equal(textVideoConfirmation(snapshot(text),{...options,duration:10},m=>m.blocks).eligible,false);
 }
});
test('replays flattened tool records and file copy before successful upload',()=>{
 for(let i=0;i<3;i++){
 const selected=selectCloudVideos(extractCloudVideos(entries(fixture.blocks))).selected;
 assert.equal(selected.length,1);assert.equal(selected[0].source,'https://aka.doubaocdn.com/s/fixture_video');assert.equal(selected[0].expectedBytes,697573);
 }
});
test('flattened records reject failed upload, transformed copy, unproven copy and other threads',()=>{
 for(const modify of [
 blocks=>{blocks[2].content.file_operation_block.content=blocks[2].content.file_operation_block.content.replace('Exit code 0','Exit code 1')},
 blocks=>{blocks[1].content.file_operation_block.content=blocks[1].content.file_operation_block.content.replace(' && ls -lh',' && ffmpeg -i')},
 blocks=>{blocks[1].content.file_operation_block.content=blocks[1].content.file_operation_block.content.replace('cp /home/user/.doubao/agent_mode/workspace/dog_seedance.mp4','cp /other.mp4')},
 blocks=>{blocks[2].content.file_operation_block.content=blocks[2].content.file_operation_block.content.replace('"ok": true','"ok": false')},
 ]){const blocks=structuredClone(fixture.blocks);modify(blocks);assert.deepEqual(extractCloudVideos(entries(blocks)),[])}
 const separate=entries(fixture.blocks);separate[2].group='other';assert.deepEqual(extractCloudVideos(separate),[]);
});
test('text-only completed reply never reaches extraction even when its question wording is unknown',async()=>{
 const job={id:'test',conversationId:'58100000000000000',runId:'58100000000000001',options,autoConfirm:true};
 const step=createVideoTaskStepper({inspect:async()=>({status:'completed',pending:[],videos:[],generationObserved:false}),confirm:async()=>assert.fail('cannot guess consent'),extraction:{has:()=>false,add:()=>assert.fail('text completion is not video completion')},save:async()=>{}});
 for(let i=0;i<3;i++){await step(job);assert.equal(job.status,'waiting_input');assert.equal(job.phase,'awaiting_confirmation')}
});
test('real horizontal delivery supports mkdir, harmless shell preamble, home cwd and SDK footer',()=>{
 const {blocks}=JSON.parse(fs.readFileSync(new URL('./fixtures/seedance25-horizontal-cloud.json',import.meta.url)));
 for(let i=0;i<3;i++){const selected=extractCloudVideos(entries(blocks));assert.equal(selected.length,1);assert.equal(selected[0].expectedBytes,902793);assert.equal(selected[0].source,'https://aka.doubaocdn.com/s/fixture_horizontal')}
 const changed=structuredClone(blocks);changed[1].content.file_operation_block.content=changed[1].content.file_operation_block.content.replace('pwd; echo "---";','rm /other;');assert.deepEqual(extractCloudVideos(entries(changed)),[]);
 const invalid=structuredClone(blocks);invalid[2].content.file_operation_block.content=invalid[2].content.file_operation_block.content.replace('cd ~/files','cd ~/other');assert.deepEqual(extractCloudVideos(entries(invalid)),[]);
});
