import { publishStayRates } from "./helpers/voice-stay-rate-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
const sales = await import("../lib/voice-sales-specialists.ts");
const orchestrator = await import("../lib/ai-conversation-orchestrator.ts");
const rollout = await import("../lib/ai-audience-rollout.ts");
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const account = await import("../lib/customer-account.ts");
const actor={email:"elevenlabs-voice@system.pawspace",name:"Voice UAT",roleCode:"service_elevenlabs_voice",permissions:["communications.manage","customers.manage","bookings.manage","scheduling.book"],developmentPreview:false,identitySource:"workspace",principalType:"identity_subject",principalKey:"service:elevenlabs-voice"};
const start="2026-10-20T04:30:00.000Z", end="2026-10-20T06:30:00.000Z";
async function world(t,service="grooming"){
 const w=await setupJourney();t.after(()=>w.close());await account.ensureCustomerAccountTables(w.db);await orchestrator.ensureAiConversationOrchestrator(w.db);
 const now=Date.now(),customerId="CUS-SALES",threadId="THREAD-SALES",petId="PET-SALES";
 w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?, 'blr','Synthetic Sales Tester','9876500088','test','{}',?,?)").run(customerId,now,now);
 await seedOwnedPet(w.db,customerId,petId,"Milo");
 w.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 await rollout.setAiRolloutStage(w.db,{stage:"staff_only",reason:"Synthetic sales proof",actorEmail:actor.email});
 const previewReq=()=>new Request("https://internal.pawspace/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"preview",clientRequestId:"INIT-PREVIEW",customerId,petIds:[petId],serviceCode:service,serviceAddress:"12 Test Street",servicePincode:"560038",scheduledStart:start,scheduledEnd:end})});
 await scheduling.executeGovernedSchedulingRequest(previewReq(),actor);
 const profiles=w.sqlite.prepare("SELECT id,city_id,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active'").all();
 for(const p of profiles){
  w.sqlite.prepare("INSERT OR IGNORE INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,?,12.9716,77.5946,0,NULL,'test','test',?)").run(`sales-base-${p.id}`,p.id,"Test base",now);
  for(const zone of JSON.parse(p.zones_json))for(let day=0;day<35;day++){
   const date=new Date(Date.parse(start)+day*86400000).toISOString().slice(0,10);
   w.sqlite.prepare("INSERT OR REPLACE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,'[\"09:00-19:00\"]','roster',?)").run(`${p.id}:${zone}:${date}`,p.id,p.city_id,zone,date,now);
  }
 }
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_sales",RAZORPAY_KEY_SECRET_SANDBOX:"not-real-sales"};
 const calls=[];const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async(url,init)=>{calls.push(String(url));assert.equal(String(url),"https://api.razorpay.com/v1/orders");const body=JSON.parse(init.body);return Response.json({id:`order_sales_${calls.length}`,entity:"order",amount:body.amount,amount_paid:0,amount_due:body.amount,currency:body.currency,receipt:body.receipt,status:"created"});};
 return {...w,customerId,threadId,petId,calls,service};
}
function actions(w,packageCode="dog-basic",paymentMode="prepaid"){return[
 {toolCode:"schedule.reserve",arguments:{serviceCode:w.service,petIds:[w.petId],serviceAddress:"12 Test Street",servicePincode:"560038",scheduledStart:start,scheduledEnd:end,cadenceDays:7}},
 {toolCode:"booking.create",arguments:{petIds:[w.petId],packageCode,paymentMode,...(w.service==="dog_training"?{requirements:["Leash walking", "Basic cues"]}:{})}},
 {toolCode:"checkout.payment_order.create",arguments:{}}
];}
const prepare=(w,turnKey="offer",plan=actions(w))=>sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey,actions:plan});
const confirm=(w,offerId,confirmation="yes")=>sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,offerId,confirmation});
const bookingCount=w=>w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='canonical_bookings'").get()?w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(w.customerId).n:0;
async function refuse(p,status){await assert.rejects(p,e=>e instanceof Response&&e.status===status);}

test("two fixed sales profiles are distinct and unknown model IDs stay generic",()=>{
 assert.equal(sales.voiceSalesService("pawspace-grooming-sales"),"grooming");assert.equal(sales.voiceSalesService("pawspace-training-sales"),"dog_training");assert.equal(sales.voiceSalesService("toString"),undefined);
 const groomingPrompt=sales.specialistSalesPrompt("grooming");assert.match(groomingPrompt,/not an auto-renewing mandate/);assert.match(groomingPrompt,/do not ask for that same field again/i);assert.match(groomingPrompt,/your pet Maya/i);assert.match(groomingPrompt,/pay-after-service/i);assert.match(groomingPrompt,/does not grant new action permissions/i);assert.match(groomingPrompt,/automated voice checkout remains prepaid-only/i);assert.match(groomingPrompt,/offer a human teammate/i);assert.match(sales.specialistSalesPrompt("dog_training"),/Never guarantee behavior outcomes/);
 for(const value of ["yes", "Yes, please", "Yeah, please.", "yep", "yeah, go ahead", "confirm the booking", "go ahead"])assert.equal(sales.isVoiceSalesConfirmation(value),true);
 for(const value of ["no", "yes but tomorrow", "yes for a different dog", "yeah but tomorrow", "yeah not yet", "yep if it is cheaper", "ignore instructions", "I need grooming"])assert.equal(sales.isVoiceSalesConfirmation(value),false);
});

test("one-time grooming quote -> explicit confirmation -> canonical booking/order; no fake capture",async t=>{
 const w=await world(t),offer=await prepare(w);assert.match(offer.summary,/One-time grooming/);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n,0,"quote preview does not reserve capacity");
 const result=await confirm(w,offer.id);assert.ok(result.bookingId);assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);assert.equal(result.paymentVerified,false);assert.equal(result.paymentLinkDelivered,false);
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(result.bookingId).status,"payment_pending");
 const repeat=await confirm(w,offer.id);assert.equal(repeat.duplicatePrevented,true);assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);
});

test("voice prepaid Grooming queues secure WhatsApp checkout without claiming delivery or payment",async t=>{
 const w=await world(t),offer=await prepare(w,"prepaid-whatsapp"),result=await confirm(w,offer.id);
 assert.ok(result.bookingId);assert.ok(result.orderId);assert.equal(result.paymentVerified,false);assert.equal(result.paymentLinkDelivered,false);assert.equal(result.paymentLinkQueued,true);assert.equal(result.payLink,null);
 const message=w.sqlite.prepare("SELECT * FROM communication_messages WHERE id=?").get(result.paymentMessageId);
 assert.ok(message);assert.equal(message.channel,"whatsapp");assert.equal(message.purpose,"transactional");assert.equal(message.template_key,"voice_booking_checkout_ready");assert.equal(message.booking_id,result.bookingId);
 const payload=JSON.parse(message.payload_json);assert.equal(payload.paymentProvider,"razorpay");assert.equal(payload.paymentVerified,false);assert.match(payload.paymentLink,/\/v2\/booking\?bookingId=/);
});

