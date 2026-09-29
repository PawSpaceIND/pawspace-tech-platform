import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, DAYTIME } from './helpers/voice-harness.mjs';
import { stubFetch, jsonResponse } from './helpers/ai-harness.mjs';
installWorkersHooks('__FAILURE_DB__', '__FAILURE_ENV__');
const gov = await import('../lib/voice-outbound-governance.ts');
const post = await import('../lib/elevenlabs-post-call.ts');
const route = await import('../app/api/webhooks/elevenlabs/post-call/route.ts');
async function world(t, partial = false) {
  const sqlite = freshSqlite(), db = makeD1(sqlite); t.after(() => sqlite.close());
  const env = uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT:'', PAWSPACE_VOICE_RUNTIME:'elevenlabs', ELEVENLABS_API_KEY:'test-key',
    ELEVENLABS_AGENT_ID:'agent-failure', ELEVENLABS_AGENT_PHONE_NUMBER_ID:'phone-test', ELEVENLABS_WEBHOOK_SECRET:'test-signature-key' });
  globalThis.__FAILURE_DB__=db; globalThis.__FAILURE_ENV__=env;
  const { ensureSecurityTables } = await import('../lib/server-auth.ts'); await ensureSecurityTables(db);
  await gov.ensureVoiceCallTables(db); await gov.seedVoiceCallScripts(db); seedRecipient(sqlite);
  await gov.recordVoiceConsent(db,{phone:'9876543210',subjectType:'customer',subjectId:'CON-V1',granted:true,source:'test',actorId:'test'});
  const network=stubFetch(()=>jsonResponse(partial?{success:true,conversation_id:'conv-failure'}:{success:true,callSid:'carrier-failure',conversation_id:'conv-failure'})); t.after(()=>network.restore());
  const call=await gov.requestOutboundVoiceCall(db,env,{idempotencyKey:'local-failure',useCase:'booking_confirmation',phone:'9876543210',
    cityId:'blr',customerId:'CON-V1',leadId:null,bookingId:'BKG-V1',actorId:'test',actorPermissions:['*'],asOf:DAYTIME});
  assert.equal(call.dialled,true);
  const payload={type:'call_initiation_failure',event_timestamp:Math.floor(Date.now()/1000),data:{agent_id:'agent-failure',conversation_id:'conv-failure',failure_reason:'no-answer'}};
  return { sqlite, db, env, call, payload, network };
}
const order=w=>w.sqlite.prepare('SELECT state,connected_at FROM voice_call_orders WHERE id=?').get(w.call.callId);
const marker=w=>w.sqlite.prepare('SELECT status FROM elevenlabs_voice_webhooks').get()?.status;
test('failure without dynamic variables matches exact acceptance and releases only that dial reservation',async t=>{
  const w=await world(t), before=w.sqlite.prepare('SELECT * FROM canonical_customers').all();
  const result=await post.reconcileElevenLabsPostCall(w.db,w.payload);
  assert.equal(result.voiceCallId,w.call.callId); assert.equal(marker(w),'processed');
  assert.equal(order(w).state,'provider_error'); assert.equal(order(w).connected_at,null);
  assert.ok(w.sqlite.prepare('SELECT released_at FROM voice_call_dial_reservations WHERE call_id=?').get(w.call.callId).released_at);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n,1);
  assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_customers').all(),before);
  assert.equal((await post.reconcileElevenLabsPostCall(w.db,w.payload)).duplicatePrevented,true);
  assert.equal(w.network.calls.length,1); assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n,1);
});
const invalid=[
 ['wrong agent',w=>{w.payload.data.agent_id='other-agent';}],
 ['missing agent',w=>{delete w.payload.data.agent_id;}],
 ['wrong conversation',w=>{w.payload.data.conversation_id='other-conversation';}],
 ['claimed different app call',w=>{w.payload.data.conversation_initiation_client_data={dynamic_variables:{pawspace_voice_call_id:'VCALL-WRONG'}};}],
 ['wrong stored carrier',w=>{w.sqlite.prepare('UPDATE voice_call_orders SET provider_call_id=? WHERE id=?').run('carrier-other',w.call.callId);}],
 ['not actually accepted',w=>{w.sqlite.prepare('UPDATE voice_call_orders SET dialed_at=NULL WHERE id=?').run(w.call.callId);}],
 ['legacy missing correlation',w=>{w.sqlite.exec("UPDATE voice_call_state_transitions SET detail_json='{}' WHERE to_state='dialing'");}],
 ['malformed audit JSON',w=>{w.sqlite.exec("UPDATE voice_call_state_transitions SET detail_json='not-json' WHERE to_state='dialing'");}],
];
for(const [name,change] of invalid)test('refuses '+name+' instead of recording processed success',async t=>{
 const w=await world(t);change(w);
 await assert.rejects(()=>post.reconcileElevenLabsPostCall(w.db,w.payload),e=>e instanceof Response&&e.status===409);
 assert.equal(order(w).state,'dialing');assert.equal(marker(w),'processing');assert.equal(w.network.calls.length,1);
});
test('duplicate acceptance correlation is refused rather than picking a latest record',async t=>{
 const w=await world(t);
 const entry=w.sqlite.prepare("SELECT * FROM voice_call_state_transitions WHERE to_state='dialing'").get();
 w.sqlite.prepare('INSERT INTO voice_call_state_transitions (id,call_id,sequence,from_state,to_state,detail_json,actor,created_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('SECOND-ACCEPTANCE',w.call.callId,100,'queued','dialing',entry.detail_json,'test',DAYTIME);
 await assert.rejects(()=>post.reconcileElevenLabsPostCall(w.db,w.payload),e=>e instanceof Response&&e.status===409);
 assert.equal(order(w).state,'dialing');assert.equal(marker(w),'processing');
});
for(const sql of ['UPDATE voice_call_orders SET previous_state','UPDATE voice_call_dial_reservations SET released_at','INSERT OR IGNORE INTO crm_tasks']){
 test('storage failure stays retryable: '+sql,async t=>{
  const w=await world(t);w.db.onSql(sql,()=>{throw Error('injected storage failure');});
  await assert.rejects(()=>post.reconcileElevenLabsPostCall(w.db,w.payload),/injected storage failure/);
  assert.equal(marker(w),'processing');
  const result=await post.reconcileElevenLabsPostCall(w.db,w.payload);
  assert.equal(result.status,'processed');assert.equal(order(w).state,'provider_error');
  assert.ok(w.sqlite.prepare('SELECT released_at FROM voice_call_dial_reservations WHERE call_id=?').get(w.call.callId).released_at);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n,1);
  assert.equal(w.network.calls.length,1);
 });
}
async function signedRequest(payload,secret){
 const raw=JSON.stringify(payload),stamp=String(Math.floor(Date.now()/1000));
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(stamp+'.'+raw))).toString('hex');
 return new Request('https://example.test/api/webhooks/elevenlabs/post-call',{method:'POST',headers:{'ElevenLabs-Signature':`t=${stamp},v0=${sig}`},body:raw});
}
test('real webhook route requires HMAC and never treats a failed storage update as 200',async t=>{
 const w=await world(t);
 const unsigned=await route.POST(new Request('https://example.test/api/webhooks/elevenlabs/post-call',{method:'POST',body:JSON.stringify(w.payload)}));
 assert.equal(unsigned.status,401);assert.equal(order(w).state,'dialing');
 const wrong=await route.POST(await signedRequest(w.payload,'wrong-key'));assert.equal(wrong.status,401);
 w.db.onSql('UPDATE voice_call_dial_reservations SET released_at',()=>{throw Error('test storage failure');});
 const failed=await route.POST(await signedRequest(w.payload,w.env.ELEVENLABS_WEBHOOK_SECRET));
 assert.equal(failed.status,500);assert.equal(marker(w),'processing');
 const retried=await route.POST(await signedRequest(w.payload,w.env.ELEVENLABS_WEBHOOK_SECRET));
 assert.equal(retried.status,200);assert.equal(marker(w),'processed');assert.equal(order(w).state,'provider_error');
 assert.equal(w.network.calls.length,1);
});
test('failure arriving before acceptance persistence can be reconciled on a later delivery',async t=>{
 const w=await world(t);
 const accepted=w.sqlite.prepare("SELECT id,detail_json FROM voice_call_state_transitions WHERE to_state='dialing'").get();
 w.sqlite.prepare('UPDATE voice_call_state_transitions SET detail_json=? WHERE id=?').run('{}',accepted.id);
 await assert.rejects(()=>post.reconcileElevenLabsPostCall(w.db,w.payload),e=>e instanceof Response&&e.status===409);
 assert.equal(marker(w),'processing');
 w.sqlite.prepare('UPDATE voice_call_state_transitions SET detail_json=? WHERE id=?').run(accepted.detail_json,accepted.id);
 assert.equal((await post.reconcileElevenLabsPostCall(w.db,w.payload)).voiceCallId,w.call.callId);
 assert.equal(marker(w),'processed');assert.equal(w.network.calls.length,1);
});
test('matching explicit app identity is checked against acceptance rather than trusted alone',async t=>{
 const w=await world(t);
 w.payload.data.conversation_initiation_client_data={dynamic_variables:{pawspace_voice_call_id:w.call.callId}};
 assert.equal((await post.reconcileElevenLabsPostCall(w.db,w.payload)).voiceCallId,w.call.callId);
 assert.equal(w.network.calls.length,1);
});
test('a processed-marker write failure can retry without another disposition or dial',async t=>{
 const w=await world(t);w.db.onSql("UPDATE elevenlabs_voice_webhooks SET status='processed'",()=>{throw Error('marker write failure');});
 await assert.rejects(()=>post.reconcileElevenLabsPostCall(w.db,w.payload),/marker write failure/);
 assert.equal(marker(w),'processing');assert.equal(order(w).state,'provider_error');
 assert.equal((await post.reconcileElevenLabsPostCall(w.db,w.payload)).status,'processed');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n,1);assert.equal(w.network.calls.length,1);
});

