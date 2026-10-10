import {test} from 'node:test';
import assert from 'node:assert/strict';
import {restoreHistoryCard} from '../public/canvas-history.js';
test('undo restores a replaced uploaded image while retaining later generated output',()=>{
 const original={path:'uploads/a.png',sha256:'a'},replacement={path:'uploads/b.png',sha256:'b'};
 const restored=restoreHistoryCard({id:'image',type:'image',asset:original},{id:'image',type:'image',status:'ready',asset:replacement});assert.deepEqual(restored.asset,original);
 const generated={...replacement,source_task_id:'original-image-job'};
 const kept=restoreHistoryCard({id:'image',type:'image',asset:null},{id:'image',type:'image',status:'ready',asset:generated,assets:[generated]});assert.deepEqual(kept.asset,generated);assert.equal(kept.status,'ready');
});
test('undo cannot revert the model, prompt or immutable inputs of a submitted video',()=>{
 const snapshot={id:'video',type:'video',x:0,model:'Seedance 2.0 Fast',prompt:'old',duration:5,ratio:'16:9'};
 const current={...snapshot,x:10,model:'Seedance 2.5',prompt:'submitted',duration:30,ratio:'9:16',request_key:'original',task_id:'task',input_frames:[{role:'first_frame',asset:{sha256:'original'}}]};
 const restored=restoreHistoryCard(snapshot,current);assert.equal(restored.x,0);for(const key of ['model','prompt','duration','ratio','request_key','task_id','input_frames'])assert.deepEqual(restored[key],current[key]);
});
