import test from 'node:test';
import assert from 'node:assert/strict';
import {isSubstantiveVoiceReply} from '../scripts/voice-uat-evidence.mjs';
import {measureVoiceStream} from '../scripts/voice-stream-latency.mjs';

const event = (type, delta) => `data: ${JSON.stringify({type, ...(delta === undefined ? {} : {delta})})}\n\n`;
function stream(chunks) {
 return {ok:true,status:200,body:(async function*(){for(const chunk of chunks)yield new TextEncoder().encode(chunk);})()};
}
test('latency evidence consumes fragmented streaming text exactly once', async()=>{
 const payload=event('response.output_text.delta','Sure, ')+event('response.output_text.delta','I can help. ')+event('response.completed');
 for(const size of [1,7,43,payload.length]){
  const chunks=[];for(let offset=0;offset<payload.length;offset+=size)chunks.push(payload.slice(offset,offset+size));
  let clock=0;const measured=await measureVoiceStream(stream(chunks),0,()=>++clock);
  assert.equal(measured.replyPrefix,'Sure, I can help. ');
  assert.equal(measured.replyChars,'Sure, I can help. '.length);
  assert.ok(measured.firstDeltaMs>0);assert.ok(measured.firstSentenceMs>=measured.firstDeltaMs);
 }
});
test('failed and truncated streams cannot produce premium latency evidence',async()=>{
 for(const payload of [event('response.output_text.delta','Hello.'),event('response.completed'),event('response.failed')]){
  await assert.rejects(measureVoiceStream(stream([payload]),0),/did not complete|stream failed/);
 }
 await assert.rejects(measureVoiceStream({ok:false,status:401},0),/unavailable/);
});
test('an unfinished JSON frame is buffered, while malformed complete frames are refused',async()=>{
 const payload=event('response.output_text.delta','Hello.')+event('response.completed').trimEnd();
 const measured=await measureVoiceStream(stream([payload.slice(0,12),payload.slice(12)]),Date.now());
 assert.equal(measured.replyPrefix,'Hello.');
 await assert.rejects(measureVoiceStream(stream(['data: {broken}\n\n']),0),/Malformed/);
});
test('progress and fallback filler never prove a substantive voice response',()=>{
 for(const text of ['',"I'm checking the details... ","I'm checking the details… ",'One moment while I check that for you.','Sure, give me a second.','Give me a second!','Just a moment.','Please wait.'])assert.equal(isSubstantiveVoiceReply(text),false,text);
});
test('the checked follow-up after progress counts as a real response',()=>{
 assert.equal(isSubstantiveVoiceReply("I'm checking the details... Which grooming package would you like for Bruno?"),true);
 assert.equal(isSubstantiveVoiceReply('What address and pincode should I use?'),true);
 assert.equal(isSubstantiveVoiceReply('One moment while I check that for you. Please share the full service address with the six-digit pincode, and choose Bruno’s package.'),true);
 assert.equal(isSubstantiveVoiceReply('Sure, give me a second. We offer Essential Bath and Complete Makeover for Bruno.'),true);
 assert.equal(isSubstantiveVoiceReply("I'm checking the details... One moment while I check that for you. I'm checking the details..."),false);
});
