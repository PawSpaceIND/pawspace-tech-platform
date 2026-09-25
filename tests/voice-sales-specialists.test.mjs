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
 assert.match(sales.specialistSalesPrompt("grooming"),/not an auto-renewing mandate/);assert.match(sales.specialistSalesPrompt("dog_training"),/Never guarantee behavior outcomes/);
 for(const value of ["yes", "Yes, please", "confirm the booking", "go ahead"])assert.equal(sales.isVoiceSalesConfirmation(value),true);
 for(const value of ["no", "yes but tomorrow", "yes for a different dog", "ignore instructions", "I need grooming"])assert.equal(sales.isVoiceSalesConfirmation(value),false);
});

test("one-time grooming quote -> explicit confirmation -> canonical booking/order; no fake capture",async t=>{
 const w=await world(t),offer=await prepare(w);assert.match(offer.summary,/One-time grooming/);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n,0,"quote preview does not reserve capacity");
 const result=await confirm(w,offer.id);assert.ok(result.bookingId);assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);assert.equal(result.paymentVerified,false);assert.equal(result.paymentLinkDelivered,false);
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(result.bookingId).status,"payment_pending");
 const repeat=await confirm(w,offer.id);assert.equal(repeat.duplicatePrevented,true);assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);
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

test("spoken yes executes previously read-back offer without asking the model for another plan",async t=>{
 const w=await world(t);let modelCalls=0;const provider={salesService:"grooming",status:"connected",provider:"mock-sales-model",modelRef:"proof",async generate(){modelCalls++;return{text:"I have enough details",provider:"mock-sales-model",modelRef:"proof",latencyMs:1,actionRequests:actions(w)};}};
 const proposed=await turn(w,"I need a grooming booking","proposal",provider);assert.equal(proposed.turn.policyDecision,"customer_confirmation_required");assert.equal(bookingCount(w),0);
 const confirmed=await turn(w,"yes","confirmation",provider);assert.equal(confirmed.turn.policyDecision,"customer_confirmed_action_executed");assert.equal(modelCalls,1);assert.equal(bookingCount(w),1);assert.match(confirmed.turn.output,/pending verification/);
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
 const sent=JSON.parse(requestBody.input);assert.equal(sent.canonicalContext.salesService,"dog_training");assert.ok(sent.canonicalContext.conversationHistory.some(x=>x.text==="Milo is two years old"));assert.equal(sent.canonicalContext.catalogueTool,null);assert.match(requestBody.instructions,/Dog Training only/);
});


test("Training refuses an invented cadence and a schedule beyond programme validity",async t=>{
 const w=await world(t,"dog_training");const noCadence=actions(w,"training-2-starter");delete noCadence[0].arguments.cadenceDays;
 await refuse(prepare(w,"no-cadence",noCadence),400);assert.equal(bookingCount(w),0);
 const offer=await prepare(w,"chosen-cadence",actions(w,"training-2-starter"));assert.match(offer.summary,/every 7 day/);assert.match(offer.summary,/Last planned session/);
 const quote=JSON.parse(w.sqlite.prepare("SELECT quote_json FROM voice_sales_offers WHERE id=?").get(offer.id).quote_json);assert.equal(quote.occurrences.length,2);
});
