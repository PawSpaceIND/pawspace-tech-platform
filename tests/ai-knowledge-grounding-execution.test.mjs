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
