import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {applyOwnedDdl} from './helpers/ai-harness.mjs';

async function fixture(t){
 const w=await setupJourney();t.after(()=>w.close());
 const account=await import('../lib/customer-account.ts'),orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
 await(await import('../lib/canonical-booking-read-model.ts')).ensureCanonicalBookingReadModel(w.db);
 await account.ensureCustomerAccountTables(w.db);await orchestrator.ensureAiConversationOrchestrator(w.db);await(await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(w.db);
 for(const owner of ['training-commercial-governance','boarding-governance','sitting-governance','walking-governance','taxi-governance'])applyOwnedDdl(w.sqlite,`lib/${owner}.ts`);
 const now=Date.now(),customerId='CUS-BOOKING-TRUTH',threadId='THREAD-BOOKING-TRUTH';
 w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic tester','9876500092','test','{}',?,?)").run(customerId,now,now);
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 const actor={email:'elevenlabs-voice@system.pawspace',name:'Booking truth test',roleCode:'service_elevenlabs_voice',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:elevenlabs-voice'};
 const insertBooking=(id,status='confirmed',owner=customerId)=>w.sqlite.prepare("INSERT INTO canonical_bookings(id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','fixture-zone','grooming','fixture-package','Fixture Grooming',?,'fixture-provider','2026-10-10T10:00:00+05:30','2026-10-10T11:00:00+05:30',?,1000,'test',?,?)").run(id,id,owner,id,status,now,now);
 const link=id=>w.sqlite.prepare('UPDATE communication_threads SET booking_id=? WHERE id=?').run(id,threadId);
 const reply=text=>({text,provider:'synthetic',modelRef:'mock',latencyMs:0,referencedCustomerIds:[customerId],catalogueVerifiedPrices:true,offerClaimsVerified:true});
 const validate=(result,scope={threadId})=>orchestrator.validateAiProviderReply(w.db,typeof result==='string'?reply(result):result,customerId,scope);
 return {...w,orchestrator,customerId,threadId,actor,insertBooking,link,reply,validate};
}

test('actual provider confirmed-booking claim is rejected with no booking even if draft context claims one',async t=>{
 const w=await fixture(t);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'synthetic-not-real'};
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 globalThis.fetch=async()=>Response.json({status:'completed',output_text:'Your confirmed booking for Maya is ready.',usage:{total_tokens:20}});
 const provider=await(await import('../lib/ai-grounded-runtime-provider.ts')).createGroundedAiRuntimeProvider(w.db,w.actor,'voice',{salesService:'grooming'});
 const generated=await provider.generate({threadId:w.threadId,customerId:w.customerId,channel:'voice',inputText:'Tell me about grooming.',intent:w.orchestrator.classifyAiIntent('Tell me about grooming.'),context:{bookings:[{id:'INVENTED',status:'confirmed'}],thread:{bookingId:'INVENTED'}}});
 assert.match(generated.text,/confirmed booking/);
 assert.equal((await w.validate(generated)).safe,false,'model context and its safety flags cannot attest a booking');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(w.customerId).n,0);
});

