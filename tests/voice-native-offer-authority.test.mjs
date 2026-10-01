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
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('cancelled quote A cannot replace spoken newer quote B before Yes',async t=>{
 const w=await world(t),entered=deferred(),release=deferred();let current=true;
 const old={salesService:'grooming',status:'connected',provider:'mock',modelRef:'mock',async generate(){entered.resolve();await release.promise;return{text:'Quote A',provider:'mock',modelRef:'mock',latencyMs:1,actionRequests:actions(w,'dog-makeover')};}};
 const fresh={salesService:'grooming',status:'connected',provider:'mock',modelRef:'mock',async generate(){return{text:'Quote B',provider:'mock',modelRef:'mock',latencyMs:1,actionRequests:actions(w,'dog-basic')};}};
 const now=Date.now(),text='Prepare an unconfirmed quote for Complete Makeover for Milo.';
 w.sqlite.prepare("INSERT INTO communication_messages(id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'elevenlabs','voice','inbound','lifecycle','voice_sales',?,'received',?,'voice-test',?,?)").run('MSG-race-A',w.threadId,w.customerId,JSON.stringify({text}),'race-A',now,now);
 const pending=orchestrator.orchestrateAiTurn(w.db,{actor,threadId:w.threadId,customerId:w.customerId,inputMessageId:'MSG-race-A',idempotencyKey:'race-A',channel:'voice',provider:old,assertCurrent(){if(!current)throw new Error('Cancelled native generation');}});
 await entered.promise;current=false;
 const b=await turn(w,'Prepare an unconfirmed quote for Bath Basic for Milo.','race-B',fresh);assert.equal(b.turn.policyDecision,'customer_confirmation_required');
 release.resolve();const stale=await Promise.allSettled([pending]);
 const confirmed=await turn(w,'Yes, please.','race-confirm',fresh);
 const booking=w.sqlite.prepare('SELECT package_code FROM canonical_bookings WHERE customer_id=?').get(w.customerId);
 assert.equal(booking.package_code,'dog-basic',JSON.stringify({stale:stale.map(r=>({status:r.status})),selected:booking.package_code,spokenQuote:'dog-basic',calls:w.calls.length}));
 assert.equal(confirmed.turn.policyDecision,'customer_confirmed_action_executed');assert.equal(w.calls.length,1);
});

test('cancelled native commit cannot supersede the current delivered offer', async t => {
 const w=await world(t);
 await sales.beginNativeVoiceOfferTurn(w.db,'A',w.threadId,w.customerId);
 await sales.beginNativeVoiceOfferTurn(w.db,'B',w.threadId,w.customerId);
 const b=await sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'B',nativeTurnKey:'B',actions:actions(w,'dog-basic')});
 await sales.acknowledgeNativeVoiceOfferTurn(w.db,'B',w.threadId,w.customerId);
 await sales.cancelNativeVoiceOfferTurn(w.db,'A',w.threadId,w.customerId);
 await sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'A',nativeTurnKey:'A',actions:actions(w,'dog-makeover')});
 assert.equal(w.sqlite.prepare('SELECT status FROM voice_sales_offers WHERE id=?').get(b.id).status,'pending');
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_sales_offers WHERE turn_key='A'").get().n,0);
});

test('native confirmation refuses an offer until delivered and a late mark cannot revive cancellation', async t => {
 const w=await world(t);
 await sales.beginNativeVoiceOfferTurn(w.db,'A',w.threadId,w.customerId);
 const a=await sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'A',nativeTurnKey:'A',actions:actions(w)});
 await sales.beginNativeVoiceOfferTurn(w.db,'yes',w.threadId,w.customerId);
 await refuse(sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,offerId:a.id,confirmation:'yes',nativeTurnKey:'yes'}),409);
 await sales.cancelNativeVoiceOfferTurn(w.db,'A',w.threadId,w.customerId);
 await sales.acknowledgeNativeVoiceOfferTurn(w.db,'A',w.threadId,w.customerId);
 assert.equal(w.sqlite.prepare("SELECT status FROM native_voice_offer_authority WHERE turn_key='A'").get().status,'cancelled');
 assert.equal(bookingCount(w),0);assert.equal(w.calls.length,0);
});

test('persisted assistant transcript cannot authorize native Yes without a carrier mark ACK', async t => {
 const w=await world(t);await sales.beginNativeVoiceOfferTurn(w.db,'queued',w.threadId,w.customerId);
 const a=await sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'queued',nativeTurnKey:'queued',actions:actions(w)});
 const now=Date.now();w.sqlite.prepare("INSERT INTO communication_messages(id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'exotel','voice','outbound','lifecycle','voice_transcript_segment',?,'received',?,'voice-test',?,?)").run('MSG-queued-transcript',w.threadId,w.customerId,JSON.stringify({text:a.summary}),'queued-transcript',now,now);
 await sales.beginNativeVoiceOfferTurn(w.db,'yes-queued',w.threadId,w.customerId);
 await refuse(sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,offerId:a.id,confirmation:'yes',nativeTurnKey:'yes-queued'}),409);
 assert.equal(w.calls.length,0);assert.equal(bookingCount(w),0);
 await sales.cancelNativeVoiceOfferTurn(w.db,'queued',w.threadId,w.customerId);
 await sales.acknowledgeNativeVoiceOfferTurn(w.db,'queued',w.threadId,w.customerId);
 await refuse(sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,offerId:a.id,confirmation:'yes',nativeTurnKey:'yes-queued'}),409);
 assert.equal(w.calls.length,0);assert.equal(bookingCount(w),0);
});

test('a current carrier-acknowledged native offer permits explicit confirmation', async t => {
 const w=await world(t);await sales.beginNativeVoiceOfferTurn(w.db,'heard',w.threadId,w.customerId);
 const a=await sales.prepareVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,turnKey:'heard',nativeTurnKey:'heard',actions:actions(w)});
 await sales.acknowledgeNativeVoiceOfferTurn(w.db,'heard',w.threadId,w.customerId);
 await sales.beginNativeVoiceOfferTurn(w.db,'yes-heard',w.threadId,w.customerId);
 await sales.confirmVoiceSalesOffer(w.db,{actor,threadId:w.threadId,customerId:w.customerId,service:w.service,offerId:a.id,confirmation:'yes',nativeTurnKey:'yes-heard'});
 assert.equal(bookingCount(w),1);assert.equal(w.calls.length,1);
});
