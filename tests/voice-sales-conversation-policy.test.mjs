import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {seedOwnedPet} from './helpers/saved-pet-fixture.mjs';
import {applyOwnedDdl} from './helpers/ai-harness.mjs';
import {humanCallPrompt} from '../lib/elevenlabs-human-call-profile.mjs';
const {specialistSalesPrompt,voiceQuotePolicyText,isVoiceSalesConfirmation}=await import('../lib/voice-sales-specialists.ts');
const {classifyAiIntent}=await import('../lib/ai-conversation-orchestrator.ts');

test('an explicitly unconfirmed quote accepts coordinated negative execution wording',()=>{
 for(const withheld of ['Do not reserve, book or create a payment order yet.','Do not reserve or create a booking or payment order.','Do not book a slot or create the payment order.','Don’t create a booking or a payment order yet.']){
  const text='Please prepare an unconfirmed quote for Complete Makeover for Milo. '+withheld;
  assert.equal(classifyAiIntent(text).policyRisk,false,withheld);
  assert.doesNotMatch(voiceQuotePolicyText(text),/payment/i,withheld);
  assert.equal(isVoiceSalesConfirmation(text),false);
 }
});
test('positive, mixed and ambiguous payment wording keeps its risk and cannot count as confirmation',()=>{
 for(const clause of ['Create a payment order now.','Do not reserve, but create a payment order now.','Do not create a payment order yet. Then create a payment order now.','Do not create a payment order unless I say yes.','Do not create a payment order, then take payment.']){
  const text='Please prepare an unconfirmed quote for Complete Makeover for Milo. '+clause;
  assert.match(voiceQuotePolicyText(text),/payment/i,clause);
  assert.equal(classifyAiIntent(text).policyRisk,true,clause);
  assert.equal(isVoiceSalesConfirmation(text),false,clause);
 }
 const notQuote='Do not reserve, book or create a payment order yet.';
 assert.equal(voiceQuotePolicyText(notQuote),notQuote);
});

