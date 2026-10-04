import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {applyOwnedDdl,stubFetch,jsonResponse} from './helpers/ai-harness.mjs';
const {createGroundedAiRuntimeProvider,buildGroundedAiTurnContext}=await import('../lib/ai-grounded-runtime-provider.ts');
const {classifyAiIntent,ensureAiConversationOrchestrator}=await import('../lib/ai-conversation-orchestrator.ts');
const {ensureCustomerAccountTables}=await import('../lib/customer-account.ts');
const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');
const {seedMayaKnowledge}=await import('../lib/maya-knowledge-base.ts');
const actor={email:'knowledge-test@system.pawspace',name:'Test',roleCode:'service',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:knowledge-test'};
async function world(t){
 const w=await setupJourney();t.after(()=>w.close());
 await ensureCustomerAccountTables(w.db);await ensureAiConversationOrchestrator(w.db);await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 const now=Date.now();w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES('CUS-KB','blr','Synthetic KB tester','NOT_DIALABLE','test','{}',?,?)").run(now,now);
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES('THREAD-KB','CUS-KB','open','ai-orchestrator',?,?)").run(now,now);
 w.sqlite.prepare("UPDATE service_packages SET active=1,tax_inclusive=1,description='Verified full package description' WHERE package_code='dog-bath'").run();
 await seedMayaKnowledge(w.db,{maker:'maker@test.invalid',checker:'checker@test.invalid'});
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'fake-test-only'};
 return w;
}
for(const channel of ['voice','chat','whatsapp'])test(channel+': real runtime grounds policy explanation and supplies no action tools',async t=>{
 const w=await world(t);let sent;
 const mock=stubFetch((url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:'Refund review uses the purchased terms and verified booking/payment state. A request is not a processed refund.',usage:{total_tokens:20}});});t.after(()=>mock.restore());
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,channel,{salesService:'grooming'});
 const query='How does your refund review process work?';
 const result=await provider.generate({threadId:'THREAD-KB',customerId:'CUS-KB',channel,inputText:query,intent:classifyAiIntent(query),context:{customer:{customerId:'CUS-KB'},pets:[],bookings:[],thread:{id:'THREAD-KB'}}});
 assert.equal(mock.calls.length,1);assert.match(sent.instructions,/information-only policy enquiry/);assert.doesNotMatch(sent.instructions,/Specialty: Grooming only/);
 if(channel==='voice'){assert.match(sent.instructions,/at most one or two closely related missing questions/);assert.match(sent.instructions,/complex care needs.*ask only one question at a time/i);assert.doesNotMatch(sent.instructions,/3 or 4 closely related missing questions/);assert.match(sent.instructions,/20 to 40 words/);assert.match(sent.instructions,/Keep payment or booking confirmation separate/);}
 const context=JSON.parse(sent.input).canonicalContext;assert.deepEqual(context.availableActionTools,[]);assert.equal(context.informationOnly,true);
 assert.match(JSON.stringify(context.approvedKnowledge),/maya_refund_process/);assert.ok(result.groundingRefs.length>0);
 const bath=context.catalogue.grooming.find(r=>r.package_code==='dog-bath');assert.equal(bath.tax_inclusive,1);assert.equal(bath.description,'Verified full package description');
 const bookingTable=w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").get();
 assert.equal(bookingTable?w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUS-KB'").get().n:0,0);
});
test('fast voice includes approved knowledge and actual tax flags rather than omitting policy facts',async t=>{
 const w=await world(t);
 const mock=stubFetch(()=>{throw Error('Grounding must not invoke a model');});t.after(()=>mock.restore());
 const result=await buildGroundedAiTurnContext(w.db,{actor,threadId:'THREAD-KB',customerId:'CUS-KB',intent:'service_info',channel:'voice',query:'How does refund review work?',canonicalContext:{customer:{customerId:'CUS-KB'}},fastVoice:true});
 assert.match(JSON.stringify(result.context.approvedKnowledge),/maya_refund_process/);assert.ok(result.groundingRefs.length>0);
 assert.equal(result.context.catalogue.grooming.find(r=>r.package_code==='dog-bath').tax_inclusive,1);assert.equal(mock.calls.length,0);
});

