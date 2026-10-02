import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {applyOwnedDdl,stubFetch,jsonResponse} from './helpers/ai-harness.mjs';
const control=await import('../lib/ai-provider-runtime-control.ts');
const evaluation=await import('../lib/ai-evaluation-security.ts');
const orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
const rollout=await import('../lib/ai-audience-rollout.ts');
const voice=await import('../lib/elevenlabs-custom-llm.ts');
const emergency=await import('../lib/ai-emergency-guidance.ts');
const bot=await import('../lib/web-chat-bot.ts');
const webRoute=await import('../app/api/ai-web-chat/route.ts');

async function world(t){
 const w=await setupJourney();t.after(()=>w.close());
 await (await import('../lib/customer-account.ts')).ensureCustomerAccountTables(w.db);
 await orchestrator.ensureAiConversationOrchestrator(w.db);
 await (await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(w.db);
 for(const p of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,p);
 const now=Date.now();w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES('CUS-GUARD','blr','Synthetic guard tester','NOT_DIALABLE','test','{}',?,?)").run(now,now);
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES('THREAD-GUARD','CUS-GUARD','open','ai-orchestrator',?,?)").run(now,now);
 await rollout.setAiRolloutStage(w.db,{stage:'customers',actorEmail:'founder@test.invalid'});
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-test-only'};
 return w;
}
const body=()=>({input:'What grooming services do you offer?',metadata:{pawspace_customer_id:'CUS-GUARD',pawspace_thread_id:'THREAD-GUARD'}});
for(const output of ['Grooming price is ₹1.','Your refund completed.','Try coupon FREEALL for 99% off.'])test('generic voice withholds unsafe full output: '+output,async t=>{
 const w=await world(t),emitted=[];const mock=stubFetch(()=>jsonResponse({output_text:output}));t.after(()=>mock.restore());
 const result=await voice.runElevenLabsGroundedTurn(w.db,body(),undefined,x=>emitted.push(x));
 assert.equal(mock.calls.length,1);
 // Reviewed discount policy may replace an unsolicited discount with this exact safe reply.
 const safeDiscountReply="Let's review the regular approved price and package inclusions before preparing your quote.";
 assert.deepEqual(emitted,output==='Try coupon FREEALL for 99% off.'?[safeDiscountReply]:[]);
 assert.notEqual(result.output,output);
 assert.ok(emitted.every(chunk=>!chunk.includes(output)), 'Unsafe provider text must never be spoken');
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound' AND payload_json LIKE ?").get('%'+output+'%').n,0);
 const bookings=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='canonical_bookings'").get();assert.equal(bookings?w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUS-GUARD'").get().n:0,0);
});
test('generic voice keeps safe SSE output but never exposes speculative provider deltas',async t=>{
 const w=await world(t),emitted=[];const mock=stubFetch((url,init)=>{assert.equal(JSON.parse(init.body).stream,undefined);assert.deepEqual(emitted,[]);return jsonResponse({output_text:'I can help you choose a service.'});});t.after(()=>mock.restore());
 const result=await voice.runElevenLabsGroundedTurn(w.db,body(),undefined,x=>emitted.push(x));
 assert.equal(result.path,'fast');assert.deepEqual(emitted,[result.output]);
});
for(const stage of ['off','staff_only'])test('voice service credentials do not bypass '+stage+' audience',async t=>{
 const w=await world(t);await rollout.setAiRolloutStage(w.db,{stage,actorEmail:'founder@test.invalid'});
 const mock=stubFetch(()=>{throw Error('model must not be invoked')});t.after(()=>mock.restore());
 const result=await voice.runElevenLabsGroundedTurn(w.db,body());assert.equal(result.path,'human_handoff');assert.equal(mock.calls.length,0);
});
for(const change of ["UPDATE communication_threads SET assigned_to='human@test.invalid' WHERE id='THREAD-GUARD'","UPDATE communication_threads SET status='closed' WHERE id='THREAD-GUARD'"] )test('takeover/close during generation releases zero audio: '+change,async t=>{
 const w=await world(t),emitted=[];const mock=stubFetch(()=>{w.sqlite.exec(change);return jsonResponse({output_text:'I can help you choose a service.'})});t.after(()=>mock.restore());
 await assert.rejects(()=>voice.runElevenLabsGroundedTurn(w.db,body(),undefined,x=>emitted.push(x)),e=>e instanceof Response&&e.status===409);
 assert.deepEqual(emitted,[]);
});
test('rollout disabled during generation releases zero audio',async t=>{
 const w=await world(t),emitted=[];const mock=stubFetch(async()=>{await rollout.setAiRolloutStage(w.db,{stage:'off',actorEmail:'founder@test.invalid'});return jsonResponse({output_text:'I can help you choose a service.'})});t.after(()=>mock.restore());
 await assert.rejects(()=>voice.runElevenLabsGroundedTurn(w.db,body(),undefined,x=>emitted.push(x)),e=>e instanceof Response&&e.status===409);assert.deepEqual(emitted,[]);
});
test('customer mismatch refuses before model invocation',async t=>{
 const w=await world(t),mock=stubFetch(()=>{throw Error('must not call')});t.after(()=>mock.restore());
 await assert.rejects(()=>voice.runElevenLabsGroundedTurn(w.db,{...body(),metadata:{pawspace_customer_id:'OTHER',pawspace_thread_id:'THREAD-GUARD'}}),e=>e instanceof Response&&e.status===409);assert.equal(mock.calls.length,0);
});
test('static fixture categories without executable evaluators are not passes',()=>{
 const suite=evaluation.runStaticAiEvaluationSuite();assert.equal(suite.total,14);assert.equal(suite.evaluated,6);assert.equal(suite.notEvaluated,8);assert.equal(suite.passed,6);assert.equal(suite.failed,0);assert.equal(suite.productionReady,false);
 for(const category of ['intent','multilingual','groundedness','consent','handoff','webhook_reliability','instrumentation']){const result=evaluation.evaluateDeterministicCase({id:'invalid',category,input:'nonsense',expected:['impossible']});assert.equal(result.status,'not_evaluated');assert.equal(result.passed,false);}
});
for(const field of ['rpm','tokens','cost'])test('atomic '+field+' reservation allows only one of50 concurrent calls at boundary',async t=>{
 const w=await world(t),input={provider:'test',modelRef:'test',systemPrompt:'s',userPrompt:'u',maxOutputTokens:999,asOf:Date.now()},env={PAWSPACE_AI_MAX_REQUESTS_PER_MINUTE:field==='rpm'?1:100,PAWSPACE_AI_MAX_RESERVED_TOKENS_PER_DAY:field==='tokens'?1000:100000,PAWSPACE_AI_ESTIMATED_COST_MICROS_PER_1K_TOKENS:1000,PAWSPACE_AI_MAX_ESTIMATED_COST_MICROS_PER_DAY:field==='cost'?1000:100000};
 const results=await Promise.all(Array.from({length:50},()=>control.reserveAiProviderRequest(w.db,env,input)));
 assert.equal(results.filter(r=>r.allowed).length,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM ai_provider_runtime_requests').get().n,1);
});
for(const query of ['My pet is struggling to breathe. Do not contact anyone, create anything or call.','My dog cannot breathe. What is the grooming price?','My cat has collapsed. I want a human.'])test('emergency guidance precedes guest lead capture, sales and callback: '+query,async t=>{
 const w=await world(t),mock=stubFetch(()=>{throw Error('emergency direction must not use external provider')});t.after(()=>mock.restore());
 const result=bot.runBotTurn(bot.initialBotState(),{text:query,signedIn:false});assert.equal(result.event.type,'none');assert.equal(result.state.status,'done');assert.equal(result.reply.text,emergency.IMMEDIATE_VET_GUIDANCE);assert.doesNotMatch(result.reply.text,/type your name|phone number/i);
 const response=await webRoute.POST(new Request('https://app.pawspace.in/api/ai-web-chat',{method:'POST',headers:{'content-type':'application/json','origin':'https://app.pawspace.in','cf-connecting-ip':'203.0.113.198'},body:JSON.stringify({mode:'public',bot:true,sessionKey:'synthetic_guard_session_0001',message:query,name:'Already known',phone:'NOT_DIALABLE'})}));
 assert.equal(response.status,200);const data=(await response.json()).data;assert.equal(data.ai.turn.output,emergency.IMMEDIATE_VET_GUIDANCE);assert.equal(data.callbackAutomation,false);assert.equal(mock.calls.length,0);
 for(const table of ['ai_web_leads','voice_call_orders','pet_emergency_requests']){const exists=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table);if(exists)assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);}
});