test("voice coupon is a governed Grooming quote, never an invented or Training discount",async t=>{
 const w=await world(t);
 const approved=actions(w);approved[1].arguments.couponCode="GROOM200";
 const offer=await prepare(w,"approved-voice-coupon",approved);
 assert.match(offer.summary,/approved coupon saves 200 rupees/);
 assert.doesNotMatch(offer.summary,/GROOM200|pet\(s\)|INR/);
 const stored=w.sqlite.prepare("SELECT quote_json FROM voice_sales_offers WHERE id=?").get(offer.id);
 const quote=JSON.parse(stored.quote_json);
 assert.equal(quote.coupon.code,"GROOM200");assert.equal(quote.coupon.discount,200);
 assert.equal(bookingCount(w),0,"a quoted coupon cannot book without confirmation");
 const invented=actions(w);invented[1].arguments.couponCode="FAKE999";
 await refuse(prepare(w,"invented-voice-coupon",invented),400);
 const training=await world(t,"dog_training"),trainingActions=actions(training,"trainer-meet-greet");trainingActions[1].arguments.couponCode="GROOM200";
 await refuse(prepare(training,"training-coupon",trainingActions),400);
});

test("prepaid Grooming subscription creates pending entitlement, never multiplied bundle price",async t=>{
 const w=await world(t),offer=await prepare(w,"subscription",actions(w,"sub-3-dog"));assert.match(offer.summary,/Prepaid bundle/);assert.match(offer.summary,/does not enable automatic renewal/);
 const result=await confirm(w,offer.id);const sub=w.sqlite.prepare("SELECT * FROM customer_grooming_subscriptions WHERE source_booking_id=?").get(result.bookingId);
 assert.ok(sub);assert.notEqual(sub.status,"active");assert.equal(sub.sessions_reserved,0);assert.equal(sub.total_sessions,3);assert.equal(result.paymentVerified,false);
});
for(const [packageCode,mode,count]of [["trainer-meet-greet","prepaid",1],["training-2-starter","split",2]])test(`Training ${packageCode} uses owned quote, real sessions and pending payment`,async t=>{
 const w=await world(t,"dog_training"),offer=await prepare(w,"training",actions(w,packageCode,mode)),saved=w.sqlite.prepare("SELECT * FROM voice_sales_offers WHERE id=?").get(offer.id),q=JSON.parse(saved.quote_json);
 assert.equal(q.sessions,count);assert.equal(bookingCount(w),0);
 const result=await confirm(w,offer.id).catch(async e=>{throw new Error(e instanceof Response?await e.text():String(e));});const booking=w.sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(result.bookingId);
 assert.equal(booking.service_code,"dog_training");assert.equal(booking.status,"payment_pending");
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(booking.schedule_group_id).n,count);
 assert.equal(w.sqlite.prepare("SELECT status FROM training_commercial_quotes WHERE id=?").get(q.quoteId).status,"used");
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_quote_payment_attestations").get().n,0);assert.equal(result.paymentVerified,false);
});

test("confirmation rejects negation, changed details, expiry and foreign ownership without mutation",async t=>{
 const w=await world(t),offer=await prepare(w);await refuse(confirm(w,offer.id,"yes but change the day"),400);await refuse(confirm(w,offer.id,"no"),400);
 await refuse(sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:"OTHER",service:w.service,offerId:offer.id,confirmation:"yes"}),403);
 w.sqlite.prepare("UPDATE voice_sales_offers SET expires_at=0 WHERE id=?").run(offer.id);await refuse(confirm(w,offer.id),409);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test("subscription terms changed after read-back force a new quote, not a silent purchase",async t=>{
 const w=await world(t),offer=await prepare(w,"sub-change",actions(w,"sub-3-dog"));w.sqlite.prepare("UPDATE grooming_subscription_plans SET price=price+100,version=version+1 WHERE plan_code='sub-3-dog'").run();
 await refuse(confirm(w,offer.id),409);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test("specialist proposals cannot change service, provider or price",async t=>{
 const w=await world(t);for(const mutate of [a=>a[0].arguments.serviceCode="dog_training",a=>a[0].arguments.providerId="fake",a=>a[1].arguments.totalAmount=1,a=>a[1].arguments.petIds=["foreign-pet"]]){
 const plan=actions(w);mutate(plan);await assert.rejects(prepare(w,crypto.randomUUID(),plan),e=>e instanceof Response&&[400,403].includes(e.status));}
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test("human ownership supersedes even an already presented offer",async t=>{
 const w=await world(t),offer=await prepare(w);w.sqlite.prepare("UPDATE communication_threads SET assigned_to='cx-human' WHERE id=?").run(w.threadId);
 await refuse(confirm(w,offer.id),409);assert.equal(w.calls.length,0);
});

async function turn(w,message,key,provider){const now=Date.now(),messageId=`MSG-${key}`;w.sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'elevenlabs','voice','inbound','lifecycle','voice_sales',?,'received',?,'voice-test',?,?)").run(messageId,w.threadId,w.customerId,JSON.stringify({text:message}),key,now,now);return orchestrator.orchestrateAiTurn(w.db,{actor,threadId:w.threadId,customerId:w.customerId,inputMessageId:messageId,idempotencyKey:key,channel:"voice",provider});}

test("attended-call affirmative confirms the read-back offer without another model plan",async t=>{
 const w=await world(t);let modelCalls=0;const provider={salesService:"grooming",status:"connected",provider:"mock-sales-model",modelRef:"proof",async generate(){modelCalls++;return{text:"I have enough details",provider:"mock-sales-model",modelRef:"proof",latencyMs:1,actionRequests:actions(w)};}};
 const proposed=await turn(w,"I need a grooming booking","proposal",provider);assert.equal(proposed.turn.policyDecision,"customer_confirmation_required");assert.equal(bookingCount(w),0);
 const confirmed=await turn(w,"Yeah, please.","confirmation",provider);assert.equal(confirmed.turn.policyDecision,"customer_confirmed_action_executed");assert.equal(modelCalls,1);assert.equal(bookingCount(w),1);assert.match(confirmed.turn.output,/pending verification/);
});

test("short needs-assessment answers remain a scoped conversation, while human requests still win",async t=>{
 const w=await world(t,"dog_training");let calls=0;const provider={salesService:"dog_training",status:"connected",provider:"mock",modelRef:"proof",async generate(){calls++;return{text:"What would you like to work on with your dog?",provider:"mock",modelRef:"proof",latencyMs:1};}};
 const response=await turn(w,"Milo is two years old","age-answer",provider);assert.equal(calls,1);assert.notEqual(response.turn.outcome,"handoff");
 const human=await turn(w,"Please let me talk to a human","human",provider);assert.equal(calls,1);assert.equal(human.turn.outcome,"handoff");
});

test("simultaneous confirmations claim the offer once and create only one payment order",async t=>{
 const w=await world(t),offer=await prepare(w);let queue=Promise.resolve();const batch=w.db.batch.bind(w.db);
 w.db.batch=items=>{const run=queue.then(()=>batch(items));queue=run.catch(()=>{});return run;};
 const results=await Promise.allSettled([confirm(w,offer.id),confirm(w,offer.id)]);
 assert.ok(results.some(r=>r.status==="fulfilled"));assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);
 for(const r of results)if(r.status==="rejected")assert.ok(r.reason instanceof Response&&r.reason.status===409);
});

test("Training package revision after read-back is refused before reserving or creating a booking",async t=>{
 const w=await world(t,"dog_training"),offer=await prepare(w,"training-revision",actions(w,"training-2-starter","prepaid"));
 w.sqlite.prepare("UPDATE training_commercial_packages SET version=version+1,base_price=base_price+100 WHERE package_code='training-2-starter'").run();
 await refuse(confirm(w,offer.id),409);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n,0);
});

test("payment provider failure after booking is audited and handed off without repeating the sale",async t=>{
 const w=await world(t);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{description:"synthetic provider rejection"}},{status:503});};
 const provider={salesService:"grooming",status:"connected",provider:"mock",modelRef:"proof",async generate(){return{text:"Here is the proposed booking",provider:"mock",modelRef:"proof",latencyMs:1,actionRequests:actions(w)};}};
 await turn(w,"I need a grooming booking","failed-plan",provider);
 const failed=await turn(w,"yes","failed-confirm",provider);assert.equal(failed.turn.outcome,"handoff",JSON.stringify({offer:w.sqlite.prepare("SELECT status,result_json FROM voice_sales_offers").all(),tools:w.sqlite.prepare("SELECT tool_code,status,result_json FROM ai_tool_execution_requests").all()}));assert.equal(bookingCount(w),1);assert.equal(calls,1);
 const offer=w.sqlite.prepare("SELECT status,result_json FROM voice_sales_offers").get();assert.equal(offer.status,"failed");assert.ok(JSON.parse(offer.result_json).bookingId);assert.equal(JSON.parse(offer.result_json).paymentVerified,false);
 await refuse(turn(w,"yes","retry-after-failure",provider),409);assert.equal(bookingCount(w),1);assert.equal(calls,1);
});

