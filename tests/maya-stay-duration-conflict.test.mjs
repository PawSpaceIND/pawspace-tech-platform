import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {applyOwnedDdl} from './helpers/ai-harness.mjs';

test('managed sales provider rejects a seven-day proposal that conflicts with the caller’s 24-hour stay',async t=>{
 const w=await setupJourney();t.after(()=>w.close());
 const account=await import('../lib/customer-account.ts'),orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
 await account.ensureCustomerAccountTables(w.db);await orchestrator.ensureAiConversationOrchestrator(w.db);
 await(await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(w.db);
 for(const owner of ['training-commercial-governance','boarding-governance','sitting-governance','walking-governance','taxi-governance'])applyOwnedDdl(w.sqlite,`lib/${owner}.ts`);
 const now=Date.now(),customerId='CUS-DURATION',threadId='THREAD-DURATION';
 w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic tester','9876500089','test','{}',?,?)").run(customerId,now,now);
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 const actor={email:'elevenlabs-voice@system.pawspace',name:'Duration test',roleCode:'service_elevenlabs_voice',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:elevenlabs-voice'};
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'synthetic-not-real'};
 const previousFetch=globalThis.fetch;t.after(()=>globalThis.fetch=previousFetch);let calls=0;
 const start=new Date(now+86400000).toISOString();
 const actions=[{toolCode:'schedule.reserve',arguments:{serviceCode:'boarding',scheduledStart:start,scheduledEnd:new Date(Date.parse(start)+7*86400000).toISOString()}},{toolCode:'booking.create',arguments:{serviceCode:'boarding',paymentMode:'prepaid'}},{toolCode:'checkout.payment_order.create',arguments:{}}];
 globalThis.fetch=async url=>{assert.equal(String(url),'https://api.openai.com/v1/responses');calls++;return Response.json({status:'completed',output_text:JSON.stringify({reply:'Your stay quote is ready.',actions}),usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'});
 const result=await provider.generate({threadId,customerId,channel:'voice',inputText:'Prepare a quote for boarding.',intent:orchestrator.classifyAiIntent('Prepare a quote for boarding.'),context:{conversationHistory:[{role:'user',content:'I need boarding on October 3 for a 24-hour stay.'},{role:'assistant',content:'When should care end?'},{role:'user',content:'October 10 at noon.'}]}});
 assert.equal(calls,1);assert.equal(result.actionRequests?.length??0,0,'conflicting dates cannot reach quote preparation');
 assert.match(result.text,/24.hour stay/);assert.match(result.text,/168 hours/);assert.match(result.text,/keep.*24.hour.*new dates/i);
 globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic duration replay',actorEmail:actor.email});
 const {runElevenLabsGroundedTurn}=await import('../lib/elevenlabs-custom-llm.ts');
 const replay=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[{role:'user',content:'I need boarding on October 3 for a 24-hour stay.'},{role:'assistant',content:'When should care end?'},{role:'user',content:'October 10 at noon.'},{role:'user',content:'Prepare a quote for boarding.'}],elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}});
 assert.match(replay.output,/keep.*24.hour.*new dates/i,JSON.stringify({calls,turns:w.sqlite.prepare('SELECT handoff_reason,output_text FROM ai_conversation_turns').all(),thread:w.sqlite.prepare('SELECT assigned_to FROM communication_threads WHERE id=?').get(threadId)}));assert.equal(calls,2);
 for(const correction of ['Not a 48-hour stay.','I do not want a 24-hour stay.','Not a 24-hour stay.']){
  const before=calls;
  const revised=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[{role:'user',content:'I need a 24-hour stay.'},{role:'assistant',content:'When should care end?'},{role:'user',content:correction},{role:'user',content:'Prepare a quote for boarding.'}],elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}});
  assert.equal(calls,before+1);assert.match(revised.output,correction.includes('48')?/keep.*24.hour.*new dates/i:/duration is unclear.*How many hours/i,correction);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers WHERE customer_id=?').get(customerId).n,0,correction);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0,correction);
 }
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers WHERE customer_id=?').get(customerId).n,0,'gateway must ask for clarification before storing an offer');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0);
});

test('duration consistency preserves explicit revisions and leaves unrelated fields to existing authority',async()=>{
 const {stayDurationClarification}=await import('../lib/voice-stay-duration-consistency.ts');
 const prior=[{role:'user',content:'I need a 24-hour stay.'}];
 const proposal=(hours,serviceCode='boarding')=>[{toolCode:'schedule.reserve',arguments:{serviceCode,scheduledStart:'2026-10-03T06:30:00Z',scheduledEnd:new Date(Date.parse('2026-10-03T06:30:00Z')+hours*3600000).toISOString()}}];
 assert.equal(stayDurationClarification(prior,'Prepare a quote for boarding.',proposal(24)),null);
 assert.equal(stayDurationClarification(prior,'Actually I need a 48-hour stay.',proposal(48)),null);
 assert.equal(stayDurationClarification(prior,'Use the new dates.',proposal(168)),null);
 assert.match(stayDurationClarification(prior,'Not a 48-hour stay.',proposal(168)),/24.hour stay.*168 hours/);
 assert.match(stayDurationClarification(prior,'Not a 24-hour stay.',proposal(168)),/duration is unclear/);
 assert.match(stayDurationClarification(prior,'I do not want a 24-hour stay.',proposal(24)),/duration is unclear/);
 assert.equal(stayDurationClarification(prior,'About a 24-hour stay.',proposal(26)),null);
 assert.equal(stayDurationClarification([{role:'assistant',content:'Choose a 24-hour stay.'}],'Quote please.',proposal(168)),null);
 assert.equal(stayDurationClarification([{role:'user',content:'The puppy is 24 hours old.'}],'Quote please.',proposal(168)),null);
 assert.equal(stayDurationClarification(prior,'Quote please.',proposal(168,'grooming')),null);
 assert.match(stayDurationClarification(prior,'Quote please.',proposal(48,'pet_sitting')),/24.hour stay.*48 hours/);
 assert.equal(stayDurationClarification(prior,'Quote please.',[{toolCode:'schedule.reserve',arguments:{serviceCode:'boarding',scheduledStart:'2026-10-03',scheduledEnd:'2026-10-10'}}]),null);
});
