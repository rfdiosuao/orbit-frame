import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRunImages } from '../src/enterprise-image-client.js';
const full='https://p6-flow-sign.byteimg.com/original.png';
const tool={ block_type:10010, content:{gen_image_block:{images:[{full_size_url:['https://p11-flow-imagex-sign.byteimg.com/duplicate.png']}],icon_url:'https://example.com/icon.png'}}};
const card={block_type:10084,content:{rich_media_layout_block:{media:[{creation:{type:1,image:{status:2,image_ori_raw:{url:full},image_thumb:{url:'https://p3-flow-sign.byteimg.com/thumb.png'}}}}]}}};
const message=(blocks,user_type=2)=>({user_type,content_block:blocks});
test('prefers original generated images and never expands thumbnails, tools and repeated snapshots into extra results',()=>{
 const m=message([tool,card]);assert.deepEqual(extractRunImages({messages:[m],nodes:[{messages:[m]}]}),[full]);
});
test('uses image tool attachments when there is no completed image card, excluding user images and fake hosts',()=>{
 assert.equal(extractRunImages({messages:[message([tool])]}).length,1);
 assert.deepEqual(extractRunImages({messages:[message([card],1)]}),[]);
 const bad=structuredClone(card);bad.content.rich_media_layout_block.media[0].creation.image.image_ori_raw.url='https://byteimg.com.evil.example/a.png';
 assert.deepEqual(extractRunImages({messages:[message([bad])]}),[]);
});


test('takes the recorded original download over a tool thumbnail without executing the command', () => {
 const recorded = {block_type:10019,content:{file_operation_block:{display_content:{exit_code:0,operation:'curl -L "https://p3-flow-sign.byteimg.com/large.png" -o /workspace/generated.png'}}}};
 assert.deepEqual(extractRunImages({messages:[message([tool,recorded])]}),['https://p3-flow-sign.byteimg.com/large.png']);
 assert.deepEqual(extractRunImages({messages:[message([recorded])]}),[]);
 const failed = structuredClone(recorded); failed.content.file_operation_block.display_content.exit_code=1;
 assert.deepEqual(extractRunImages({messages:[message([tool,failed])]}),['https://p11-flow-imagex-sign.byteimg.com/duplicate.png']);
});
test('chooses the largest declared original variant', () => {
 const variants = structuredClone(card); const image=variants.content.rich_media_layout_block.media[0].creation.image;
 image.image_ori_raw={url:full,width:384,height:216};image.image_ori={url:'https://p3-flow-sign.byteimg.com/full.png',width:2048,height:1152};
 assert.deepEqual(extractRunImages({messages:[message([variants])]}),['https://p3-flow-sign.byteimg.com/full.png']);
});