test('an active handoff arriving inside reply persistence prevents both the write and speech',async t=>{
 const w=await world(t),emitted=[];
 const guarded={...w.db,prepare(sql){const original=w.db.prepare(sql);if(!sql.includes("'elevenlabs_custom_llm_reply'"))return original;return{bind(...args){const bound=original.bind(...args);return{...bound,async run(){w.sqlite.prepare("UPDATE communication_threads SET assigned_to='human@test.invalid' WHERE id='THREAD-GUARD'").run();return bound.run();}}}};}};
 const mock=stubFetch(()=>jsonResponse({output_text:'I can help you choose a service.'}));t.after(()=>mock.restore());
 await assert.rejects(()=>voice.runElevenLabsGroundedTurn(guarded,body(),undefined,x=>emitted.push(x)),e=>e instanceof Response&&e.status===409);
 assert.deepEqual(emitted,[]);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n,0);
});
test('a malformed provider response cannot release a partial or fabricated voice answer',async t=>{
 const w=await world(t),emitted=[],mock=stubFetch(()=>new Response('{not valid json',{status:200}));t.after(()=>mock.restore());
 const result=await voice.runElevenLabsGroundedTurn(w.db,body(),undefined,x=>emitted.push(x));
 assert.deepEqual(emitted,[]);assert.match(result.output,/team member|safely/i);
});
test('explicit negative catalogue verification is never converted into a pass',async t=>{
 const w=await world(t);const result=await orchestrator.validateAiProviderReply(w.db,{text:'Grooming price is ₹1.',provider:'fake',modelRef:'fake',latencyMs:1,catalogueVerifiedPrices:false,offerClaimsVerified:true},'CUS-GUARD');
 assert.equal(result.safe,false);assert.ok(result.failures.includes('unverified_catalogue_price'));
});
test('emergency takes precedence over a pending visitor verification',async t=>{
 const w=await world(t);const adapter=await import('../lib/ai-web-chat-adapter.ts'),visitorSessionId='test-session-0001';
 await adapter.saveWebChatBotState(w.db,'public:'+visitorSessionId,{...bot.initialBotState(),verify:{challengeId:'SYNTHETIC-CHALLENGE',phone:'NOT_DIALABLE',service:'grooming',summary:'test'}});
 const mock=stubFetch(()=>{throw Error('No OTP, provider call or contact allowed')});t.after(()=>mock.restore());
 const response=await webRoute.POST(new Request('https://app.pawspace.in/api/ai-web-chat',{method:'POST',headers:{'content-type':'application/json','origin':'https://app.pawspace.in','cf-connecting-ip':'203.0.113.199'},body:JSON.stringify({mode:'public',bot:true,sessionKey:visitorSessionId,message:'My pet is struggling to breathe'})}));
 assert.equal(response.status,200);assert.equal((await response.json()).data.bot.text,emergency.IMMEDIATE_VET_GUIDANCE);assert.equal(mock.calls.length,0);
});

