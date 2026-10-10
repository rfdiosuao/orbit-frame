import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEligibleVideoConfirmationAsk } from '../src/enterprise-video-client.js';

const exactAsk = {
  status: 1, clarify_id: '296ea37b-c988-45ef-bbde-aac91704b8a0',
  questions: [{ question_id: 'final_generation_confirm', type: 3,
    title: '以上是本次视频生成的完整参数，请确认是否按要求生成？',
    question_capability: { allow_text: true } }],
};

test('accepts the observed Seedance 2.5 vertical frame confirmation once',()=>{
  const ask={status:1,clarify_id:'seedance-vertical',questions:[{question_id:'confirm_seedance_gen',type:3,title:'是否按以上方案（Seedance 2.5 / 5秒 / 9:16 / 以 first_frame.png 为首帧）开始生成视频？视频生成为高消耗生成。',question_capability:{allow_text:true}}]};
  assert.equal(isEligibleVideoConfirmationAsk(ask),true);
  assert.equal(isEligibleVideoConfirmationAsk(ask,['seedance-vertical']),false);
  assert.equal(isEligibleVideoConfirmationAsk({...ask,questions:[{...ask.questions[0],title:'是否支付费用后生成视频？'}]}),false);
});

test('accepts the observed Seedance 2.5 final confirmation, not a purchase or repeated answer', () => {
  const ask = { status: 1, clarify_id: 'seedance25-final', questions: [{
    question_id: 'final_confirm_seedance25', type: 3,
    title: '以上为本次视频生成的完整参数，确认后将严格使用 seedance_2.5 模型生成（不降级、不拆段、不追加）。是否按要求生成？',
    question_capability: { allow_text: true },
  }] };
  assert.equal(isEligibleVideoConfirmationAsk(ask), true);
  assert.equal(isEligibleVideoConfirmationAsk(ask, ['seedance25-final']), false);
  assert.equal(isEligibleVideoConfirmationAsk({ ...ask, questions: [{ ...ask.questions[0], title: '是否购买会员后生成视频？' }] }), false);
});

test('accepts observed 15 and 30 second Seedance 2.5 choices without accepting payment', () => {
  for (const [question_id, duration] of [['confirm_generate_seedance_25', 15], ['confirm_seedance_25_30s', 30]]) {
    const ask = { status: 1, clarify_id: `${duration}-second-confirm`, questions: [{
      question_id, type: 1, title: `以上参数是否按要求生成 ${duration} 秒视频？Seedance 2.5 为会员专属模型，生成消耗较大。`,
      question_capability: { allow_text: true }, options: [
        { label: '按要求生成', description: `使用 seedance_2.5 生成 1 条 ${duration} 秒视频`, option_id: 'go' },
        { label: '暂不生成', option_id: 'stop' },
      ],
    }] };
    assert.equal(isEligibleVideoConfirmationAsk(ask), true);
    assert.equal(isEligibleVideoConfirmationAsk(ask, [ask.clarify_id]), false);
    assert.equal(isEligibleVideoConfirmationAsk({ ...ask, questions: [{ ...ask.questions[0], title: '是否购买会员后生成视频？' }] }), false);
  }
});

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

test('accepts the desktop Seedance final_video_confirm choice', () => {
  const ask = { status: 1, clarify_id: 'desktop-choice', questions: [{
    question_id: 'final_video_confirm', type: 1, title: '以上参数是否确认开始生成？',
    options: [{ label: '按要求生成', description: '使用 Seedance 2.0 Fast 生成 5 秒 16:9 首尾帧过渡视频，仅生成一次', option_id: 'generate' },
      { label: '暂不生成', description: '停止本次生成，不调用视频工具', option_id: 'cancel' }],
    question_capability: { allow_text: true },
  }] };
  assert.equal(isEligibleVideoConfirmationAsk(ask), true);
});

test('accepts the observed final_confirm_generate text confirmation but rejects a payment variant', () => {
  const ask = { status: 1, clarify_id: 'final-text', questions: [{ question_id: 'final_confirm_generate',
    type: 3, title: '以上参数是否确认开始生成？', question_capability: { allow_text: true } }] };
  assert.equal(isEligibleVideoConfirmationAsk(ask), true);
  assert.equal(isEligibleVideoConfirmationAsk(ask, ['final-text']), false);
  assert.equal(isEligibleVideoConfirmationAsk({ ...ask, questions: [{ ...ask.questions[0], title: '以上参数是否确认付费开始生成？' }] }), false);
});

test('accepts the observed first/last frame confirmation once, rejects paid or answered variants', () => {
  const ask = { status: 1, clarify_id: 'frame-confirm', questions: [{ question_id: 'final_confirm_first_last_frame', type: 3,
    title: '以上参数已锁定，是否按此方案生成这条 5 秒首尾帧过渡视频？', question_capability: { allow_text: true } }] };
  assert.equal(isEligibleVideoConfirmationAsk(ask), true);
  assert.equal(isEligibleVideoConfirmationAsk(ask, ['frame-confirm']), false);
  assert.equal(isEligibleVideoConfirmationAsk({ ...ask, questions: [{ ...ask.questions[0], title: '以上参数已锁定，是否付费生成视频？' }] }), false);
});

test('accepts the observed confirm_generate choice once and rejects payment or ambiguous choices', () => {
  const ask = { status: 1, clarify_id: 'canvas-prompt-confirm', questions: [{ question_id: 'confirm_generate', type: 1,
    title: '是否按以上参数生成这段 5 秒首尾帧渐变视频？', question_capability: { allow_text: true },
    options: [{ option_id: 'yes', label: '按要求生成', description: '使用 Seedance 2.0 Fast 生成 5 秒 16:9 首尾帧渐变视频' },
      { option_id: 'no', label: '暂不生成', description: '暂停生成，等待进一步调整' }] }] };
  assert.equal(isEligibleVideoConfirmationAsk(ask), true);
  assert.equal(isEligibleVideoConfirmationAsk(ask, [ask.clarify_id]), false);
  for (const change of [{ title: '是否支付后生成视频？' },
    { options: [{ option_id: 'yes', label: '按要求生成', description: '付费购买' }] },
    { options: [{ option_id: 'yes', label: '按要求生成' }, { option_id: 'also', label: '立即生成' }] }]) {
    assert.equal(isEligibleVideoConfirmationAsk({ ...ask, questions: [{ ...ask.questions[0], ...change }] }), false);
  }
});


test('accepts the observed MCP image-to-video final_generate_confirm without broadening paid or answered asks', () => {
 const ask = { status: 1, clarify_id: 'mcp-image-confirm', questions: [{ question_id: 'final_generate_confirm', type: 1,
  title: '已锁定参数：Seedance 2.0 Fast / 5秒 / 16:9 / 以first_frame原图为首帧。是否按以上参数生成？',
  options: [{label:'按要求生成', option_id:'generate'}, {label:'暂不生成', option_id:'cancel'}] }] };
 assert.equal(isEligibleVideoConfirmationAsk(ask), true);
 assert.equal(isEligibleVideoConfirmationAsk(ask, [ask.clarify_id]), false);
 assert.equal(isEligibleVideoConfirmationAsk({...ask, questions:[{...ask.questions[0],title:'是否支付费用后生成视频？'}]}),false);
});