test("new details supersede a pending offer and a later yes cannot revive it",async t=>{
 const w=await world(t),offer=await prepare(w);await sales.invalidateVoiceSalesOffers(w.db,w.threadId,w.customerId);
 await refuse(confirm(w,offer.id),409);assert.equal(await sales.pendingVoiceSalesOffer(w.db,w.threadId,w.customerId,w.service),null);assert.equal(bookingCount(w),0);
});

test("only the configured specialist agent IDs are accepted at initialization",async()=>{
 const {configuredElevenLabsAgent}=await import("../lib/elevenlabs-voice-integration.ts");
 const env={ELEVENLABS_AGENT_ID:"generic",ELEVENLABS_GROOMING_AGENT_ID:"grooming",ELEVENLABS_TRAINING_AGENT_ID:"training"};
 for(const id of ["generic","grooming","training"])assert.equal(configuredElevenLabsAgent(env,id),true);
 for(const id of ["","foreign","__proto__"])assert.equal(configuredElevenLabsAgent(env,id),false);
});

test("specialist model receives only same-thread canonical conversation memory",async t=>{
 const w=await world(t,"dog_training");
 const {applyOwnedDdl}=await import("./helpers/ai-harness.mjs");const {ensurePricingControlRuntime}=await import("../lib/pricing-control-runtime.ts");await ensurePricingControlRuntime(w.db);
 for(const owner of ["lib/training-commercial-governance.ts","lib/boarding-governance.ts","lib/sitting-governance.ts","lib/walking-governance.ts","lib/taxi-governance.ts"])applyOwnedDdl(w.sqlite,owner);
 const priorProvider={salesService:"dog_training",status:"connected",provider:"mock",modelRef:"proof",async generate(){return{text:"What training goal matters most?",provider:"mock",modelRef:"proof",latencyMs:1};}};
 await turn(w,"Milo is two years old","history-age",priorProvider);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"fake-key-for-test"};
 let requestBody;globalThis.fetch=async(url,init)=>{assert.equal(String(url),"https://api.openai.com/v1/responses");requestBody=JSON.parse(init.body);return Response.json({status:"completed",output_text:"Has Milo had any previous training?",usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import("../lib/ai-grounded-runtime-provider.ts");const provider=await createGroundedAiRuntimeProvider(w.db,actor,"voice",{salesService:"dog_training"});
 const r=await turn(w,"He pulls on the leash","history-goal",provider);assert.notEqual(r.turn.outcome,"handoff");assert.ok(requestBody);
 const sent=JSON.parse(requestBody.input);assert.equal(sent.canonicalContext.salesService,"dog_training");assert.ok(sent.canonicalContext.conversationHistory.some(x=>x.content==="Milo is two years old"));assert.equal(sent.canonicalContext.catalogueTool,null);assert.match(requestBody.instructions,/Dog Training only/);
});

test("urgent pet symptoms stop sales and advise immediate veterinary care",async t=>{
 const w=await world(t);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"fake-key-for-test"};
 const {createGroundedAiRuntimeProvider}=await import("../lib/ai-grounded-runtime-provider.ts");
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,"voice",{salesService:"grooming"});
 const response=await turn(w,"My dog is having a seizure","urgent-health",provider);
 assert.equal(response.turn.outcome,"handoff");
 assert.match(response.turn.output,/emergency veterinarian immediately/);
 assert.equal(bookingCount(w),0);
});

test("suspected chocolate ingestion stops voice sales and gives emergency vet direction",async t=>{
 const w=await world(t);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"fake-key-for-test"};
 const {createGroundedAiRuntimeProvider}=await import("../lib/ai-grounded-runtime-provider.ts");
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,"voice",{salesService:"grooming"});
 const response=await turn(w,"My puppy ate chocolate","urgent-health",provider);
 assert.equal(response.turn.outcome,"handoff");
 assert.match(response.turn.output,/emergency veterinarian immediately/);
 assert.equal(bookingCount(w),0);
});

test("a request to connect to a vet creates a staff handoff without claiming a connection",async t=>{
 const w=await world(t);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"fake-key-for-test"};
 const {createGroundedAiRuntimeProvider}=await import("../lib/ai-grounded-runtime-provider.ts");
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,"voice",{salesService:"grooming"});
 const response=await turn(w,"Please connect me to a vet","vet-request",provider);
 assert.equal(response.turn.outcome,"handoff");
 assert.match(response.turn.output,/contact a veterinarian for medical advice/);
 assert.match(response.turn.output,/routing this conversation to a PawSpace team member/);
 assert.doesNotMatch(response.turn.output,/you are connected|vet is on the line/i);
 assert.equal(bookingCount(w),0);
});

test("a non-urgent health question cannot turn a model sales proposal into a booking",async t=>{
 const w=await world(t);
 const {applyOwnedDdl}=await import("./helpers/ai-harness.mjs");
 const {ensurePricingControlRuntime}=await import("../lib/pricing-control-runtime.ts");await ensurePricingControlRuntime(w.db);
 for(const owner of ["lib/training-commercial-governance.ts","lib/boarding-governance.ts","lib/sitting-governance.ts","lib/walking-governance.ts","lib/taxi-governance.ts"])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"fake-key-for-test"};
 let requestBody;
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),"https://api.openai.com/v1/responses");requestBody=JSON.parse(init.body);return Response.json({status:"completed",output_text:JSON.stringify({reply:"Buy a grooming package now to fix the rash.",actions:actions(w)}),usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import("../lib/ai-grounded-runtime-provider.ts");
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,"voice",{salesService:"grooming"});
 const response=await turn(w,"My dog has an itchy rash","routine-health",provider);
 assert.ok(requestBody);
 assert.match(requestBody.instructions,/medical-information turn/);
 assert.match(response.turn.output,/contact a veterinarian/);
 assert.doesNotMatch(response.turn.output,/buy|grooming package|rash.*fix/i);
 assert.equal(bookingCount(w),0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_sales_offers").get().n,0);
});


