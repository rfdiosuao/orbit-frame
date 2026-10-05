import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEligibleVideoConfirmationAsk } from '../src/enterprise-video-client.js';

const exactAsk = {
  status: 1, clarify_id: '296ea37b-c988-45ef-bbde-aac91704b8a0',
  questions: [{ question_id: 'final_generation_confirm', type: 3,
    title: '以上是本次视频生成的完整参数，请确认是否按要求生成？',
    question_capability: { allow_text: true } }],
};

test('accepts the observed final video parameter confirmation', () => {
  assert.equal(isEligibleVideoConfirmationAsk(exactAsk), true);
});

test('does not expand confirmation beyond the exact single video ask', () => {
  assert.equal(isEligibleVideoConfirmationAsk(exactAsk, [exactAsk.clarify_id]), false);
  assert.equal(isEligibleVideoConfirmationAsk({ ...exactAsk, status: 2 }), false);
  assert.equal(isEligibleVideoConfirmationAsk({ ...exactAsk, questions: [...exactAsk.questions, ...exactAsk.questions] }), false);
  for (const change of [
    { question_id: 'other_confirmation' },
    { title: '确认是否支付生成费用？' },
    { type: 2 },
    { question_capability: { allow_text: false } },
  ]) {
    assert.equal(isEligibleVideoConfirmationAsk({ ...exactAsk, questions: [{ ...exactAsk.questions[0], ...change }] }), false);
  }
});

const choiceAsk = {status:1,clarify_id:'choice-ask',questions:[{question_id:'confirm_generate_video',type:1,title:'是否按以上参数开始生成这段 5 秒、16:9 的视频？',options:[{label:'按要求生成',option_id:'go'},{label:'暂不生成',option_id:'cancel'}],question_capability:{allow_text:true}}]};
test('accepts the actual video generation choice while rejecting ambiguous or paid asks',()=>{
 assert.equal(isEligibleVideoConfirmationAsk(choiceAsk),true);
 for (const change of [{title:'是否支付费用后生成视频？'},{options:[{label:'按要求生成',option_id:'go'},{label:'立即生成',option_id:'go2'}]},{options:[{label:'暂不生成',option_id:'cancel'}]},{options:[{label:'按要求生成',description:'支付后生成',option_id:'go'}]}]){
  assert.equal(isEligibleVideoConfirmationAsk({...choiceAsk,questions:[{...choiceAsk.questions[0],...change}]}),false);
 }
});
