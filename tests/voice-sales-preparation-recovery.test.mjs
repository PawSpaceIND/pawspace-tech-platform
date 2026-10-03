import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceSalesPreparationFailureReply} from '../lib/voice-sales-preparation-recovery.ts';
import {VOICE_CONSULTATIVE_SALES} from '../lib/voice-conversation-style.mjs';
for(const detail of ['Address identity conflict; select your saved address','Address geocode identity conflict; select your saved address'])test(`recorded saved-address conflict remains verification required: ${detail}`,()=>{
 const reply=voiceSalesPreparationFailureReply(409,detail);
 assert.match(reply,/verify the matching saved address/);
 assert.match(reply,/PawSpace app/);
 assert.match(reply,/No booking has been created/);
 assert.doesNotMatch(reply,/geocode|identity conflict|confirmed booking/i);
});
test('unrelated validation failures retain existing behavior',()=>{
 assert.equal(voiceSalesPreparationFailureReply(400,'Select a pet'),"I couldn't prepare that booking yet: Select a pet. Could you check this and tell me again?");
});
test('consultative prompt carries the recorded cancellation and care continuity requirements',()=>{
 assert.match(VOICE_CONSULTATIVE_SALES,/answer that plan's verified cancellation terms/);
 assert.match(VOICE_CONSULTATIVE_SALES,/do not replace it with Meet and Greet/);
 assert.match(VOICE_CONSULTATIVE_SALES,/change of pet within the same service retains the caller's stated care request/);
 assert.match(VOICE_CONSULTATIVE_SALES,/without promising a refund or upgrade/);
});