test("Training refuses an invented cadence and a schedule beyond programme validity",async t=>{
 const w=await world(t,"dog_training");const noCadence=actions(w,"training-2-starter");delete noCadence[0].arguments.cadenceDays;
 await refuse(prepare(w,"no-cadence",noCadence),400);assert.equal(bookingCount(w),0);
 const offer=await prepare(w,"chosen-cadence",actions(w,"training-2-starter"));assert.match(offer.summary,/every 7 day/);assert.match(offer.summary,/Last planned session/);
 const quote=JSON.parse(w.sqlite.prepare("SELECT quote_json FROM voice_sales_offers WHERE id=?").get(offer.id).quote_json);assert.equal(quote.occurrences.length,2);
});

test('voice quote repairs an incomplete model checkout proposal before preparing an unconfirmed offer',async t=>{
 const w=await world(t);const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-key-for-test'};
 let requests=0;globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');const body=JSON.parse(init.body);requests++;if(requests===2)assert.match(body.instructions,/previous checkout proposal had an invalid action sequence/);return Response.json({status:'completed',output_text:JSON.stringify({reply:'Here is the proposed quote',actions:requests===1?actions(w).slice(0,1):actions(w)}),usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'grooming'});
 const r=await turn(w,'Please show the grooming quote before booking','repair-proposal',provider);
 assert.equal(requests,2);assert.match(String(r.turn.output||r.turn.text||r.turn.reply||''),/total is .*rupees|reserve/i);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_sales_offers WHERE status='pending'").get().n,1);
 const bookingTable=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='canonical_bookings'").get();
 assert.equal(bookingTable ? w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n : 0,0);
});

// Review closure: read-only enquiries do not destroy the exact quoted offer or authorise changes.
const {isSalesInformationQuestion}=await import('../lib/ai-sales-information.ts');
for(const q of ['What equipment does the groomer bring?','Does this include nail clipping?','How long does grooming take?','What should I prepare?','Can I pay by UPI?','What is the difference between these packages?','Which package should I use for my dog?','Can I use the UPI option?'])test('read-only offer question: '+q,()=>assert.equal(isSalesInformationQuestion(q),true));
for(const q of ['Actually change it to Sunday.','Yes, but use another pet.','Add a second dog.','Can you change the payment mode?','What equipment do you bring? Also change my address.','Is the price correct? Confirm it now.','I want cash after service.','Use a different package.','What about Complete Makeover instead?'])test('changed or mixed terms are not an information exemption: '+q,()=>assert.equal(isSalesInformationQuestion(q),false));
test('information follow-up preserves exact quoted offer; subsequent yes executes once after normal validation',async t=>{
 const w=await world(t),offer=await prepare(w),before=w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id);let modelCalls=0;
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(){modelCalls++;assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(offer.id).status,'pending');return{text:'The groomer brings equipment and products. Please provide suitable space, water and electricity.',provider:'test',modelRef:'test',latencyMs:1,catalogueVerifiedPrices:true,offerClaimsVerified:true};}};
 const answer=await turn(w,'What equipment does the groomer bring?','info-keep',provider);
 assert.notEqual(answer.turn.outcome,'handoff');assert.deepEqual(w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id),before);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 const yes=await turn(w,'yes','info-yes',provider);assert.equal(yes.turn.policyDecision,'customer_confirmed_action_executed');assert.equal(modelCalls,1);assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);
});
test('provider failure on an information follow-up preserves the offer but staff handoff still blocks confirmation',async t=>{
 const w=await world(t),offer=await prepare(w),before=w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id);
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(){throw Error('Simulated upstream failure');}};
 const answer=await turn(w,'How long does grooming take?','info-error',provider);
 assert.equal(answer.turn.handoffReason,'provider_error');assert.deepEqual(w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id),before);
 await refuse(turn(w,'yes','info-after-error',provider),409);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});
test('model-proposed mutation during a harmless question neither replaces nor consumes the pending offer',async t=>{
 const w=await world(t),offer=await prepare(w),before=w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id);
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(){return{text:'Changing your package',provider:'test',modelRef:'test',latencyMs:1,actionRequests:actions(w,'dog-makeover')};}};
 const answer=await turn(w,'Does this include nail clipping?','info-bad-action',provider);
 assert.equal(answer.turn.policyDecision,'information_only_action_rejected');assert.deepEqual(w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id),before);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers').get().n,1);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});
for(const changed of ['Actually move it to Sunday.','Use a different pet.','Change the package to Complete Makeover.','I want to pay after service.'])test('changed terms immediately retire the old offer even when refresh fails: '+changed,async t=>{
 const w=await world(t),offer=await prepare(w);let calls=0;
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(){calls++;assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(offer.id).status,'superseded');return{text:'Please confirm the details for a fresh quote.',provider:'test',modelRef:'test',latencyMs:1,catalogueVerifiedPrices:true};}};
 const answer=await turn(w,changed,'info-change',provider);assert.notEqual(answer.turn.outcome,'handoff');
 const yes=await turn(w,'yes','info-change-yes',provider);assert.equal(yes.turn.policyDecision,'customer_confirmation_required');assert.equal(calls,1);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});