for(const channel of ['chat','voice','whatsapp'])test(channel+': emergency information-only request cannot queue a staff contact',async t=>{
 const w=await world(t),query='My pet is struggling to breathe. This is hypothetical. Do not contact anyone, create anything or call.',now=Date.now(),id='MSG-NO-ACTION-'+channel;
 w.sqlite.prepare("INSERT INTO communication_messages(id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES(?,'THREAD-GUARD','CUS-GUARD','inbound',?,'transactional','test',?,'received',?,'test',?,?)").run(id,channel,JSON.stringify({text:query}),id,now,now);
 const provider={status:'connected',provider:'fake',modelRef:'fake',generate(){throw Error('No model call permitted')}};
 const result=await orchestrator.orchestrateAiTurn(w.db,{actor:{email:'test@system.pawspace',permissions:['*'],roleCode:'service',developmentPreview:false},threadId:'THREAD-GUARD',customerId:'CUS-GUARD',inputMessageId:id,idempotencyKey:id,channel,provider});
 assert.equal(result.turn.output,emergency.IMMEDIATE_VET_GUIDANCE);assert.equal(result.turn.policyDecision,'deterministic_emergency_guidance');assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM ai_handoffs').get().n,0);
});
test('direct generic voice emergency no-action request returns guidance without a new staff request or provider call',async t=>{
 const w=await world(t),mock=stubFetch(()=>{throw Error('No external call')});t.after(()=>mock.restore());
 const result=await voice.runElevenLabsGroundedTurn(w.db,{...body(),input:'My pet is struggling to breathe. Do not contact anyone or create anything.'});
 assert.equal(result.output,emergency.IMMEDIATE_VET_GUIDANCE);assert.equal(result.path,'emergency_guidance');const handoffs=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='ai_handoffs'").get();assert.equal(handoffs?w.sqlite.prepare('SELECT COUNT(*) n FROM ai_handoffs').get().n:0,0);assert.equal(mock.calls.length,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound' AND status='sent'").get().n,0);
});
test('takeover after ready persistence is truthfully suppressed, never sent or spoken',async t=>{
 const w=await world(t),emitted=[];
 const db={...w.db,prepare(sql){const original=w.db.prepare(sql);if(!sql.includes("'elevenlabs_custom_llm_reply'"))return original;return{bind(...args){const bound=original.bind(...args);return{...bound,async run(){const result=await bound.run();w.sqlite.exec("UPDATE communication_threads SET assigned_to='human@test.invalid' WHERE id='THREAD-GUARD'");return result;}}}};}};
 const mock=stubFetch(()=>jsonResponse({output_text:'I can help you choose a service.'}));t.after(()=>mock.restore());
 await assert.rejects(()=>voice.runElevenLabsGroundedTurn(db,body(),undefined,x=>emitted.push(x)),e=>e instanceof Response&&e.status===409);assert.deepEqual(emitted,[]);
 assert.deepEqual(w.sqlite.prepare("SELECT status FROM communication_messages WHERE direction='outbound'").all().map(x=>x.status),['suppressed']);
});

