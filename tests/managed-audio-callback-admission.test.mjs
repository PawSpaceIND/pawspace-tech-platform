import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
const control=await import('../lib/managed-audio-test-control.ts');
const gateway=await import('../lib/elevenlabs-custom-llm.ts');
const isolation=await import('../lib/managed-audio-isolation.ts');
const env={PAWSPACE_MANAGED_AUDIO_ISOLATION:'no-send-v1',PAWSPACE_DEPLOYMENT_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',PAWSPACE_VOICE_UAT_ALLOWLIST:'9999999999'};
const body=(hints)=>({input:'Hypothetical information only: my pet has a seizure. Do not contact anyone.',elevenlabs_extra_body:hints});
test('actual callback rejects ordinary-session override, cross-customer and stale reservation replay before writes',async()=>{
 const w=await setupJourney(),oldFetch=globalThis.fetch;let fetches=0;
 globalThis.fetch=()=>{fetches++;throw Error('External network forbidden');};
 try{
  await(await import('../lib/customer-account.ts')).ensureCustomerAccountTables(w.db);
  await(await import('../lib/inbound-ai-telephony.ts')).ensureInboundAiTelephonyTables(w.db);
  await(await import('../lib/ai-voice-uat.ts')).ensureAiVoiceUatTables(w.db);
  await control.ensureManagedAudioControl(w.db);
  globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,...env};globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
  const now=Date.now(),customerId='SYNTHETIC-OWNED',ordinaryCustomer='SYNTHETIC-ORDINARY',threadId='THREAD-MANAGED-AUDIO-ADMITTED',callId='AIVCALL-MANAGED-AUDIO-ADMITTED',ordinaryThread='THREAD-ORDINARY',sessionId='INVOICE-ORDINARY';
  for(const id of [customerId,ordinaryCustomer])w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Offline synthetic test','9999999999','test','{}',?,?)").run(id,now,now);
  for(const [tid,cid] of [[threadId,customerId],[ordinaryThread,ordinaryCustomer]])w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(tid,cid,now,now);
  w.sqlite.prepare("INSERT INTO inbound_ai_voice_sessions(id,provider_call_id,customer_id,thread_id,caller_key,status,started_at,updated_at) VALUES (?,'OFFLINE-PROVIDER',?,?,'NOT_DIALABLE','active',?,?)").run(sessionId,ordinaryCustomer,ordinaryThread,now,now);
  await control.reserveManagedAudioConversation(w.db,{threadId,callId,customerId,bound:control.managedAudioCostBound(600,0,now),expiresAt:now+600000,now});
  w.sqlite.prepare("INSERT INTO ai_voice_calls(id,thread_id,customer_id,transport_provider,direction,status,consent_status,started_at,created_by) VALUES (?,?,?,'sandbox_simulator','inbound','active','verified',?,'founder@pawspace.in')").run(callId,threadId,customerId,now);
  await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',actorEmail:'offline@example.invalid'});
  const valid={pawspace_thread_id:threadId,pawspace_customer_id:customerId};
  const messageCount=()=>w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages').get().n;
  const initial=messageCount();
  for(const hints of [ {...valid,pawspace_voice_session_id:sessionId}, {...valid,pawspace_voice_call_id:'ORDINARY-CALL'}, {...valid,pawspace_customer_id:ordinaryCustomer}, {...valid,pawspace_thread_id:'THREAD-MANAGED-AUDIO-UNADMITTED'}, {pawspace_voice_session_id:sessionId} ]){
   await assert.rejects(()=>gateway.runElevenLabsGroundedTurn(w.db,body(hints)),e=>e instanceof Response&&e.status===403);
   assert.equal(messageCount(),initial);
  }
  const mixed=body({...valid,pawspace_voice_session_id:sessionId});
  assert.ok(await isolation.managedAudioRequestBlock(new Request('https://offline.invalid/api/elevenlabs/v1/responses',{method:'POST',body:JSON.stringify(mixed)}),env));
  // Deterministic reply demonstrates admission without buying a model generation.
  const result=await gateway.runElevenLabsGroundedTurn(w.db,body(valid));
  assert.equal(result.threadId,threadId);assert.equal(result.customerId,customerId);assert.equal(result.path,'emergency_guidance');
  assert.equal(messageCount(),initial+2);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages WHERE thread_id=?').get(ordinaryThread).n,0);
  assert.equal(w.sqlite.prepare('SELECT attempts_used FROM managed_audio_test_conversations WHERE thread_id=?').get(threadId).attempts_used,0);
  for(const mutation of ["UPDATE ai_voice_calls SET status='completed'", "UPDATE ai_voice_calls SET status='active'; UPDATE managed_audio_test_conversations SET expires_at=0", "DELETE FROM managed_audio_test_conversations"]){
   w.sqlite.exec(mutation);
   await assert.rejects(()=>gateway.runElevenLabsGroundedTurn(w.db,body(valid)),e=>e instanceof Response&&e.status===403);
   assert.equal(messageCount(),initial+2);
  }
  assert.equal(fetches,0);
 }finally{globalThis.fetch=oldFetch;w.close();delete globalThis.__PAWSPACE_TEST_ENV__;}
});