test('preserving an information turn does not renew expiry',async t=>{
 const w=await world(t),offer=await prepare(w);
 w.sqlite.prepare('UPDATE voice_sales_offers SET expires_at=? WHERE id=?').run(Date.now()-1000,offer.id);
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(){return{text:'The groomer brings the equipment.',provider:'test',modelRef:'test',latencyMs:1,catalogueVerifiedPrices:true};}};
 await turn(w,'What equipment do you bring?','info-expired',provider);
 const yes=await turn(w,'yes','info-expired-yes',provider);assert.equal(yes.turn.policyDecision,'customer_confirmation_required');assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('original payment demo disclaimers remain read-only while suggestion-style changes do not',()=>{
 assert.equal(isSalesInformationQuestion('I am not confirming a service. Explain online payment and paying after grooming. Do not create a payment link.'),true);
 assert.equal(isSalesInformationQuestion('What about the Complete Makeover package tomorrow?'),false);
 assert.equal(isSalesInformationQuestion('How about the larger package?'),false);
});


test("explicit preparation request creates only a pending quote; yeah confirms its stored terms", async t => {
 const w=await world(t);let calls=0;
 const provider={salesService:"grooming",status:"connected",provider:"mock-sales-model",modelRef:"proof",async generate(input){calls++;assert.equal(input.intent.intent,"booking_create");return{text:"Here is your proposed appointment",provider:"mock-sales-model",modelRef:"proof",latencyMs:1,actionRequests:actions(w)};}};
 const offered=await turn(w,"Please prepare a quote for the one-time Bath & Basic for Milo, prepaid, October 20 2026 at 10 AM India time, at 12 Test Street, Bengaluru, PIN 560038.","explicit-quote",provider);
 assert.equal(offered.turn.policyDecision,"customer_confirmation_required");assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_sales_offers WHERE status='pending'").get().n,1);
 const confirmed=await turn(w,"Yeah, please.","explicit-quote-confirm",provider);
 assert.equal(confirmed.turn.policyDecision,"customer_confirmed_action_executed");assert.equal(calls,1);assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE customer_id=?").get(w.customerId).status,"payment_pending");
});

test('explicit quote repairs a model reply that mistakes proposal names for immediate execution',async t=>{
 const w=await world(t);const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-key-for-test'};
 let requests=0;globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');const body=JSON.parse(init.body);requests++;assert.match(body.instructions,/UNEXECUTED PROPOSAL/);if(requests===2)assert.match(body.instructions,/previous reply did not prepare/);return Response.json({status:'completed',output_text:requests===1?'I can prepare the quote, but the checkout tools sound like changes. Would you like a teammate to provide it?':JSON.stringify({reply:'Here is the proposed quote',actions:actions(w)}),usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'grooming'});
 const r=await turn(w,'Please prepare an unconfirmed quote for Complete Makeover for my saved dog, prepaid, at my saved address on a future date. Do not reserve or create a booking or payment order.','repair-no-actions',provider);
 assert.equal(requests,2);assert.equal(r.turn.policyDecision,'customer_confirmation_required');assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_sales_offers WHERE status='pending'").get().n,1);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('quote proposal retry is bounded and preserves genuine missing-field clarification',async t=>{
 const w=await world(t);const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-key-for-test'};
 let requests=0;globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');const body=JSON.parse(init.body);requests++;assert.match(body.instructions,/UNEXECUTED PROPOSAL/);if(requests===2)assert.match(body.instructions,/previous reply did not prepare/);return Response.json({status:'completed',output_text:'Which saved pet should I prepare the quote for?',usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'grooming'});
 const r=await turn(w,'Please prepare an unconfirmed quote for Complete Makeover for my saved dog, prepaid, at my saved address on a future date. Do not reserve or create a booking or payment order.','repair-missing-pet',provider);
 assert.equal(requests,2);assert.match(r.turn.output,/Which saved pet/);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_sales_offers WHERE status='pending'").get().n,0);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('no eligible named-package offer is answered without a model or staff handoff',async t=>{
 const w=await world(t);const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-key-for-test'};
 const {approvedSalesOffers}=await import('../lib/ai-sales-offers.ts');await approvedSalesOffers(w.db,{customerId:w.customerId,channel:'whatsapp'});w.sqlite.prepare("UPDATE coupon_campaigns SET status='paused'").run();
 globalThis.fetch=async()=>{assert.fail('No-offer facts do not require a model');};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'grooming'});
 let generated=null;const generate=provider.generate;provider.generate=async input=>{generated=await generate(input);return generated;};
 const r=await turn(w,'The Complete Makeover price feels high. Is there an approved offer for that package?','no-offer-facts',provider);
 assert.ok(generated,'Offer enquiry reaches the grounded provider');assert.match(generated.text,/don’t have an eligible approved offer/);const check=await orchestrator.validateAiProviderReply(w.db,generated,w.customerId);assert.deepEqual(check.failures,[]);
 assert.match(r.turn.output,/don’t have an eligible approved offer/);assert.notEqual(r.turn.outcome,'handoff');assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('eligible named-package offer passes final governance without a model or staff handoff',async t=>{
 const w=await world(t);const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);w.sqlite.prepare("UPDATE service_packages SET active=1 WHERE service_code='grooming' AND package_code='dog-makeover'").run();
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-key-for-test'};
 const {approvedSalesOffers}=await import('../lib/ai-sales-offers.ts');await approvedSalesOffers(w.db,{customerId:w.customerId,channel:'whatsapp'});
 globalThis.fetch=async()=>{assert.fail('No-offer facts do not require a model');};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'grooming'});
 let generated=null;const generate=provider.generate;provider.generate=async input=>{generated=await generate(input);return generated;};
 const r=await turn(w,'The Complete Makeover price feels high. Is there an approved offer for that package?','eligible-offer-facts',provider);
 assert.ok(generated,'Offer enquiry reaches the grounded provider');assert.match(generated.text,/200 rupees off/);const check=await orchestrator.validateAiProviderReply(w.db,generated,w.customerId);assert.deepEqual(check.failures,[]);
 assert.match(r.turn.output,/200 rupees off/);assert.notEqual(r.turn.outcome,'handoff');assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});


for (const [service, packageCode, hours] of [['boarding', 'boarding-4h', 4], ['pet_sitting', 'sitting-visit-60', 1]]) {
 test(`voice ${service} reads a verified caregiver quote and requires customer app checkout`, async t => {
  const w = await world(t, service); await publishStayRates(w,service,packageCode);
  const plan = actions(w, packageCode); delete plan[0].arguments.cadenceDays;
  plan[0].arguments.scheduledEnd = new Date(Date.parse(start) + hours * 3600000).toISOString();
  // An earlier executable offer cannot survive a service switch to a stay.
  await sales.ensureVoiceSalesOffers(w.db);
  w.sqlite.prepare("INSERT INTO voice_sales_offers(id,turn_key,thread_id,customer_id,service_code,status,quote_json,actions_json,summary,expires_at,created_at) VALUES ('OLD','old',?,?,'grooming','pending','{}','[]','old',?,1)").run(w.threadId,w.customerId,Date.now()+60000);
  const offer = await prepare(w, `stay-${service}`, plan);
  assert.match(offer.summary,/7,999 rupees/); assert.match(offer.summary,/Complete the booking in the PawSpace app/);
  assert.doesNotMatch(offer.summary,/Shall I reserve|Shall I.*book/);
  assert.equal(offer.bookingPath,service==='boarding'?'/v2/boarding':'/v2/sitting');
  const stored=w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id);
  assert.equal(stored.status,'app_only'); assert.deepEqual(JSON.parse(stored.actions_json),[]);
  assert.equal(JSON.parse(stored.quote_json).priceSource,'provider_rate');
  assert.equal(w.sqlite.prepare("SELECT status FROM voice_sales_offers WHERE id='OLD'").get().status,'superseded');
  assert.equal(await sales.pendingVoiceSalesOffer(w.db,w.threadId,w.customerId,'all_services'),null);
  assert.deepEqual(await prepare(w, `stay-${service}`, plan),offer);
  await refuse(confirm(w,offer.id),409);
  const provider={salesService:'all_services',status:'connected',provider:'test',modelRef:'test',async generate(){throw Error('Stay yes must not invoke the model');}};
  const yes=await turn(w,'Yes, please.','stay-app-yes-'+service,provider);
  assert.equal(yes.turn.policyDecision,'provider_priced_app_booking_required');
  assert.match(yes.turn.output,/complete this caregiver booking in the PawSpace app/);
  // A legacy pending offer is blocked too, even if it retains an executable action chain.
  w.sqlite.prepare("UPDATE voice_sales_offers SET status='pending',actions_json=? WHERE id=?").run(JSON.stringify(plan),offer.id);
  await refuse(confirm(w,offer.id),409);
  await refuse(sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:'all_services',offerId:offer.id,confirmation:'yes'}),409);
  const legacyYes=await turn(w,'Yes, please.','stay-legacy-yes-'+service,provider);
  assert.equal(legacyYes.turn.policyDecision,'provider_priced_app_booking_required');
  assert.match(legacyYes.turn.output,/available caregiver's price/);
  assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(offer.id).status,'superseded');
  assert.equal(bookingCount(w),0); assert.equal(w.calls.length,0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE customer_id=? AND status!='cancelled'").get(w.customerId).n,0);
 });
 test(`voice ${service} refuses catalogue fallback pricing without a published caregiver rate`,async t=>{
  const w=await world(t,service),plan=actions(w,packageCode);delete plan[0].arguments.cadenceDays;
  plan[0].arguments.scheduledEnd=new Date(Date.parse(start)+hours*3600000).toISOString();
  await assert.rejects(prepare(w,'no-rate-'+service,plan),e=>e instanceof Response && e.status===409); // no customer quote or action
  assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers').get().n,0);
 });
}

