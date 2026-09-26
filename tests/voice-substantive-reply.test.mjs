import test from 'node:test';
import assert from 'node:assert/strict';
import {isSubstantiveVoiceReply} from '../scripts/voice-uat-evidence.mjs';
test('progress and fallback filler never prove a substantive voice response',()=>{
 for(const text of ['',"I'm checking the details... ","I'm checking the details… ",'One moment while I check that for you.','Just a moment.','Please wait.'])assert.equal(isSubstantiveVoiceReply(text),false,text);
});
test('the checked follow-up after progress counts as a real response',()=>{
 assert.equal(isSubstantiveVoiceReply("I'm checking the details... Which grooming package would you like for Bruno?"),true);
 assert.equal(isSubstantiveVoiceReply('What address and pincode should I use?'),true);
});