test('final booking governance uses fresh canonical state and exact customer/thread scope without CRM writes',async t=>{
 const w=await fixture(t);
 for(const text of ['Your confirmed booking for Maya is ready.','Your booking is confirmed.','We have confirmed your booking.','Booking confirmed.'])assert.equal((await w.validate(text)).safe,false,text);
 for(const text of ['No booking has been confirmed.','Your booking is not confirmed.','I cannot confirm your booking yet.','Your booking will be confirmed after payment.','Once your booking is confirmed, we can help.','Is your booking confirmed?'])assert.equal((await w.validate(text)).safe,true,text);
 w.insertBooking('BK-TRUTH-CURRENT');w.link('BK-TRUTH-CURRENT');
 for(const text of ['Your confirmed booking is ready.','Your booking BK-TRUTH-CURRENT is confirmed.','Booking confirmed.'])assert.equal((await w.validate(text)).safe,true,text);
 assert.equal((await w.validate('Your bookings are confirmed.')).safe,false,'one bound booking cannot attest multiple bookings');
 assert.equal((await w.validate('Your confirmed booking is ready.',{})).safe,false,'no conversation scope must fail closed');
 w.sqlite.prepare("UPDATE canonical_bookings SET status='payment_pending' WHERE id='BK-TRUTH-CURRENT'").run();
 assert.equal((await w.validate('Your confirmed booking is ready.')).safe,false,'stale confirmed context cannot override current payment_pending');
 assert.equal((await w.validate('Your booking was created; payment is pending.')).safe,true);
 for(const status of ['cancelled','draft','expired','completed']){
  w.sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id='BK-TRUTH-CURRENT'").run(status);
  assert.equal((await w.validate('Your confirmed booking is ready.')).safe,false,status);
 }
 w.sqlite.prepare("UPDATE canonical_bookings SET status='confirmed',customer_id='CUS-OTHER' WHERE id='BK-TRUTH-CURRENT'").run();
 assert.equal((await w.validate('Your confirmed booking is ready.')).safe,false,'other customer booking');
 w.sqlite.prepare("UPDATE canonical_bookings SET customer_id=? WHERE id='BK-TRUTH-CURRENT'").run(w.customerId);
 w.sqlite.prepare('UPDATE communication_threads SET customer_id=? WHERE id=?').run('CUS-OTHER',w.threadId);
 assert.equal((await w.validate('Your confirmed booking is ready.')).safe,false,'mismatched thread customer');
 w.sqlite.prepare('UPDATE communication_threads SET customer_id=? WHERE id=?').run(w.customerId,w.threadId);
 assert.equal((await w.validate({...w.reply('Your confirmed booking is ready.'),referencedCustomerIds:['CUS-OTHER']})).safe,false,'provider cross-customer references cannot borrow a verified booking');
 w.insertBooking('BK-TRUTH-OTHER','payment_pending');
 assert.equal((await w.validate('Your booking ID INVENTED is confirmed.')).safe,false,'explicit unknown ID cannot borrow the bound booking');
 assert.equal((await w.validate('Your booking BK-TRUTH-OTHER is confirmed.')).safe,false,'confirmed bound booking cannot authorize a different referenced booking');
 const before={bookings:w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all(),messages:w.sqlite.prepare('SELECT * FROM communication_messages ORDER BY id').all()};
 for(let n=0;n<2;n++)assert.equal((await w.validate('Your confirmed booking is ready.')).safe,true);
 assert.deepEqual({bookings:w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all(),messages:w.sqlite.prepare('SELECT * FROM communication_messages ORDER BY id').all()},before,'validation/replay must not create a CRM booking or confirmation');
 w.link(null);
 assert.equal((await w.validate('Your confirmed booking is ready.')).safe,false,'an unrelated existing confirmed booking is not current-conversation evidence');
 assert.equal((await w.validate('Your booking BK-TRUTH-CURRENT is confirmed.')).safe,true,'an exact named owned booking supports a legitimate status answer');
});

for(const status of [null,'payment_pending','confirmed'])test(`native gateway only emits a confirmed-booking claim for fresh bound confirmed state (${status})`,async t=>{
 const w=await fixture(t);
 if(status){w.insertBooking('BK-GATEWAY-CURRENT',status);w.link('BK-GATEWAY-CURRENT');}
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'synthetic-not-real'};
 globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic booking truth replay',actorEmail:w.actor.email});
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let modelCalls=0;
 globalThis.fetch=async(url)=>{modelCalls++;assert.equal(String(url),'https://api.openai.com/v1/responses');return Response.json({status:'completed',output_text:'Your confirmed booking is ready.',usage:{total_tokens:20}});};
 const before=w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all();
 const gateway=await import('../lib/elevenlabs-custom-llm.ts');
 const replay=await gateway.runElevenLabsGroundedTurn(w.db,{model:'pawspace-generic',input:[{role:'user',content:'Tell me about grooming services.'}],elevenlabs_extra_body:{pawspace_customer_id:w.customerId,pawspace_thread_id:w.threadId}});
 assert.ok(modelCalls>0,'the gateway regression must reach the mocked model');
 if(status==='confirmed')assert.match(replay.output,/confirmed booking/,JSON.stringify({replay,turns:w.sqlite.prepare('SELECT handoff_reason,output_text FROM ai_conversation_turns').all()}));else assert.doesNotMatch(replay.output,/confirmed booking/);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all(),before,'reply cannot create or update canonical booking');
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound' AND channel<>'voice'").get().n,0,'no additional CRM confirmation dispatch');
});

test('booking claim evidence fails closed when its authoritative read is unavailable',async()=>{
 const {verifiedBookingConfirmation}=await import('../lib/ai-booking-claim-truth.ts');
 assert.equal(await verifiedBookingConfirmation({prepare(){throw Error('synthetic unavailable database');}},{reply:'Your booking is confirmed.',customerId:'CUS-TRUTH',threadId:'THREAD-TRUTH'}),false);
});

