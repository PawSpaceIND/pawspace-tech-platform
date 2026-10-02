import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {seedOwnedPet} from './helpers/saved-pet-fixture.mjs';
import {applyOwnedDdl} from './helpers/ai-harness.mjs';

const actor={email:'elevenlabs-voice@system.pawspace',name:'Synthetic discount gateway',roleCode:'service_elevenlabs_voice',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:elevenlabs-voice'};
const start='2026-10-20T04:30:00.000Z',end='2026-10-20T06:30:00.000Z';
async function world(t){
 const w=await setupJourney();t.after(()=>w.close());
 await(await import('../lib/customer-account.ts')).ensureCustomerAccountTables(w.db);
 await(await import('../lib/ai-conversation-orchestrator.ts')).ensureAiConversationOrchestrator(w.db);
 await(await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(w.db);
 await(await import('../lib/voice-sales-specialists.ts')).ensureVoiceSalesOffers(w.db);
 for(const owner of ['training-commercial-governance','boarding-governance','sitting-governance','walking-governance','taxi-governance'])applyOwnedDdl(w.sqlite,`lib/${owner}.ts`);
 const now=Date.now(),customerId='CUS-DISCOUNT-QUOTE',threadId='THREAD-DISCOUNT-QUOTE',petId='PET-DISCOUNT-QUOTE';
 w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic tester','9876500093','test','{}',?,?)").run(customerId,now,now);
 await seedOwnedPet(w.db,customerId,petId,'Milo');
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 const schedule={serviceCode:'grooming',petIds:[petId],serviceAddress:'12 Test Street',servicePincode:'560038',scheduledStart:start,scheduledEnd:end};
 await(await import('../app/api/uat-scheduling/route.ts')).executeGovernedSchedulingRequest(new Request('https://internal.pawspace/api/uat-scheduling',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'preview',clientRequestId:'DISCOUNT-INIT',customerId,...schedule})}),actor);
 for(const p of w.sqlite.prepare("SELECT id,city_id,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active'").all()){
  w.sqlite.prepare("INSERT OR IGNORE INTO provider_home_base(id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,?,12.9716,77.5946,0,NULL,'test','test',?)").run(`discount-base-${p.id}`,p.id,'Synthetic base',now);
  for(const zone of JSON.parse(p.zones_json))w.sqlite.prepare("INSERT OR REPLACE INTO scheduling_availability(id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,'[\"09:00-19:00\"]','roster',?)").run(`${p.id}:discount`,p.id,p.city_id,zone,'2026-10-20',now);
 }
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'synthetic-not-real'};
 globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic discount quote authority',actorEmail:actor.email});
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let modelCalls=0;
 globalThis.fetch=async url=>{modelCalls++;assert.equal(String(url),'https://api.openai.com/v1/responses');return Response.json({status:'completed',output_text:JSON.stringify({reply:'Let me prepare the package details.',actions:[{toolCode:'schedule.reserve',arguments:schedule},{toolCode:'booking.create',arguments:{petIds:[petId],packageCode:'dog-basic',paymentMode:'prepaid',couponCode:'GROOM200'}},{toolCode:'checkout.payment_order.create',arguments:{}}]}),usage:{total_tokens:20}});};
 const run=async statement=>(await import('../lib/elevenlabs-custom-llm.ts')).runElevenLabsGroundedTurn(w.db,{model:'pawspace-grooming-sales',input:[{role:'user',content:'Any approved discount for grooming?'},{role:'assistant',content:'I can check eligible offers.'},{role:'user',content:statement}],elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}});
 return {...w,customerId,run,calls:()=>modelCalls};
}

for(const statement of ['Can you prepare grooming without a promotional discount?','Can you prepare grooming without using a promotional discount?','Can you prepare grooming without applying a discount?','Actually switch to boarding. Prepare a regular quote.','Please prepare the grooming quote with the approved coupon.'])test(`eligible model coupon proposal respects current authorization: ${statement}`,async t=>{
 const w=await world(t),result=await w.run(statement);
 assert.ok(w.calls()>0,'must exercise the model proposal');
 const offers=w.sqlite.prepare('SELECT quote_json FROM voice_sales_offers WHERE customer_id=?').all(w.customerId);
 const allowed=statement==='Please prepare the grooming quote with the approved coupon.';
 assert.equal(offers.length,allowed?1:0,JSON.stringify({result,offers}));
 if(allowed)assert.match(offers[0].quote_json,/GROOM200/,'same proposal demonstrably creates an eligible discounted offer when explicitly requested');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(w.customerId).n,0,'an offer is not execution permission');
});
