import assert from 'node:assert/strict';import {test} from 'node:test';
import {reusableFrameImage} from '../public/canvas-image-inputs.js';
test('repeated slot uploads reuse owned sources; shared and independently uploaded images stay intact',()=>{
 const owned={id:'owned',type:'image',frame_owner:'v'},external={id:'external',type:'image'};
 const cards=[owned,external];
 assert.equal(reusableFrameImage(cards,[{from:'owned',to:'v',role:'first_frame'}],'v','first_frame'),owned);
 assert.equal(reusableFrameImage(cards,[{from:'owned',to:'v',role:'first_frame'},{from:'owned',to:'other',role:'first_frame'}],'v','first_frame'),null);
 assert.equal(reusableFrameImage([external],[{from:'external',to:'v',role:'first_frame'}],'v','first_frame'),null);
 assert.equal(reusableFrameImage(cards,[],'v','last_frame'),owned);
 assert.equal(reusableFrameImage(cards,[],undefined,'first_frame'),null);
});