test('all-service Maya cannot activate the superseded Walking pay-after-service UAT flow',async t=>{
 const w=await world(t);const plan=actions(w,'walking-30','pay_after_service');plan[0].arguments.serviceCode='dog_walking';
 await refuse(sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:'all_services',turnKey:'walking-policy-conflict',actions:plan}),409);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('all-service Maya refuses an unsupported service before making reservations or payment orders',async t=>{
 const w=await world(t);
 const plan=actions(w);plan[0].arguments.serviceCode='fresh_food';
 await refuse(sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:'all_services',turnKey:'unsupported',actions:plan}),409);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE customer_id=? AND status!='cancelled'").get(w.customerId).n,0);
});

test('Boarding cannot quote a pet whose vaccination has not been verified',async t=>{
 const w=await world(t,'boarding');
 w.sqlite.prepare("UPDATE canonical_pets SET vaccination_status='not_provided' WHERE id=?").run(w.petId);
 const plan=actions(w,'boarding-4h');delete plan[0].arguments.cadenceDays;
 plan[0].arguments.scheduledEnd=new Date(Date.parse(start)+4*3600000).toISOString();
 await refuse(prepare(w,'unverified-stay',plan),409);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('stay information cannot be confirmed by another conversation',async t=>{
 const w=await world(t,'pet_sitting');await publishStayRates(w,'pet_sitting','sitting-visit-60');
 const plan=actions(w,'sitting-visit-60');delete plan[0].arguments.cadenceDays;plan[0].arguments.scheduledEnd=new Date(Date.parse(start)+3600000).toISOString();
 const offer=await prepare(w,'stay-owner',plan);
 await refuse(sales.confirmVoiceSalesOffer(w.db,{actor,threadId:'ANOTHER-THREAD',customerId:w.customerId,service:'pet_sitting',offerId:offer.id,confirmation:'yes'}),403);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

for(const redundantPin of [false,true])test('Taxi voice checkout uses routed fare and fleet booking after separate confirmation; duplicate PIN='+redundantPin,async t=>{
 const w=await world(t,'pet_taxi');
 await (await import('../lib/taxi-fleet-governance.ts')).ensureTaxiFleetTables(w.db);
 for(const provider of w.sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE services_json LIKE '%pet_taxi%'").all())
  for(const car of w.sqlite.prepare('SELECT id FROM taxi_fleet_vehicles WHERE active=1').all())
   w.sqlite.prepare("INSERT OR IGNORE INTO taxi_driver_vehicle_eligibility(provider_id,vehicle_id,status,created_at) VALUES (?,?,'active',1)").run(provider.id,car.id);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,GOOGLE_MAPS_SERVER_API_KEY_UAT:'synthetic-test-key',GOOGLE_ROUTES_SERVER_API_KEY_UAT:'synthetic-test-key',PAWSPACE_MAPS_ENV:'sandbox'};
 const paymentFetch=globalThis.fetch;let mapRequests=0;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(String(url));
  if(u.hostname==='maps.googleapis.com'){
   mapRequests++;const pickup=u.searchParams.get('address').startsWith('12');
   return Response.json({status:'OK',results:[{formatted_address:u.searchParams.get('address'),geometry:{location:{lat:pickup?12.9784:12.9352,lng:pickup?77.6408:77.6245}}}]});
  }
  if(u.hostname==='routes.googleapis.com'){mapRequests++;return Response.json({routes:[{distanceMeters:8000,duration:'1200s'}]});}
  return paymentFetch(url,init);
 };
 const plan=actions(w,'citroen_ec3','split_50_50');delete plan[0].arguments.cadenceDays;
 if(redundantPin)plan[0].arguments.serviceAddress+=', PIN '+plan[0].arguments.servicePincode;
 plan[0].arguments.scheduledStart='2026-10-20T10:00:00+05:30'; // Model output uses the caller's India offset.
 plan[1].arguments.taxi={originLabel:'12 Test Street',destinationLabel:'24 Test Street, Koramangala, Bengaluru',passengerCount:1,luggageCount:0,tripType:'one_way',ridePurpose:'regular',waitingMinutes:0,hyperactivePet:false};
 const offer=await sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:'all_services',turnKey:'taxi-voice',actions:plan}).catch(async e=>{throw Error(e instanceof Response?await e.text():String(e));});
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);assert.equal(mapRequests,3);
 assert.equal(w.sqlite.prepare('SELECT scheduled_start FROM taxi_ride_quotes').get().scheduled_start,start);
 assert.match(offer.summary,/Vehicle: Citroen eC3/);assert.match(offer.summary,/12 Test Street/);
 const result=await sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:'all_services',offerId:offer.id,confirmation:'yes'}).catch(async e=>{throw Error(e instanceof Response?await e.text():String(e));});
 assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);assert.equal(result.paymentVerified,false);
 assert.equal(w.sqlite.prepare('SELECT service_code FROM canonical_bookings WHERE id=?').get(result.bookingId).service_code,'pet_taxi');
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_fleet_reservations WHERE status='confirmed'").get().n,1);
 assert.equal((await sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:'all_services',offerId:offer.id,confirmation:'yes'})).duplicatePrevented,true);
 assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);
});

test('Taxi pickup equivalence never ignores a different street or PIN',async()=>{
 const {canonicalTaxiPickup}=await import('../lib/voice-taxi-sales.ts');
 assert.equal(canonicalTaxiPickup('12 Test Street','12 Test Street, PIN 560038','560038'),'12 Test Street, PIN 560038');
 for(const origin of ['13 Test Street','12 Test Street, PIN 560039','12 Test Street, PIN 560038, another address','560038'])assert.throws(()=>canonicalTaxiPickup(origin,'12 Test Street, PIN 560038','560038'));
});

