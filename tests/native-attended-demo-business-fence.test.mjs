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


async function turn(w,message,key,provider){const now=Date.now(),messageId=`MSG-${key}`;w.sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'elevenlabs','voice','inbound','lifecycle','voice_sales',?,'received',?,'voice-test',?,?)").run(messageId,w.threadId,w.customerId,JSON.stringify({text:message}),key,now,now);return orchestrator.orchestrateAiTurn(w.db,{actor,threadId:w.threadId,customerId:w.customerId,inputMessageId:messageId,idempotencyKey:key,channel:"voice",provider});}

async function demoWorld(t){const w=await world(t);const threadId='THREAD-VOICE-NDEMO-SYNTHETIC';w.sqlite.prepare('UPDATE communication_threads SET id=? WHERE id=?').run(threadId,w.threadId);return{...w,threadId};}
test('delivered demo quote followed by explicit Yes creates no booking/payment and speaks refusal',async t=>{const w=await demoWorld(t);const offered=await prepare(w,'demo-offer');const provider={salesService:'grooming',status:'connected',provider:'mock',modelRef:'mock',async generate(){throw new Error('Yes must not generate a new proposal');}};const r=await turn(w,'Yes, please.','demo-yes',provider);assert.equal(r.turn.policyDecision,'native_demo_action_refused');assert.match(r.turn.output||r.turn.output_text,/cannot create a booking/);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(offered.id).status,'pending');});
test('direct demo confirmation is refused before offer claim or business writes',async t=>{const w=await demoWorld(t);const offered=await prepare(w,'direct-demo-offer');await refuse(confirm(w,offered.id),403);assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(offered.id).status,'pending');});
test('non-specialist model action plan cannot reserve or book on a durable demo thread',async t=>{const w=await demoWorld(t);await rollout.setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic generic demo action proof',actorEmail:actor.email});let generated=0;const provider={status:'connected',provider:'mock',modelRef:'mock',async generate(){generated++;return{text:'I will reserve it.',confidence:1,provider:'mock',modelRef:'mock',latencyMs:1,actionRequests:actions(w)};}};const result=await turn(w,'Yes, book a grooming slot for Milo.','general-demo-action',provider).catch(()=>null);assert.equal(generated,1,'The real model-action execution path must be reached');assert.equal(bookingCount(w),0,JSON.stringify(result));assert.equal(w.calls.length,0);});
