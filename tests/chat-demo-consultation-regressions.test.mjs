import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCustomerConsultation,consultationDiscoveryReply} from '../lib/customer-consultation.ts';
import {mayaStayDescriptions} from '../lib/maya-stay-policy.ts';
const context={pets:[{id:'BRUNO',name:'Bruno',species:'dog',age_years:4},{id:'MISTY',name:'Misty',species:'cat',age_years:14}],catalogue:{}};
const adult='Bruno is an adult dog who pulls on walks and barks at visitors. Puppy basics is not my goal. Which training package fits?';
test('adult-training-discovery: stated pulling/barking goals are retained',()=>{const p=buildCustomerConsultation({history:[],currentText:adult,context,service:'dog_training',channel:'chat'});assert.ok(p.needs.some(g=>/pull|bark/.test(g)),'actual input verbs must not be treated as an unstated training goal');});
test('adult-training-discovery: which-package-fits triggers one relevant discovery question',()=>{const p=buildCustomerConsultation({history:[],currentText:adult,context,service:'dog_training',channel:'chat'});assert.ok(consultationDiscoveryReply(p,adult),'named-package fit must first clarify missing severity/history rather than skip discovery');});
test('pet-concern-isolation: pause grooming and switch to cat visits changes active service',()=>{const p=buildCustomerConsultation({history:[{role:'user',content:'Bruno needs grooming and is anxious around dryers.'}],currentText:'Pause Bruno grooming. My elderly cat dislikes travel and needs visits.',context,service:'grooming',channel:'chat'});assert.equal(p.service,'pet_sitting','paused dog grooming must not remain the current recommendation target');});
test('care-window-unknown: a three-day absence does not imply overnight care',()=>{const p=buildCustomerConsultation({history:[],currentText:'My elderly cat dislikes travel. I will be away three days. Compare boarding and sitting.',context,channel:'chat'});assert.ok(p.questions.some(q=>/visit|overnight|window/i.test(q)),'one relevant care-window question is missing from deterministic consultation');});
test('care-window-supplied: consultation does not repeat an already supplied visit window',()=>{const p=buildCustomerConsultation({history:[],currentText:'My elderly cat needs two short visits daily for three days, not overnight. What is the next step?',context,service:'pet_sitting',channel:'chat'});assert.equal(p.questions.length,0);assert.equal(p.nextStep,'verified_caregiver_information_then_app');});
test('stay-price-boundary: fallback prices are removed from model-facing caregiver descriptions',()=>{const rows=mayaStayDescriptions([{package_code:'SYNTHETIC',name:'Visits',base_price_per_pet:999,extra_pet_price:99}]);assert.equal(rows[0].bookingChannel,'customer_app');assert.equal(rows[0].pricingBasis,'available_provider_quote');assert.equal(Object.hasOwn(rows[0],'base_price_per_pet'),false);assert.equal(Object.hasOwn(rows[0],'extra_pet_price'),false);});