test('every voice specialty limits missing discovery to two or three questions and one for complex needs',()=>{
 for(const service of ['grooming','dog_training','boarding','pet_sitting','pet_taxi','all_services']){
  const prompt=specialistSalesPrompt(service);
  assert.match(prompt,/at most two or three closely related missing discovery questions/i,service);
  assert.match(prompt,/ask only one question.*complex|complex.*ask only one question/i,service);
  assert.doesNotMatch(prompt,/3 or 4|three or four/i,service);
  assert.match(prompt,/do not ask for that same field again/i,service);
 }
});
test('the assembled agent profile carries the same discovery limit without changing delivery settings',()=>{
 const prompt=humanCallPrompt('Keep the existing approved agent instructions.');
 assert.match(prompt,/Keep the existing approved agent instructions/);
 assert.match(prompt,/at most two or three closely related missing discovery questions/i);
 assert.match(prompt,/complex care needs.*ask only one question/i);
 assert.doesNotMatch(prompt,/3 or 4|three or four/i);
});
test('the sales sequence explains fit, benefits, approved price and objections before separate consent',()=>{
 const prompt=specialistSalesPrompt('grooming');
 assert.match(prompt,/connect its benefits to the customer's stated need/i);
 assert.match(prompt,/approved price and inclusions/i);
 assert.match(prompt,/answer.*price objection.*before asking for booking consent/i);
 assert.match(prompt,/Do not dump the complete package list/);
 assert.match(prompt,/Recommend a suitable option, not automatically the most expensive/);
 assert.match(prompt,/require a separate explicit customer confirmation/);
 assert.match(prompt,/Stop selling when asked/);
});
test('stay discovery defers the care checklist and retains its app-only authority',()=>{
 for(const service of ['boarding','pet_sitting','all_services']){
  const prompt=specialistSalesPrompt(service);
  assert.match(prompt,/Defer the detailed care checklist/i,service);
  assert.match(prompt,/do not repeat a duration or care need the caller already supplied/i,service);
  assert.match(prompt,/final booking.*PawSpace app|final booking.*in the PawSpace app/i,service);
 }
 assert.match(specialistSalesPrompt('all_services'),/cannot execute a stay reservation, booking or payment, even after yes/);
 assert.match(specialistSalesPrompt('boarding'),/missing provider rate.*never a catalogue fallback/i);
});
test('training value and provider credibility remain grounded without outcome guarantees',()=>{
 const prompt=specialistSalesPrompt('dog_training');
 assert.match(prompt,/doorstep Training benefits.*home environment/i);
 assert.match(prompt,/experience, credentials, reviews or results only when current approved knowledge or canonical provider evidence supports/i);
 assert.match(prompt,/Never invent credentials, review counts, testimonials or success rates/i);
 assert.match(prompt,/Never guarantee behavior outcomes/);
 assert.match(prompt,/higher package only when its approved additional inclusions provide clear value/i);
});
test('species and skin concerns cannot become invented treatment or unsupported fulfillment',()=>{
 for(const service of ['grooming','dog_training','boarding','pet_sitting','pet_taxi','all_services']){
  const prompt=specialistSalesPrompt(service);
  assert.match(prompt,/fulfillment is for dogs and cats only/i,service);
  assert.match(prompt,/another species.*never a PawSpace booking proposal/i,service);
  assert.match(prompt,/rash or skin problem is a medical concern/i,service);
  assert.match(prompt,/tick bath only when current approved catalogue, species-specific suitability and safety guidance support it/i,service);
  assert.match(prompt,/Do not diagnose, prescribe medication or give a dose/i,service);
 }
});
test('the canonical runtime sends the new sales policy with the same-thread facts and creates no booking',async t=>{
 const w=await setupJourney();t.after(()=>w.close());
 const account=await import('../lib/customer-account.ts');
 const orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
 const rollout=await import('../lib/ai-audience-rollout.ts');
 await account.ensureCustomerAccountTables(w.db);await(await import('../lib/canonical-booking-core-schema.ts')).ensureCanonicalBookingCoreTables(w.db);await orchestrator.ensureAiConversationOrchestrator(w.db);
 await(await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(w.db);
 for(const path of ['training-commercial-governance','boarding-governance','sitting-governance','walking-governance','taxi-governance'])applyOwnedDdl(w.sqlite,`lib/${path}.ts`);
 const now=Date.now(),customerId='CUS-CONVERSATION-POLICY',threadId='THREAD-CONVERSATION-POLICY';
 w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic tester','9876500088','test','{}',?,?)").run(customerId,now,now);
 await seedOwnedPet(w.db,customerId,'PET-CONVERSATION-POLICY','Milo');
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 const actor={email:'elevenlabs-voice@system.pawspace',name:'Voice policy test',roleCode:'service_elevenlabs_voice',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:elevenlabs-voice'};
 await rollout.setAiRolloutStage(w.db,{stage:'staff_only',reason:'Synthetic conversation policy regression',actorEmail:actor.email});
 const turn=async(text,key,provider)=>{
  const messageId=`MSG-${key}`;
  w.sqlite.prepare("INSERT INTO communication_messages(id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'elevenlabs','voice','inbound','lifecycle','voice_sales',?,'received',?,'voice-test',?,?)").run(messageId,threadId,customerId,JSON.stringify({text}),key,now,now);
  return orchestrator.orchestrateAiTurn(w.db,{actor,threadId,customerId,inputMessageId:messageId,idempotencyKey:key,channel:'voice',provider});
 };
 await turn('Milo needs boarding for two nights.','known-stay-facts',{salesService:'boarding',status:'connected',provider:'test',modelRef:'test',async generate(){return{text:'Which dates do you need?',provider:'test',modelRef:'test',latencyMs:1};}});
 const oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;});
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'synthetic-not-real'};
 let requestBody,requests=0;
 globalThis.fetch=async(url,init)=>{requests++;assert.equal(String(url),'https://api.openai.com/v1/responses');requestBody=JSON.parse(init.body);return Response.json({status:'completed',output_text:'Which dates would you like for Milo’s two-night stay?',usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'boarding'});
 const result=await turn('What do you need from me next?','next-stay-fact',provider);
 assert.notEqual(result.turn.outcome,'handoff');assert.equal(requests,1);
 assert.match(requestBody.instructions,/at most two or three closely related missing discovery questions/i);
 assert.match(requestBody.instructions,/Defer the detailed care checklist/i);
 assert.doesNotMatch(requestBody.instructions,/3 or 4|three or four/i);
 const sent=JSON.parse(requestBody.input);
 assert.ok(sent.canonicalContext.conversationHistory.some(row=>row.content==='Milo needs boarding for two nights.'));
 assert.equal(sent.canonicalContext.salesService,'boarding');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,0);
});