test('partial provider acceptance keeps its reservation, prevents redial and recovers only on an exact signed failure',async t=>{
 const w=await world(t,true),before=w.sqlite.prepare('SELECT * FROM canonical_customers').all();
 const audit=await gov.voiceCallAudit(w.db,w.call.callId);
 assert.equal(audit.providerCorrelation.carrierCallId,null);assert.equal(audit.providerCorrelation.conversationId,'conv-failure');
 assert.ok(audit.transitions.some(x=>String(x.reason).includes('acceptance_incomplete')));
 const slot=()=>w.sqlite.prepare('SELECT released_at FROM voice_call_dial_reservations WHERE call_id=?').get(w.call.callId);
 assert.equal(slot().released_at,null);assert.equal(order(w).state,'dialing');
 const replay=await gov.requestOutboundVoiceCall(w.db,w.env,{idempotencyKey:'local-failure',useCase:'booking_confirmation',phone:'9876543210',
  cityId:'blr',customerId:'CON-V1',bookingId:'BKG-V1',actorId:'test',actorPermissions:['*'],asOf:DAYTIME});
 assert.equal(replay.duplicatePrevented,true);assert.equal(w.network.calls.length,1);
 await assert.rejects(()=>gov.retryVoiceCall(w.db,w.env,{callId:w.call.callId,actorId:'test',actorPermissions:['*'],asOf:DAYTIME}));
 assert.equal(slot().released_at,null);assert.equal(w.network.calls.length,1);
 const result=await route.POST(await signedRequest(w.payload,w.env.ELEVENLABS_WEBHOOK_SECRET));
 assert.equal(result.status,200);assert.equal(order(w).state,'provider_error');assert.ok(slot().released_at);
 const duplicate=await route.POST(await signedRequest(w.payload,w.env.ELEVENLABS_WEBHOOK_SECRET));
 assert.equal(duplicate.status,200);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n,1);
 assert.equal(w.network.calls.length,1);assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_customers').all(),before);
});
test('partial acceptance cannot be released by a signed event naming another agent',async t=>{
 const w=await world(t,true);w.payload.data.agent_id='wrong-agent';
 const result=await route.POST(await signedRequest(w.payload,w.env.ELEVENLABS_WEBHOOK_SECRET));
 assert.equal(result.status,409);assert.equal(order(w).state,'dialing');
 assert.equal(w.sqlite.prepare('SELECT released_at FROM voice_call_dial_reservations WHERE call_id=?').get(w.call.callId).released_at,null);
 assert.equal(w.network.calls.length,1);
});

for(const carrierValue of ['not/an/id',undefined])test('malformed or absent stored carrier field is not a conversation-only receipt: '+String(carrierValue),async t=>{
 const w=await world(t,true);
 const accepted=w.sqlite.prepare("SELECT id,detail_json FROM voice_call_state_transitions WHERE to_state='dialing'").get();
 const detail=JSON.parse(accepted.detail_json);detail.providerCorrelation.carrierCallId=carrierValue;
 w.sqlite.prepare('UPDATE voice_call_state_transitions SET detail_json=? WHERE id=?').run(JSON.stringify(detail),accepted.id);
 const result=await route.POST(await signedRequest(w.payload,w.env.ELEVENLABS_WEBHOOK_SECRET));
 assert.equal(result.status,409);assert.equal(order(w).state,'dialing');
 assert.equal(w.sqlite.prepare('SELECT released_at FROM voice_call_dial_reservations WHERE call_id=?').get(w.call.callId).released_at,null);
});