test('punctuation and an earlier negation cannot hide a later affirmative booking claim',async()=>{
 const {hasBookingConfirmationClaim}=await import('../lib/ai-evaluation-security.ts');
 for(const reply of ['Your booking, BK-TRUTH-CURRENT, is confirmed.','Your booking was not confirmed earlier, but it is confirmed now.','We confirmed the grooming booking.'])assert.equal(hasBookingConfirmationClaim(reply),true,reply);
});


test('punctuated booking references cannot borrow a different confirmed bound booking',async t=>{
 const w=await fixture(t);
 w.insertBooking('BK-CURRENT');w.link('BK-CURRENT');
 const {verifiedBookingConfirmation}=await import('../lib/ai-booking-claim-truth.ts');
 w.insertBooking('BK-OTHER');
 w.insertBooking('BK-PENDING','payment_pending');
 w.insertBooking('BK-FOREIGN','confirmed','CUS-OTHER');
 for(const reference of ['BK-OTHER','BK-MISSING','BK-PENDING','BK-FOREIGN']){
  for(const format of [`Your booking, ${reference}, is confirmed.`,`Your booking (${reference}) is confirmed.`,`Your booking: ${reference} is confirmed.`,`Your booking ID: ${reference} is confirmed.`,`Your booking — ${reference} — is confirmed.`]){
   assert.equal(await verifiedBookingConfirmation(w.db,{reply:format,customerId:w.customerId,threadId:w.threadId}),false,format);
   assert.equal((await w.validate(format)).safe,false,format);
  }
 }
 for(const format of ['Your booking, BK-CURRENT, is confirmed.','Your booking (BK-CURRENT) is confirmed.','Your booking ID: BK-CURRENT is confirmed.'])assert.equal((await w.validate(format)).safe,true,format);
 w.link(null);
 for(const reference of ['BK-MISSING','BK-PENDING','BK-FOREIGN'])assert.equal((await w.validate(`Your booking, ${reference}, is confirmed.`)).safe,false,reference);
 assert.equal((await w.validate('Your booking, BK-CURRENT, is confirmed.')).safe,true,'legitimate exact named owned confirmation needs no unrelated binding');
});


test('all explicit reference forms are resolved or refused before bound booking evidence is used',async t=>{
 const w=await fixture(t),{verifiedBookingConfirmation}=await import('../lib/ai-booking-claim-truth.ts');
 w.insertBooking('BK-CURRENT');w.link('BK-CURRENT');
 w.insertBooking('BK-PENDING','payment_pending');w.insertBooking('BK-FOREIGN','confirmed','CUS-OTHER');
 const variants=id=>[`Your booking reference ${id} is confirmed.`,`Your booking with ID ${id} is confirmed.`,`Your booking referenced as ${id} is confirmed.`,`Your booking under reference number ${id} is confirmed.`,`Your booking (reference: "${id}") is confirmed.`,`Your booking, ref. ${id}, is confirmed.`,`Your booking #${id} is confirmed.`,`Your booking identifier ${id} is confirmed.`,`Your booking associated with ${id} is confirmed.`];
 for(const id of ['BK-MISSING','BK-PENDING','BK-FOREIGN','MISSING'])for(const reply of variants(id)){
  assert.equal(await verifiedBookingConfirmation(w.db,{reply,customerId:w.customerId,threadId:w.threadId}),false,reply);
  assert.equal((await w.validate(reply)).safe,false,reply);
 }
 for(const reply of variants('BK-CURRENT')){
  assert.equal(await verifiedBookingConfirmation(w.db,{reply,customerId:w.customerId,threadId:w.threadId}),true,reply);
  assert.equal((await w.validate(reply)).safe,true,reply);
 }
 for(const reply of ['Your booking reference is confirmed.','Your booking with ID is confirmed.','Your booking linked to MISSING is confirmed.','Your booking reference BK-CURRENT and MISSING is confirmed.']){
  assert.equal(await verifiedBookingConfirmation(w.db,{reply,customerId:w.customerId,threadId:w.threadId}),false,reply);
  assert.equal((await w.validate(reply)).safe,false,reply);
 }
 for(const reply of ['Your booking is confirmed.','Your confirmed booking is ready.','We have confirmed your booking.'])assert.equal((await w.validate(reply)).safe,true,reply);
 w.link(null);
 for(const reply of ['Your booking is confirmed.','Your confirmed booking is ready.'])assert.equal((await w.validate(reply)).safe,false,'generic confirmation needs a canonical binding');
 assert.equal((await w.validate('Your booking reference BK-CURRENT is confirmed.')).safe,true,'an explicit owned canonical reference is independently resolved');
});