import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {applyOwnedDdl,stubFetch,jsonResponse} from './helpers/ai-harness.mjs';
const {createGroundedAiRuntimeProvider,pawspaceChannelSystemPrompt}=await import('../lib/ai-grounded-runtime-provider.ts');
const {classifyAiIntent,ensureAiConversationOrchestrator}=await import('../lib/ai-conversation-orchestrator.ts');
const {ensureCustomerAccountTables}=await import('../lib/customer-account.ts');
const {setAiRolloutStage}=await import('../lib/ai-audience-rollout.ts');
const {ensureLeadCallbackTables}=await import('../lib/lead-callback-governance.ts');
const {ensureLeadWorkItemsTable}=await import('../lib/lead-conversion-attribution.ts');
const {ensureVoiceSalesOffers}=await import('../lib/voice-sales-specialists.ts');
const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');
const {seedMayaKnowledge}=await import('../lib/maya-knowledge-base.ts');
const {ensureAiWebChatTables,chatSalesService,chatSalesServiceNamed,runAuthenticatedAiWebChat}=await import('../lib/ai-web-chat-adapter.ts');
const actor={email:'demo-regression@system.pawspace',name:'Synthetic probe',roleCode:'service',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:demo-regression'};
async function runtime(t){
 const w=await setupJourney();t.after(()=>w.close());
 await ensureCustomerAccountTables(w.db);await ensureAiConversationOrchestrator(w.db);await ensurePricingControlRuntime(w.db);await ensureAiWebChatTables(w.db);
 for(const file of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,file);
 const now=Date.now();w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES('CUS-DEMO','blr','Synthetic probe','NOT_DIALABLE','test','{}',?,?)").run(now,now);
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES('THREAD-DEMO','CUS-DEMO','open','ai-orchestrator',?,?)").run(now,now);
 await seedMayaKnowledge(w.db,{maker:'maker@test.invalid',checker:'checker@test.invalid'});
 await setAiRolloutStage(w.db,{stage:'staff_only',reason:'Synthetic stay regression',actorEmail:actor.email});
 await ensureVoiceSalesOffers(w.db);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-test-only'};
 const generate=async(query,extra={},options={})=>{
  const service=await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO',query);
  const provider=await createGroundedAiRuntimeProvider(w.db,actor,'chat',{salesService:service,...options});
  return provider.generate({threadId:'THREAD-DEMO',customerId:'CUS-DEMO',channel:'chat',inputText:query,intent:classifyAiIntent(query),context:{...context,customer:{customerId:'CUS-DEMO'},bookings:[],thread:{id:'THREAD-DEMO'},...extra}});
 };
 const businessSnapshot=()=>['canonical_customers','canonical_bookings','scheduling_reservations','finance_payment_orders'].map(name=>w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)?w.sqlite.prepare('SELECT * FROM '+name+' ORDER BY rowid').all():[]);
 return {...w,generate,businessSnapshot};
}
test('actual chat topic memory changes from paused grooming to cat sitting',async t=>{
 const w=await runtime(t);assert.equal(await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO','Bruno needs grooming.'),'grooming');
 assert.equal(await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO','Pause Bruno grooming. My elderly cat dislikes travel and needs visits.'),'pet_sitting');
 assert.equal(await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO','What is the next app step?'),'pet_sitting');
 assert.equal(chatSalesServiceNamed('No daycare. Recommend grooming.'),'grooming');
});
test('actual coverage limitation reply makes no model call, locality request or business mutation',async t=>{
 const w=await runtime(t),before=w.businessSnapshot();const mock=stubFetch(()=>{throw Error('Unexpected external request');});t.after(()=>mock.restore());
 const result=await w.generate('Can you actually verify caregiver coverage, availability or a fixed price in this chat?');
 assert.equal(mock.calls.length,0);assert.equal(result.provider,'conversation_capability');assert.match(result.text,/can't verify/);assert.match(result.text,/PawSpace app/);assert.doesNotMatch(result.text,/\?|pin.?code|locality|booked|confirmed/i);assert.deepEqual(result.actionRequests,[]);assert.deepEqual(w.businessSnapshot(),before);
});
test('actual book-now stay refusal has no model call or business mutation',async t=>{
 const w=await runtime(t),before=w.businessSnapshot(),mock=stubFetch(()=>{throw Error('Unexpected external request');});t.after(()=>mock.restore());
 const result=await w.generate('Choose a caregiver, give a fixed sitting price and book it now.');
 assert.equal(mock.calls.length,0);assert.match(result.text,/haven't selected a caregiver or made a booking/);assert.deepEqual(result.actionRequests,[]);assert.deepEqual(w.businessSnapshot(),before);
});
test('actual adult training fit asks one severity question before any model recommendation',async t=>{
 const w=await runtime(t),mock=stubFetch(()=>{throw Error('Discovery must happen first');});t.after(()=>mock.restore());
 const result=await w.generate(adult);assert.equal(mock.calls.length,0);assert.equal(result.provider,'conversation_consultation');assert.match(result.text,/lunged or bitten/);assert.equal((result.text.match(/\?/g)||[]).length,1);assert.doesNotMatch(result.text,/How old|What would you most like/);assert.deepEqual(result.actionRequests,[]);
});
test('actual absent care window asks one question without a model, quote or overnight assumption',async t=>{
 const w=await runtime(t),mock=stubFetch(()=>{throw Error('Discovery must happen first');});t.after(()=>mock.restore());
 const result=await w.generate('My elderly cat dislikes travel. I will be away three days. Compare boarding and sitting.');
 assert.equal(mock.calls.length,0);assert.match(result.text,/short visits, a daytime period, or overnight care\?/);assert.deepEqual(result.actionRequests,[]);
});
test('supplied visit window remains separate from Bruno and survives the next app-step turn',()=>{
 const history=[{role:'user',content:'Bruno needs grooming and fears dryers.'},{role:'user',content:'Pause Bruno grooming. My elderly cat needs two short visits daily for three days, not overnight.'}];
 const p=buildCustomerConsultation({history,currentText:'Tell me the next app step briefly.',context,service:'pet_sitting',channel:'chat'});
 assert.equal(p.careWindow,'visits');assert.match(p.careWindowSource,/two short visits daily for three days/);assert.doesNotMatch(p.careWindowSource,/Bruno|dryers/);assert.equal(p.questions.length,0);assert.equal(p.identityVerified,false);assert.equal(p.bookingConsent,false);
});
test('unsafe mocked stay tool envelope is replaced without exposing actions or changing business records',async t=>{
 const w=await runtime(t),before=w.businessSnapshot();let sent;
 const mock=stubFetch((url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:JSON.stringify({reply:'A booking was made.',actions:[{toolCode:'booking.create',arguments:{packageCode:'UNAPPROVED',petIds:['BRUNO']}}]}),usage:{total_tokens:20}});});t.after(()=>mock.restore());
 const result=await w.generate('My elderly cat needs two short visits daily for three days, not overnight. What is the next step?');
 assert.equal(mock.calls.length,1);assert.deepEqual(result.actionRequests,[]);assert.match(result.text,/have not made a booking/);assert.deepEqual(w.businessSnapshot(),before);
 const grounded=JSON.parse(sent.input).canonicalContext;assert.deepEqual(grounded.availableActionTools,[]);assert.equal(grounded.informationOnly,true);assert.equal(grounded.stayCapabilities.caregiverCoverageLookup,false);assert.equal(grounded.customerConsultation.careWindow,'visits');assert.doesNotMatch(sent.instructions,/always end by asking for the booking|Specialty: Pet Sitting/);
});
test('chat guidance directly answers requested app steps; voice channel keeps its established style',()=>{
 const prompt=pawspaceChannelSystemPrompt('chat');assert.match(prompt,/without asking permission to explain it again/);assert.doesNotMatch(prompt,/always end by asking for the booking/);
 const voice=pawspaceChannelSystemPrompt('voice');assert.doesNotMatch(voice,/without asking permission to explain it again/);assert.match(voice,/20 to 40 words/);
});

test('normal authenticated stay confirmation preserves a pending offer and executes no business actions',async t=>{
 const w=await runtime(t),now=Date.now();await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO','I need pet sitting.');
 w.sqlite.prepare("INSERT INTO voice_sales_offers(id,turn_key,thread_id,customer_id,service_code,status,quote_json,actions_json,summary,expires_at,created_at) VALUES('STAY-OLD','old-stay','THREAD-DEMO','CUS-DEMO','pet_sitting','pending','{}',?,'Synthetic existing stay offer',?,?)").run(JSON.stringify([{toolCode:'booking.create',arguments:{packageCode:'UNAPPROVED'}}]),now+60000,now);
 const before=w.businessSnapshot(),offerBefore=w.sqlite.prepare("SELECT * FROM voice_sales_offers WHERE id='STAY-OLD'").get();let sent;
 const mock=stubFetch((url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:'Caregiver booking is completed in the PawSpace app. No booking has been made here.',usage:{total_tokens:20}});});t.after(()=>mock.restore());
 const result=await runAuthenticatedAiWebChat(w.db,{actor,customerId:'CUS-DEMO',text:'Yes, book it.',idempotencyKey:'stay-confirmation'}, {threadId:'THREAD-DEMO'});
 assert.deepEqual(w.sqlite.prepare("SELECT * FROM voice_sales_offers WHERE id='STAY-OLD'").get(),offerBefore);assert.deepEqual(w.businessSnapshot(),before);assert.equal(result.ai.turn.policyDecision,'chat_stay_read_only');assert.equal(mock.calls.length,1);assert.deepEqual(JSON.parse(sent.input).canonicalContext.availableActionTools,[]);
 const replay=await runAuthenticatedAiWebChat(w.db,{actor,customerId:'CUS-DEMO',text:'Yes, book it.',idempotencyKey:'stay-confirmation'}, {threadId:'THREAD-DEMO'});assert.equal(replay.duplicatePrevented,true);assert.equal(mock.calls.length,1);assert.deepEqual(w.businessSnapshot(),before);
});
test('normal authenticated stay followup cannot cancel an existing scheduled agreement',async t=>{
 const w=await runtime(t),now=Date.now();await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO','I need pet sitting.');
 await ensureLeadWorkItemsTable(w.db);await ensureLeadCallbackTables(w.db);
 w.sqlite.prepare("INSERT INTO lead_work_items(id,customer_id,source,service,owner,manager,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES('LEAD-DEMO','CUS-DEMO','test','pet_sitting','owner','manager',?,?,?,?,?)").run(now,now+10000,now+20000,now,now);
 w.sqlite.prepare("UPDATE communication_threads SET lead_id='LEAD-DEMO' WHERE id='THREAD-DEMO'").run();
 w.sqlite.prepare("INSERT INTO lead_callbacks(id,lead_id,requested_at,reason,status,scheduled_by,created_at,updated_at) VALUES('CALLBACK-DEMO','LEAD-DEMO',?,'Synthetic existing agreement','scheduled','test',?,?)").run(now+60000,now,now);
 const callbackBefore=w.sqlite.prepare("SELECT * FROM lead_callbacks WHERE id='CALLBACK-DEMO'").get(),business=w.businessSnapshot(),mock=stubFetch(()=>jsonResponse({status:'completed',output_text:'Please use the PawSpace app or contact the team to manage this stay. No callback has been changed.',usage:{total_tokens:20}}));t.after(()=>mock.restore());
 const result=await runAuthenticatedAiWebChat(w.db,{actor,customerId:'CUS-DEMO',text:'Cancel my followup.',idempotencyKey:'stay-followup'}, {threadId:'THREAD-DEMO'});
 assert.deepEqual(w.sqlite.prepare("SELECT * FROM lead_callbacks WHERE id='CALLBACK-DEMO'").get(),callbackBefore);assert.deepEqual(w.businessSnapshot(),business);assert.equal(result.ai.turn.policyDecision,'chat_stay_read_only');assert.equal(mock.calls.length,1);
 const receipts=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='ai_conversation_followup_receipts'").get();if(receipts)assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM ai_conversation_followup_receipts').get().n,0);
});

for(const [previous,current,expected] of [
 ['My cat needs two visits daily.','Actually change to overnight care, not visits.','overnight'],
 ['My cat needs two visits daily.','Cancel the visits. I now need overnight care.','overnight'],
 ['My cat needs overnight care.','Actually change to two short visits daily, not overnight.','visits'],
 ['My cat needs overnight care.','Cancel overnight care. I now need visits.','visits'],
])test('latest affirmed care-window correction: '+current,()=>{
 const p=buildCustomerConsultation({history:[{role:'user',content:previous}],currentText:current,context,service:'pet_sitting',channel:'chat'});
 assert.equal(p.careWindow,expected);assert.equal(p.questions.length,0);assert.equal(p.identityVerified,false);assert.equal(p.bookingConsent,false);
 const retained=buildCustomerConsultation({history:[{role:'user',content:previous},{role:'user',content:current}],currentText:'What is the next app step?',context,service:'pet_sitting',channel:'chat'});assert.equal(retained.careWindow,expected);
});
for(const [query,service,sales] of [
 ['Switch from sitting to pet taxi.','pet_taxi','pet_taxi'],
 ['Pause sitting. I need pet taxi.','pet_taxi','pet_taxi'],
 ['Switch from sitting to dog walking.','dog_walking',undefined],
 ['Pause sitting. I need funeral care.','funeral',undefined],
])test('normal authenticated explicit service switch clears stay scope: '+query,async t=>{
 const w=await runtime(t);await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO','I need pet sitting.');
 const plan=buildCustomerConsultation({history:[{role:'user',content:'I need pet sitting.'}],currentText:query,context,service:'pet_sitting',channel:'chat'});assert.equal(plan.service,service);
 let sent;const mock=stubFetch((url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:service==='pet_taxi'?'What are the pickup and drop-off addresses?':'The team can help with your request.',usage:{total_tokens:20}});});t.after(()=>mock.restore());
 const result=await runAuthenticatedAiWebChat(w.db,{actor,customerId:'CUS-DEMO',text:query,idempotencyKey:'switch-'+service+query},{threadId:'THREAD-DEMO'});
 assert.notEqual(result.ai.turn.policyDecision,'chat_stay_read_only');assert.notEqual(result.ai.turn.policyDecision,'chat_stay_answer_refused');
 assert.equal(await chatSalesService(w.db,'CUS-DEMO','THREAD-DEMO','Tell me the next step.'),sales);
 if(sent){const grounded=JSON.parse(sent.input).canonicalContext;assert.equal(grounded.stayCapabilities,undefined);assert.doesNotMatch(sent.instructions,/Caregiver selection, rates, booking and payment are app-only/);if(service==='pet_taxi'){assert.equal(grounded.salesService,'pet_taxi');assert.notEqual(grounded.informationOnly,true);assert.match(sent.instructions,/Executable voice booking services are grooming, dog_training and pet_taxi/);}}
 if(service==='pet_taxi')assert.equal(mock.calls.length,1,'Taxi must retain its existing provider path');
});