// The review reproduced these three dated records in one supposedly-current catalogue.
test('normal and fast grounding exclude future expired malformed and inactive Grooming rows',async t=>{
 const w=await world(t),day=new Date().toISOString().slice(0,10);
 const set=(code,active,from,to,label)=>w.sqlite.prepare('UPDATE service_packages SET active=?,effective_from=?,effective_to=?,description=? WHERE package_code=?').run(active,from,to,label,code);
 set('dog-bath',1,day,day,'CURRENT_BOUNDARY');
 set('dog-basic',1,'2000-01-01','2000-12-31','EXPIRED_CANARY');
 set('dog-makeover',1,'2099-01-01',null,'FUTURE_CANARY');
 set('dog-trim',0,'2000-01-01',null,'INACTIVE_CANARY');
 set('cat-routine',1,'not-a-date',null,'MALFORMED_CANARY');
 const {canonicalCatalogueSnapshot,pricesMatchCatalogue}=await import('../lib/ai-grounded-runtime-provider.ts');
 const catalogue=await canonicalCatalogueSnapshot(w.db);
 assert.deepEqual(catalogue.grooming.map(r=>r.package_code),['dog-bath']);
 assert.doesNotMatch(JSON.stringify(catalogue),/EXPIRED_CANARY|FUTURE_CANARY|INACTIVE_CANARY|MALFORMED_CANARY/);
 assert.equal(pricesMatchCatalogue('Grooming Complete Makeover is ₹2399.',catalogue),false);
 for(const fastVoice of [false,true]){
  const result=await buildGroundedAiTurnContext(w.db,{actor,threadId:'THREAD-KB',customerId:'CUS-KB',intent:'service_info',channel:'voice',query:'What is included in grooming?',canonicalContext:{customer:{customerId:'CUS-KB'}},fastVoice});
  assert.deepEqual(result.context.catalogue.grooming.map(r=>r.package_code),['dog-bath']);
  assert.doesNotMatch(JSON.stringify(result.context),/EXPIRED_CANARY|FUTURE_CANARY|INACTIVE_CANARY|MALFORMED_CANARY/);
 }
});
test('Grooming effective days are inclusive and filtering happens before the 25-row display bound',async t=>{
 const w=await world(t),{currentGroomingCatalogue}=await import('../lib/ai-current-catalogue.ts');
 w.sqlite.prepare("UPDATE service_packages SET active=1,effective_from='2099-01-01',effective_to=NULL,base_price=1 WHERE service_code='grooming'").run();
 w.sqlite.prepare("UPDATE service_packages SET effective_from='2026-09-28',effective_to='2026-09-28',base_price=1349 WHERE package_code='dog-bath'").run();
 const at=Date.parse('2026-09-28T12:00:00Z');
 assert.deepEqual((await currentGroomingCatalogue(w.db,at)).map(r=>r.package_code),['dog-bath']);
 assert.equal((await currentGroomingCatalogue(w.db,at-86400000)).length,0);
 assert.equal((await currentGroomingCatalogue(w.db,at+86400000)).length,0);
 await assert.rejects(()=>currentGroomingCatalogue(w.db,NaN),/valid catalogue/);
});
for(const channel of ['voice','chat','whatsapp'])test(channel+': information questions keep sales history but expose no checkout proposal tools',async t=>{
 const w=await world(t);let sent;
 const mock=stubFetch((url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:'The groomer brings the equipment and products.',usage:{total_tokens:20}});});t.after(()=>mock.restore());
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,channel,{salesService:'grooming'}),question='What equipment does the groomer bring?';
 await provider.generate({threadId:'THREAD-KB',customerId:'CUS-KB',channel,inputText:question,intent:classifyAiIntent(question),context:{customer:{customerId:'CUS-KB'},pets:[],bookings:[],thread:{id:'THREAD-KB'}}});
 assert.equal(mock.calls.length,1);assert.match(sent.instructions,/read-only sales information question/);
 assert.doesNotMatch(sent.instructions,/Specialty: Grooming only/);
 const cc=JSON.parse(sent.input).canonicalContext;assert.equal(cc.informationOnly,true);assert.deepEqual(cc.availableActionTools,[]);assert.ok(Array.isArray(cc.conversationHistory));
});

test('Daycare prices bind to Boarding catalogue rows without accepting another service price', async () => {
 const {pricesMatchCatalogue}=await import('../lib/ai-grounded-runtime-provider.ts');
 const catalogue={boarding:[{package_code:'boarding-4h',name:'Standard Stay',base_price_per_pet:499},{package_code:'boarding-10h',name:'Premium Stay',base_price_per_pet:599}],petTaxi:[{name:'Taxi',amount:799}]};
 assert.equal(pricesMatchCatalogue('Daycare is available for up to four hours at ₹499 or ten hours at ₹599 per pet.',catalogue),true);
 assert.equal(pricesMatchCatalogue('Day care starts at 499 rupees.',catalogue),true);
 assert.equal(pricesMatchCatalogue('Daycare costs 799 rupees.',catalogue),false);
 assert.equal(pricesMatchCatalogue('Grooming costs 499 rupees.',catalogue),false);
});