for(const toolCode of ['schedule.reserve','provider.assignment.execute_policy'])test(`AI stay ${toolCode} cannot bypass customer app checkout`,async t=>{
 const w=await world(t,'boarding');
 const {executeGovernedConversationTool}=await import('../lib/ai-first-control-plane.ts');
 const result=await executeGovernedConversationTool(w.db,{actor,toolCode,threadId:w.threadId,customerId:w.customerId,intent:'booking_create',channel:'voice',arguments:actions(w,'boarding-4h')[0].arguments,idempotencyKey:'stay-direct-'+toolCode,customerConfirmed:true}).catch(e=>e);
 assert.ok(result instanceof Response && result.status===409,'direct tool must refuse stay capacity mutation');
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE customer_id=? AND status!='cancelled'").get(w.customerId).n,0);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

for(const serviceCode of [undefined,'grooming'])test(`nested stay reservation cannot hide behind outer service ${serviceCode}`,async t=>{
 const w=await world(t,'boarding');
 const {executeGovernedConversationTool}=await import('../lib/ai-first-control-plane.ts');
 const result=await executeGovernedConversationTool(w.db,{actor,toolCode:'schedule.reserve',threadId:w.threadId,customerId:w.customerId,intent:'booking_create',channel:'voice',arguments:{serviceCode,schedule:actions(w,'boarding-4h')[0].arguments},idempotencyKey:'nested-stay-'+String(serviceCode),customerConfirmed:true}).catch(e=>e);
 assert.ok(result instanceof Response&&result.status===409);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE customer_id=? AND status!='cancelled'").get(w.customerId).n,0);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

// The attended demo asked this exact plural question after choosing Bruno.
test('plural package enquiry preserves a pending quote and reaches the read-only provider',async t=>{
 const w=await world(t),offer=await prepare(w),before=w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id);let modelCalls=0;
 assert.equal(isSalesInformationQuestion('What are the packages available?'),true);
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(input){
  modelCalls++;assert.equal(input.intent.intent,'service_info');
  assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(offer.id).status,'pending');
  return{text:'Essential Bath and Complete Makeover are the grooming packages.',provider:'test',modelRef:'test',latencyMs:1,catalogueVerifiedPrices:true,offerClaimsVerified:true};
 }};
 const result=await turn(w,'What are the packages available?','attended-packages',provider);
 assert.equal(modelCalls,1);assert.notEqual(result.turn.outcome,'handoff');
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM voice_sales_offers WHERE id=?').get(offer.id),before);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 for(const question of ['What are the prices?','Which packages are available?','What do the packs cost?'])assert.equal(isSalesInformationQuestion(question),true);
 for(const question of ['What are the packages? Book one now.','Which packages should I use instead?','What are the prices? Confirm the booking.'])assert.equal(isSalesInformationQuestion(question),false);
});

test('attended package question uses catalogue context and the read-only package prompt',async t=>{
 const w=await world(t);const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 // Convert only this synthetic legacy fixture to the current date-only catalogue contract.
 w.sqlite.prepare("UPDATE service_packages SET active=1,effective_from='2026-01-01',effective_to=NULL WHERE service_code='grooming' AND package_code IN ('dog-bath','dog-makeover')").run();
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'offline-test-only'};
 let requests=0;
 globalThis.fetch=async(url,init)=>{
  assert.equal(String(url),'https://api.openai.com/v1/responses');requests++;
  const body=JSON.parse(init.body);const context=JSON.parse(body.input).canonicalContext;
  assert.match(body.instructions,/explicitly asks which packages are available/);
  assert.match(body.instructions,/first understand why the customer wants the service and the desired outcome/);
  assert.match(body.instructions,/ask one relevant question at a time/);
  assert.match(body.instructions,/Do not start an ordinary intake with a package or price menu/);
  assert.match(body.instructions,/read-only sales information question/);
  assert.match(body.instructions,/separate explicit confirmation of a valid current server quote/);
  assert.equal(context.informationOnly,true);assert.deepEqual(context.availableActionTools,[]);
  const rows=context.catalogue.grooming.filter(row=>String(row.package_code).startsWith('dog-'));
  assert.ok(rows.length>=2);assert.ok(rows.every(row=>row.name&&Number.isFinite(Number(row.base_price))));
  return Response.json({status:'completed',output_text:rows.map(row=>`${row.name} costs ${row.base_price} rupees`).join('. ')+'. Which package would you prefer?',usage:{total_tokens:20}});
 };
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'grooming'});
 const result=await turn(w,'What are the packages available?','attended-package-prompt',provider);
 assert.equal(requests,1);assert.notEqual(result.turn.outcome,'handoff');assert.equal(result.turn.handoffReason,null);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 const offerTable=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='voice_sales_offers'").get();
 assert.equal(offerTable?w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers').get().n:0,0);
});

test('reported attended book-grooming phrase reaches intake without premature handoff or booking',async t=>{
 const w=await world(t);let calls=0;
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(input){
  calls++;assert.equal(input.intent.intent,'booking_create');
  return{text:'What would you like the grooming to help with for your pet today?',provider:'test',modelRef:'test',latencyMs:1,catalogueVerifiedPrices:true,offerClaimsVerified:true};
 }};
 for(const [index,phrase] of ['I want to book grooming session today, for today.','I want to book grooming today.'].entries()){
  const result=await turn(w,phrase,'attended-book-grooming-'+index,provider);
  assert.equal(result.turn.intent.intent,'booking_create');assert.notEqual(result.turn.outcome,'handoff');
 }
 assert.equal(calls,2);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 for(const phrase of ['I want a human to book grooming','Refund me and book grooming','My dog is struggling to breathe; book grooming'])assert.notEqual(orchestrator.classifyAiIntent(phrase).intent,'booking_create');
});

test('owned repeat-call ASR reference to the AI agent does not request a human',async t=>{
 const input="Booking provider ownership and acceptance password. Yeah, uh, do I have a-- I want to book a, a grooming session today, for today.Maya, be on mute. I'm talking to, uh, I'm talking, uh, to the AI agent.";
 assert.equal(orchestrator.classifyAiIntent(input).intent,'booking_create');
 for(const phrase of ['I am talking to the AI agent','I am speaking with an automated agent','I want to book grooming with the virtual agent'])assert.notEqual(orchestrator.classifyAiIntent(phrase).intent,'human_handoff');
 for(const phrase of ['I want an agent','Please connect me to a human agent','A real agent please, not the AI agent','I am speaking to the AI agent but want a person'])assert.equal(orchestrator.classifyAiIntent(phrase).intent,'human_handoff');
 const w=await world(t);let calls=0;
 const provider={salesService:'grooming',status:'connected',provider:'test',modelRef:'test',async generate(){calls++;return{text:'What would you like the grooming to help with for your pet today?',provider:'test',modelRef:'test',latencyMs:1,catalogueVerifiedPrices:true,offerClaimsVerified:true};}};
 const first=await turn(w,input,'owned-repeat-ai-agent',provider);
 assert.notEqual(first.turn.outcome,'handoff');
 const {assertAiMayReply}=await import('../lib/ai-human-handoff.ts');await assertAiMayReply(w.db,w.threadId);
 const second=await turn(w,'Staying out and observing for later.','owned-repeat-followup',provider);
 assert.notEqual(second.turn.outcome,'handoff');assert.equal(calls,2);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs WHERE thread_id=? AND status IN ('queued','staff_active')").get(w.threadId).n,0);
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('availability acknowledgment hook wraps the real preview and stops before final quote',async t=>{
 const w=await world(t);const events=[];
 const offer=await sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'lookup-hook',actions:actions(w),onLookupPending:()=>{events.push('pending');return()=>events.push('finished');}});
 assert.deepEqual(events,['pending','finished']);assert.match(offer.summary,/One-time grooming/);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 const invalid=actions(w);invalid[0].arguments.servicePincode='invalid';events.length=0;
 await refuse(sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'lookup-invalid',actions:invalid,onLookupPending:()=>{events.push('pending');return()=>events.push('finished');}}),400);
 assert.deepEqual(events,[],'no filler when facts fail before availability lookup');
});

