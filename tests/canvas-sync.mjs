import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeCanvasDocuments} from '../public/canvas-sync.js';
const fixture=()=>({id:'canvas',version:1,title:'test',viewport:{x:0,y:0,zoom:1},cards:[{id:'a',type:'note',text:'a'},{id:'b',type:'video',prompt:'p',request_key:'key'}],edges:[]});
test('task receipts merge with local layout and normalized upload metadata without creating a conflict copy',()=>{
  const base=fixture();base.cards.push({id:'image',asset:{path:'uploads/a.png',sha256:'hash'}});
  const local=structuredClone(base),remote=structuredClone(base);local.cards[1].x=20;local.cards[2].asset.file='/local/a.png';remote.version=2;remote.cards[1].task_id='original-task';
  const result=mergeCanvasDocuments(base,local,remote);assert.equal(result.version,2);assert.equal(result.cards[1].x,20);assert.equal(result.cards[1].task_id,'original-task');assert.equal(result.cards[2].asset.sha256,'hash');
});
test('disjoint client edits merge while competing changes to the same prompt remain conflicts',()=>{
  const base=fixture(),local=structuredClone(base),remote=structuredClone(base);local.cards[0].text='local';remote.cards[1].prompt='remote';remote.version=2;
  const result=mergeCanvasDocuments(base,local,remote);assert.equal(result.cards[0].text,'local');assert.equal(result.cards[1].prompt,'remote');
  remote.cards[0].text='competing';assert.equal(mergeCanvasDocuments(base,local,remote),null);
});
test('object key order does not create conflicts; deleting an item cannot discard another client edit',()=>{
  const base=fixture(),local=structuredClone(base),remote=structuredClone(base);remote.viewport={zoom:1,y:0,x:0};local.viewport.x=42;
  assert.equal(mergeCanvasDocuments(base,local,remote).viewport.x,42);
  local.cards=local.cards.filter(c=>c.id!=='a');remote.cards[0].text='changed';assert.equal(mergeCanvasDocuments(base,local,remote),null);
});