test('routine vet booking information remains answerable while symptoms keep medical protection',async()=>{
 const {isPetMedicalQuestion}=await import('../lib/ai-grounded-runtime-provider.ts');
 assert.equal(isPetMedicalQuestion('Please explain how I can arrange a routine veterinary consultation, without booking anything yet.'),false);
 assert.equal(isPetMedicalQuestion('How can I arrange a vet consultation for my dog who is coughing?'),true);
 assert.equal(isPetMedicalQuestion('My rabbit is sick. What service can help?'),true);
 assert.equal(isPetMedicalQuestion('My dog has mild itching.'),true);
});


test('multi-service quote instructions do not impose Grooming on a Training request',async t=>{
 const w=await world(t);let sent;
 await (await import('../lib/taxi-governance.ts')).ensureTaxiGovernanceTables(w.db);
 const mock=stubFetch((url,init)=>{sent=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:'Which saved pet should attend the trainer assessment?',usage:{total_tokens:20}});});t.after(()=>mock.restore());
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'}),query='Prepare an unconfirmed dog training Meet and Greet quote.';
 await provider.generate({threadId:'THREAD-KB',customerId:'CUS-KB',channel:'voice',inputText:query,intent:classifyAiIntent(query),context:{customer:{customerId:'CUS-KB'},pets:[],bookings:[],thread:{id:'THREAD-KB'}}});
 assert.match(sent.instructions,/serviceCode:"chosen enabled service code"/);
 assert.doesNotMatch(sent.instructions,/Use exactly these argument schemas: schedule.reserve=\{serviceCode:"grooming"/);
 assert.match(sent.instructions,/Training=dog_training/);
 assert.match(sent.instructions,/booking.create.arguments.taxi/);
 assert.match(sent.instructions,/at most one or two closely related missing questions/);assert.match(sent.instructions,/complex care needs.*ask only one question at a time/i);assert.doesNotMatch(sent.instructions,/3 or 4 closely related missing questions/);
 const context=JSON.parse(sent.input).canonicalContext;assert.deepEqual(context.catalogue.petTaxi,[]);assert.equal(context.catalogueTool,null);
 assert.match(sent.instructions,/separate explicit customer confirmation/);
});


test('Taxi information enquiries cannot expose legacy synthetic route fares',async t=>{
 const w=await world(t);await (await import('../lib/taxi-governance.ts')).ensureTaxiGovernanceTables(w.db);let sent;
 const mock=stubFetch((url,init)=>{sent=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:'The route and vehicle determine your Taxi quote. What are the pickup and drop locations?',usage:{total_tokens:20}});});t.after(()=>mock.restore());
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'}),query='What determines the pet taxi price?';
 await provider.generate({threadId:'THREAD-KB',customerId:'CUS-KB',channel:'voice',inputText:query,intent:classifyAiIntent(query),context:{customer:{customerId:'CUS-KB'},pets:[],bookings:[],thread:{id:'THREAD-KB'}}});
 const cc=JSON.parse(sent.input).canonicalContext;assert.equal(cc.informationOnly,true);assert.deepEqual(cc.catalogue.petTaxi,[]);assert.equal(cc.catalogueTool,null);assert.deepEqual(cc.availableActionTools,[]);
});

test('funeral owner tariff and intake reach both voice grounding paths without executing payments',async t=>{
 const w=await world(t);
 const {pricesMatchCatalogue}=await import('../lib/ai-grounded-runtime-provider.ts');
 const mock=stubFetch(()=>{throw Error('Read-only funeral grounding must not send links or call providers');});t.after(()=>mock.restore());
 for(const fastVoice of [false,true]){
  const {context}=await buildGroundedAiTurnContext(w.db,{actor,threadId:'THREAD-KB',customerId:'CUS-KB',intent:'service_info',channel:'voice',query:'pet funeral cremation',canonicalContext:{customer:{customerId:'CUS-KB'}},fastVoice});
  assert.deepEqual(context.catalogue.funeral.map(r=>r.base_price),[7000,9000,16000,2000,6000,7500,2000]);
  assert.equal(context.operationalFaq.funeral.advancePercent,50);
  assert.equal(context.operationalFaq.funeral.execution,'staff_required');
  assert.equal(context.operationalFaq.funeral.pickupCutoffHour,16);
  assert.ok(context.operationalFaq.funeral.requiredIntake.includes('secondaryContactPhone'));
  assert.ok(pricesMatchCatalogue('Electric cremation costs ₹7,000. Ash plantation costs ₹7,500.',context.catalogue));
  assert.equal(pricesMatchCatalogue('Electric cremation costs ₹7,999.',context.catalogue),false);
  assert.equal(pricesMatchCatalogue('Ash plantation costs ₹7,000.',context.catalogue),false);
  assert.equal(pricesMatchCatalogue('Electric cremation costs ₹16,000.',context.catalogue),false);
  assert.match(JSON.stringify(context.approvedKnowledge),/primary and secondary contact/);
 }
 assert.equal(mock.calls.length,0);
});