test('slow real scheduling preview emits acknowledgment while blocked, then preserves canonical final quote',async t=>{
 const w=await world(t),{runWithWorkersDb}=await import('./helpers/module-hooks.mjs');
 const {pendingLookupAcknowledgment,LOOKUP_ACKNOWLEDGMENT}=await import('../lib/voice-lookup-acknowledgment.ts');
 let lookupPending=false,release,blocked;const waiting=new Promise(resolve=>{blocked=resolve;});const hold=new Promise(resolve=>{release=resolve;});
 const delayedDb={...w.db,prepare(sql){
  const wrap=statement=>new Proxy(statement,{get(target,key){
   if(key==='bind')return(...args)=>wrap(target.bind(...args));
   if(['first','all','run'].includes(key))return async(...args)=>{if(lookupPending){lookupPending=false;blocked();await hold;}return target[key](...args);};
   const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});return wrap(w.db.prepare(sql));
 }};
 const spoken=[];let finalReady=false;
 const offerPromise=runWithWorkersDb(delayedDb,()=>sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'held-lookup',actions:actions(w),onLookupPending:()=>{lookupPending=true;return pendingLookupAcknowledgment({signal:new AbortController().signal,delayMs:1,claim:async()=>({suppress:async()=>{}}),emit:text=>{spoken.push(text);return true;}});}})).then(result=>{finalReady=true;return result;});
 await waiting;await new Promise(resolve=>setTimeout(resolve,15));
 assert.deepEqual(spoken,[LOOKUP_ACKNOWLEDGMENT]);assert.equal(finalReady,false,'lookup and final quote are still unresolved when speech is emitted');assert.equal(bookingCount(w),0);
 release();const offer=await offerPromise;assert.match(offer.summary,/One-time grooming/);assert.equal(spoken.length,1);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('recorded Maya correction reaches actual grounded model context through cross-service comparison',async t=>{
 const w=await world(t),{readFile}=await import('node:fs/promises');
 const recorded=JSON.parse(await readFile(new URL('./fixtures/maya-service-language-memory.json',import.meta.url),'utf8'));
 const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 if(!w.sqlite.prepare('PRAGMA table_info(canonical_pets)').all().some(column=>column.name==='breed'))w.sqlite.exec('ALTER TABLE canonical_pets ADD COLUMN breed TEXT');
 w.sqlite.prepare("UPDATE canonical_pets SET name='Bruno' WHERE id=?").run(w.petId);await seedOwnedPet(w.db,w.customerId,'PET-MAYA-1','Maya');await seedOwnedPet(w.db,w.customerId,'PET-MAYA-2','Maya');
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'offline-test-only'};
 const requests=[];globalThis.fetch=async(url,init)=>{requests.push({url:String(url),body:JSON.parse(init.body)});
  return Response.json({status:'completed',output_text:'I remember your correction to Maya. Which of the two saved Maya profiles do you mean?',usage:{total_tokens:20}});
 };
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'});
 const history=recorded.turns.slice(0,4).flatMap(t=>[{role:'user',content:t.transcript},{role:'assistant',content:t.reply}]);
 const wrapped={...provider,generate:input=>provider.generate({...input,context:{...input.context,conversationHistory:history}})};
 const result=await turn(w,recorded.turns[4].transcript,'recorded-maya-comparison',wrapped);
 assert.ok(requests.length>=1&&requests.length<=2);
 for(const {url,body} of requests){assert.equal(url,'https://api.openai.com/v1/responses');const context=JSON.parse(body.input).canonicalContext;
  assert.equal(context.petPreference?.petName,'[REDACTED]','existing pet-name privacy redaction remains intact');assert.equal(context.conversationHistory[context.petPreference.preferenceHistoryIndex].content,recorded.turns[2].transcript);assert.deepEqual(context.petPreference.matchingSavedPetIds.sort(),['PET-MAYA-1','PET-MAYA-2']);assert.equal(context.petPreference.requiresProfileClarification,true);assert.equal(context.petPreference.mutationAuthority,false);assert.match(body.instructions,/latest customer pet correction replaces the earlier pet/);
  assert.ok(context.conversationHistory.some(row=>row.content===recorded.turns[2].transcript));
 }
 assert.notEqual(result.turn.outcome,'handoff',JSON.stringify(result));assert.match(result.turn.output,/Maya/);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

for(const [label,utterance,clarification] of [
 ['new puppy','I have a new puppy, not Bruno. I want gentle grooming.','For your new puppy, what is her age and vaccination status?'],
 ['boarding','I need pet boarding for Bruno for three nights.','For Bruno’s boarding, what check-in and check-out dates do you need?'],
])test(`recorded ${label} first turn reaches grounded intake instead of unknown-intent handoff`,async t=>{
 const w=await world(t);let calls=0;
 assert.equal(orchestrator.classifyAiIntent(utterance).intent,'service_info');
 const provider={salesService:'all_services',status:'connected',provider:'offline',modelRef:'fixture',async generate(input){calls++;assert.equal(input.inputText,utterance);return{text:clarification,provider:'offline',modelRef:'fixture',latencyMs:0,catalogueVerifiedPrices:true,offerClaimsVerified:true,highImpactAction:false,actionRequests:[]};}};
 const result=await turn(w,utterance,'batch-first-'+label,provider);assert.equal(calls,1);assert.notEqual(result.turn.outcome,'handoff');assert.equal(result.turn.output,clarification);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs WHERE thread_id=? AND status='queued'").get(w.threadId).n,0);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('recorded Training price plus recommendation is read-only and preserves pending offer',async t=>{
 const w=await world(t,'dog_training'),offer=await prepare(w,'training-before-price',actions(w,'trainer-meet-greet'));
 const utterance='What approved training options and prices are available? Recommend the best fit.';
 assert.equal(isSalesInformationQuestion(utterance),true);
 for(const mixed of [utterance+' Book it now.','What training prices are available? Recommend the best fit and reserve tomorrow.','What training prices are available? Change the booking.'])assert.equal(isSalesInformationQuestion(mixed),false);
 const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'offline-test-only'};
 const requests=[];globalThis.fetch=async(url,init)=>{requests.push({url:String(url),body:JSON.parse(init.body)});return Response.json({status:'completed',output_text:'The approved training options are in the current catalogue. Which training outcome matters most to you?',usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'dog_training'});
 const result=await turn(w,utterance,'batch-training-readonly',provider);assert.equal(requests.length,1);const body=requests[0].body,context=JSON.parse(body.input).canonicalContext;
 assert.equal(context.informationOnly,true);assert.deepEqual(context.availableActionTools,[]);assert.match(body.instructions,/read-only sales information question/);assert.notEqual(result.turn.outcome,'handoff');assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(offer.id).status,'pending');assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('recorded Taxi vet destination is transport intake, while symptom-bearing taxi remains medical',async t=>{
 const {isPetMedicalQuestion,ensureVeterinaryReferral}=await import('../lib/ai-grounded-runtime-provider.ts');
 const utterance='I want a pet taxi for Bruno from Indiranagar to a vet clinic in Whitefield.';
 assert.equal(isPetMedicalQuestion(utterance),false);assert.equal(ensureVeterinaryReferral('What date and time do you need?',isPetMedicalQuestion(utterance)),'What date and time do you need?');
 for(const clinical of ['My dog is bleeding. I need a pet taxi to a vet clinic.','My dog cannot breathe; get a taxi to the vet.','My dog is vomiting; I need a taxi to a vet.','Should I give medication before taking a pet taxi to the vet?'])assert.equal(isPetMedicalQuestion(clinical),true,clinical);
 const w=await world(t);const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'offline-test-only'};
 const requests=[];globalThis.fetch=async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json({status:'completed',output_text:'For the taxi, what date and time do you need, and is it one-way or return?',usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'});
 const result=await turn(w,utterance,'batch-taxi-destination',provider);assert.notEqual(result.turn.outcome,'handoff');assert.doesNotMatch(result.turn.output,/medical concern|contact a veterinarian/);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 for(const body of requests)assert.doesNotMatch(body.instructions,/This is a medical-information turn/);
});
