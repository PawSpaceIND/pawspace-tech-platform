import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshUatAiDb,inboundMessage} from './helpers/ai-harness.mjs';
installAiHooks();
const {pendingLookupAcknowledgment,claimVoiceLookupAcknowledgment,LOOKUP_ACKNOWLEDGMENT}=await import('../lib/voice-lookup-acknowledgment.ts');
const {ensureAiConversationOrchestrator}=await import('../lib/ai-conversation-orchestrator.ts');
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
test('slow pending lookup speaks before it resolves, once; completed fast lookup stays silent',async()=>{
 const events=[],control=new AbortController();let suppressed=0;
 const stop=pendingLookupAcknowledgment({signal:control.signal,delayMs:1,claim:async()=>({suppress:async()=>suppressed++}),emit:phrase=>{events.push(phrase);return true;}});
 await tick();assert.deepEqual(events,[LOOKUP_ACKNOWLEDGMENT]);await tick();assert.equal(events.length,1);stop();assert.equal(suppressed,0);
 const fast=pendingLookupAcknowledgment({signal:control.signal,delayMs:1,claim:async()=>{throw Error('fast lookup must not claim');},emit:()=>{throw Error('must stay silent');}});fast();await tick();
});
test('interruption and stream cancellation suppress stale acknowledgment even while claim is pending',async()=>{
 for(const abort of [true,false]){
  const control=new AbortController();let release,claims=0,suppressed=0,speech=0;
  const stop=pendingLookupAcknowledgment({signal:control.signal,delayMs:1,claim:()=>{claims++;return new Promise(resolve=>{release=resolve;});},emit:()=>{speech++;return true;}});
  await tick();assert.equal(claims,1);if(abort)control.abort();else stop();
  release({suppress:async()=>suppressed++});await tick();assert.equal(speech,0);assert.equal(suppressed,1);
 }
});
test('courtesy phrase failure never changes lookup outcome; failed delivery is suppressed',async()=>{
 let suppressed=0;const stop=pendingLookupAcknowledgment({signal:new AbortController().signal,delayMs:1,claim:async()=>({suppress:async()=>suppressed++}),emit:()=>false});await tick();stop();assert.equal(suppressed,1);
 const failure=pendingLookupAcknowledgment({signal:new AbortController().signal,delayMs:1,claim:async()=>{throw Error('D1 temporarily unavailable');},emit:()=>{throw Error('must not emit');}});await tick();failure();
});
test('durable claim rejects recent filler, newer inbound including tied timestamp, and staff ownership',async t=>{
 const w=freshUatAiDb();t.after(()=>w.sqlite.close());await ensureAiConversationOrchestrator(w.db);
 const identity={threadId:'THREAD-ACK',customerId:'CUS-ACK'};
 let messageId=await inboundMessage(w.sqlite,w.db,{...identity,text:'Check tomorrow',channel:'voice',idempotencyKey:'ACK1'});
 const {assertAiMayReply}=await import('../lib/ai-human-handoff.ts');await assertAiMayReply(w.db,identity.threadId);
 const claim=await claimVoiceLookupAcknowledgment(w.db,{...identity,messageId});assert.ok(claim);
 assert.equal(await claimVoiceLookupAcknowledgment(w.db,{...identity,messageId}),null,'cooldown persisted');await claim.suppress();
 const newer=await inboundMessage(w.sqlite,w.db,{...identity,text:'Wait, next week',channel:'voice',idempotencyKey:'ACK2'});
 w.sqlite.prepare('UPDATE communication_messages SET created_at=1 WHERE direction=\'inbound\'').run();
 assert.equal(await claimVoiceLookupAcknowledgment(w.db,{...identity,messageId}),null,'row order fences equal timestamps');messageId=newer;
 w.sqlite.prepare("UPDATE communication_threads SET assigned_to='staff-queue' WHERE id=?").run(identity.threadId);
 assert.equal(await claimVoiceLookupAcknowledgment(w.db,{...identity,messageId}),null);
 w.sqlite.prepare("UPDATE communication_threads SET assigned_to='ai-orchestrator' WHERE id=?").run(identity.threadId);
 assert.ok(await claimVoiceLookupAcknowledgment(w.db,{...identity,messageId}));
 const row=w.sqlite.prepare("SELECT status,payload_json FROM communication_messages WHERE template_key='voice_lookup_ack' AND status='ready'").get();assert.equal(row.status,'ready');assert.match(row.payload_json,/pending_availability_lookup/);
});
