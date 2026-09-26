import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationEvidence} from '../scripts/voice-uat-evidence.mjs';
const greeting = {role:'agent',message:'Hello'};
const user = {role:'user',message:'Tell me about grooming'};
const reply = {role:'agent',message:'Which service do you need?'};
const done = {agent_id:'agent-test',status:'done',has_user_audio:true,has_response_audio:true};
const evaluate = (detail,carrier) => conversationEvidence(detail,carrier,'agent-test');
test('accepted but unanswered call fails immediately',()=>{
  const result=evaluate({...done,status:'initiated',transcript:[]},{status:'no-answer'});
  assert.equal(result.passed,false); assert.equal(result.terminal,true);
});
test('greeting and a user turn do not prove an agent reply',()=>{
  for(const transcript of [[greeting],[greeting,user],[greeting,{...user,message:' '},reply]]) {
    assert.equal(evaluate({...done,transcript}).passed,false);
  }
});
test('complete spoken exchange passes only for the correct agent and audio',()=>{
  const detail={...done,transcript:[greeting,user,reply]};
  assert.equal(evaluate(detail).passed,true);
  for(const override of [{agent_id:'wrong'},{has_user_audio:false},{has_response_audio:false},{status:'failed'},{status:'in-progress'}]) {
    assert.equal(evaluate({...detail,...override}).passed,false);
  }
});
test('greeting audio does not terminate polling',()=>{
  assert.equal(evaluate({...done,status:'in-progress',transcript:[greeting]}).terminal,false);
});