test('actual Maya provider receives care descriptions without fixed host or sitter prices',async t=>{
 const w=await world(t);
 for(const owner of ['lib/boarding-governance.ts','lib/sitting-governance.ts']){
  const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');applyOwnedDdl(w.sqlite,owner);
 }
 await (await import('../lib/boarding-governance.ts')).ensureBoardingGovernanceTables(w.db);
 await (await import('../lib/sitting-governance.ts')).ensureSittingGovernanceTables(w.db);
 let request;
 const mock=stubFetch((url,init)=>{request=JSON.parse(init.body);return jsonResponse({status:'completed',output_text:'Daycare is daytime care. Prices depend on the available host; complete booking in the PawSpace app.'});});t.after(()=>mock.restore());
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'}),query='How does daycare work?';
 await provider.generate({threadId:'THREAD-KB',customerId:'CUS-KB',channel:'voice',inputText:query,intent:classifyAiIntent(query),context:{customer:{customerId:'CUS-KB'},pets:[],bookings:[],thread:{id:'THREAD-KB'}}});
 const context=JSON.parse(request.input).canonicalContext;
 for(const key of ['boarding','petSitting']){
  assert.ok(context.catalogue[key].length>0);
  for(const row of context.catalogue[key]){
   assert.equal(row.base_price_per_pet,undefined);assert.equal(row.extra_pet_price,undefined);
   assert.equal(row.pricingBasis,'available_provider_quote');assert.equal(row.bookingChannel,'customer_app');
  }
 }
 assert.match(request.instructions,/Catalogue defaults are not customer quotes/);
 assert.match(request.instructions,/final booking in the PawSpace app/);
 assert.match(request.instructions,/first pickup, drop and date\/time/);
});

test('one actionable veterinary recommendation is not repeated by the medical reply guard',async()=>{
 const {ensureVeterinaryReferral}=await import('../lib/ai-grounded-runtime-provider.ts');
 const baseline='Yes. Because itching can have several causes, please have a veterinarian assess Bruno before grooming.';
 assert.equal(ensureVeterinaryReferral(baseline,true),baseline);
 const ordinary='A veterinarian may assess itching in many ways.';
 assert.match(ensureVeterinaryReferral(ordinary,true),/Please contact a veterinarian about this medical concern/);
 assert.equal(ensureVeterinaryReferral('Please contact your vet.',true),'Please contact your vet.');
});

test('common Taxi intake explanation uses enabled service knowledge with no model or mutation',async t=>{
 const w=await world(t),mock=stubFetch(()=>{throw Error('Common information must not invoke the model');});t.after(()=>mock.restore());
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'}),query='How does your pet taxi service work, and what pickup information would you need?';
 const result=await provider.generate({threadId:'THREAD-KB',customerId:'CUS-KB',channel:'voice',inputText:query,intent:classifyAiIntent(query),context:{customer:{customerId:'CUS-KB'},pets:[],bookings:[],thread:{id:'THREAD-KB'}}});
 assert.equal(result.modelRef,'server_owned_taxi_intake');assert.equal(mock.calls.length,0);
 assert.match(result.text,/pickup and drop addresses/);assert.doesNotMatch(result.text,/luggage|waiting/);
 assert.ok(result.text.split(/\s+/).length<=40);assert.deepEqual(result.actionRequests,[]);
});

test('disabled Taxi service cannot use the first-intake guidance shortcut',async t=>{
 const w=await world(t);const controls=await import('../lib/service-control.ts');await controls.ensureServiceControlTables(w.db);
 w.sqlite.prepare("UPDATE service_controls SET enabled=0,disabled_reason='review' WHERE service_code='pet_taxi'").run();
 const mock=stubFetch(()=>jsonResponse({status:'completed',output_text:'Pet Taxi is temporarily unavailable for new requests.'}));t.after(()=>mock.restore());
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'}),query='How does your pet taxi service work?';
 const result=await provider.generate({threadId:'THREAD-KB',customerId:'CUS-KB',channel:'voice',inputText:query,intent:classifyAiIntent(query),context:{customer:{customerId:'CUS-KB'},pets:[],bookings:[],thread:{id:'THREAD-KB'}}});
 assert.equal(mock.calls.length,1);assert.notEqual(result.modelRef,'server_owned_taxi_intake');assert.match(result.text,/unavailable/);
});