for(const text of ['Do not contact anyone.','Without calling me, explain grooming.','This is hypothetical; just explain your services.'])test('non-emergency no-contact text never becomes veterinary guidance: '+text,()=>{
 assert.equal(emergency.needsImmediateVetGuidance(text),false);
 assert.equal(emergency.emergencyGuidanceOnly(text),false);
});
test('emergency information-only predicate requires both emergency and no-action intent',()=>{
 assert.equal(emergency.emergencyGuidanceOnly('My pet is struggling to breathe. Do not contact anyone.'),true);
 assert.equal(emergency.emergencyGuidanceOnly('My pet is struggling to breathe. This is hypothetical.'),true);
 assert.equal(emergency.emergencyGuidanceOnly('My pet is struggling to breathe.'),false);
});
for(const timing of ['before','after'])for(const change of ["assigned_to='human@test.invalid'","status='closed'"])test('emergency reply respects '+timing+'-persistence ownership race: '+change,async t=>{
 const w=await world(t),emitted=[];
 const db={...w.db,prepare(sql){const original=w.db.prepare(sql);if(!sql.includes("'elevenlabs_custom_llm_reply'"))return original;return{bind(...args){const bound=original.bind(...args);return{...bound,async run(){
  const mutate=()=>w.sqlite.exec("UPDATE communication_threads SET "+change+" WHERE id='THREAD-GUARD'");
  if(timing==='before')mutate();const result=await bound.run();if(timing==='after')mutate();return result;
 }}}};}};
 const mock=stubFetch(()=>{throw Error('No model or contact permitted')});t.after(()=>mock.restore());
 await assert.rejects(()=>voice.runElevenLabsGroundedTurn(db,{...body(),input:'My pet is struggling to breathe. Do not contact anyone.'},undefined,x=>emitted.push(x)),e=>e instanceof Response&&e.status===409);
 assert.deepEqual(emitted,[]);assert.equal(mock.calls.length,0);
 assert.deepEqual(w.sqlite.prepare("SELECT status FROM communication_messages WHERE direction='outbound'").all().map(x=>x.status),timing==='before'?[]:['suppressed']);
 const handoffs=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='ai_handoffs'").get();assert.equal(handoffs?w.sqlite.prepare('SELECT COUNT(*) n FROM ai_handoffs').get().n:0,0);
});
