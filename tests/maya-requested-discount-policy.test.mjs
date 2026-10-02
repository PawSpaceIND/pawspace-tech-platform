import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {applyOwnedDdl} from './helpers/ai-harness.mjs';

test('price hesitation alone cannot grant a model coupon proposal',async t=>{
 const w=await setupJourney();t.after(()=>w.close());
 const account=await import('../lib/customer-account.ts'),orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
 await account.ensureCustomerAccountTables(w.db);await orchestrator.ensureAiConversationOrchestrator(w.db);await(await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(w.db);
 for(const owner of ['training-commercial-governance','boarding-governance','sitting-governance','walking-governance','taxi-governance'])applyOwnedDdl(w.sqlite,`lib/${owner}.ts`);
 const now=Date.now(),customerId='CUS-REQUEST-DISCOUNT',threadId='THREAD-REQUEST-DISCOUNT';
 w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic tester','9876500091','test','{}',?,?)").run(customerId,now,now);
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 const actor={email:'elevenlabs-voice@system.pawspace',name:'Discount test',roleCode:'service_elevenlabs_voice',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:elevenlabs-voice'};
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'synthetic-not-real'};
 const previousFetch=globalThis.fetch;t.after(()=>globalThis.fetch=previousFetch);let sent,overrideOutput=null;
 const actions=[{toolCode:'schedule.reserve',arguments:{serviceCode:'grooming',petIds:['SYNTHETIC-PET']}},{toolCode:'booking.create',arguments:{petIds:['SYNTHETIC-PET'],couponCode:'GROOM200'}},{toolCode:'checkout.payment_order.create',arguments:{}}];
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');sent=JSON.parse(init.body);return Response.json({status:'completed',output_text:overrideOutput??JSON.stringify({reply:'Let me prepare the package details.',actions}),usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'grooming'});
 globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic requested discount replay',actorEmail:actor.email});
 await(await import('../lib/voice-sales-specialists.ts')).ensureVoiceSalesOffers(w.db);
 const runDeniedReplay=async statement=>(await import('../lib/elevenlabs-custom-llm.ts')).runElevenLabsGroundedTurn(w.db,{model:'pawspace-grooming-sales',input:[{role:'user',content:'Any approved discount for grooming?'},{role:'assistant',content:'I can check eligible offers.'},{role:'user',content:statement}],elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}});
 const message='The price is too high for my budget.';
 const result=await provider.generate({threadId,customerId,channel:'voice',inputText:message,intent:orchestrator.classifyAiIntent(message),context:{}});
 assert.equal(result.actionRequests?.length??0,0,'unrequested coupon must not reach quote preparation');
 assert.deepEqual(JSON.parse(sent.input).canonicalContext.approvedOffers,[],'price hesitation does not expose a discount menu');
 assert.match(result.text,/regular.*price.*inclusions/i);
 const {customerRequestedVoiceDiscount}=await import('../lib/voice-requested-discount-policy.ts');
 for(const request of ['Any approved discount?','Do you have a discount?','Could you apply the approved coupon?','Please give me an eligible discount.','Can you lower the price?','The Complete Makeover price feels high. Is there an approved offer for that package?'])assert.equal(customerRequestedVoiceDiscount([],request),true,request);
 for(const statement of ['My budget is low.','A competitor is cheaper.','The competitor has an available discount.','The discount is good.','No discounts please.','I do not want a coupon.','Can you recommend a cheaper package?'])assert.equal(customerRequestedVoiceDiscount([],statement),false,statement);
 assert.equal(customerRequestedVoiceDiscount([{role:'assistant',content:'Would you like an approved coupon?'}],'Yes.'),false,'an unsolicited assistant offer cannot grant discount permission');
 assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount?'}],'No discounts please.'),false);
 assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount?'}],'Please prepare a quote for the same package.'),true);
 for(const statement of ['Can you prepare grooming without applying a discount?','Please prepare grooming without using the approved coupon.','Prepare a regular quote.'])assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount for grooming?'}],statement),false,statement);
 assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount for grooming?'}],'Actually switch to boarding. Prepare a regular quote.'),false);
 assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount for grooming?'}],'What about boarding?'),false);
 assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount?'}],'Actually switch to boarding.'),false,'an unspecified old request cannot authorize a newly selected service');
 assert.equal(customerRequestedVoiceDiscount([],'Any approved discount for grooming? Actually switch to boarding. Prepare a regular quote.'),false);
 assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount for grooming?'}],'Prepare a new quote for a different package.'),false);
 assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount for grooming?'}],'Actually switch to boarding. Any approved discount for boarding?'),true,'a new explicit request grants only fresh permission');
 for(const statement of ['Can you prepare grooming without applying a discount?','Actually switch to boarding. Prepare a regular quote.']){
  const denied=await provider.generate({threadId,customerId,channel:'voice',inputText:statement,intent:orchestrator.classifyAiIntent(statement),context:{conversationHistory:[{role:'user',content:'Any approved discount for grooming?'}]}});
  assert.equal(denied.actionRequests?.length??0,0,statement);
  await runDeniedReplay(statement);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers WHERE customer_id=?').get(customerId).n,0,statement);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0,statement);
 }
 for(const decline of ['Can you prepare grooming without a promotional discount?','Can you prepare grooming without using a promotional discount?','Please prepare grooming without any currently eligible coupon.','Can you prepare grooming without a special seasonal promotional exclusive eligible available discount?','Please prepare grooming excluding a promotional discount.',"I do not want a seasonal promotional discount."]){
  assert.equal(customerRequestedVoiceDiscount([],decline),false,decline);
  assert.equal(customerRequestedVoiceDiscount([{role:'user',content:'Any approved discount for grooming?'}],decline),false,decline);
 }
 assert.equal(customerRequestedVoiceDiscount([],'Can you prepare grooming without changing the package and apply the approved coupon?'),true,'negation of an unrelated change cannot erase an explicit coupon request');
 const request='Could you apply the approved coupon?';
 const requested=await provider.generate({threadId,customerId,channel:'voice',inputText:request,intent:orchestrator.classifyAiIntent(request),context:{}});
 assert.equal(requested.actionRequests.length,3,'an explicitly requested eligible coupon still follows unconfirmed quote preparation');
 assert.ok(JSON.parse(sent.input).canonicalContext.approvedOffers.some(offer=>offer.code==='GROOM200'));
 actions[1].arguments.couponCode='FAKE999';
 const ineligible=await provider.generate({threadId,customerId,channel:'voice',inputText:request,intent:orchestrator.classifyAiIntent(request),context:{}});
 assert.equal(ineligible.actionRequests.length,0);assert.match(ineligible.text,/can't verify that proposed discount/);
 actions[1].arguments.couponCode='GROOM200';
 globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic requested discount replay',actorEmail:actor.email});
 const {runElevenLabsGroundedTurn}=await import('../lib/elevenlabs-custom-llm.ts');
 const replay=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-grooming-sales',input:[{role:'user',content:message}],elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}});
 assert.match(replay.output,/regular.*price.*inclusions/i);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers WHERE customer_id=?').get(customerId).n,0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0);
 overrideOutput=JSON.stringify({reply:'I can offer a 99% discount on Complete Makeover.',actions:[]});
 const percentageRequest='Do you have a discount?';
 const unverified=await provider.generate({threadId,customerId,channel:'voice',inputText:percentageRequest,intent:orchestrator.classifyAiIntent(percentageRequest),context:{}});
 assert.doesNotMatch(unverified.text,/99%/,'requesting a discount cannot approve an invented percentage');
});

test('percentage statements need their named package and exact canonical saving',async()=>{
 const {voicePercentageDiscountsApproved}=await import('../lib/voice-requested-discount-policy.ts');
 const approved=[{package_name:'Fixture Grooming (dog, 1 pet)',regular_price:1000,discount_amount:200}];
 assert.equal(voicePercentageDiscountsApproved('Fixture Grooming has a 20% discount.',approved),true);
 assert.equal(voicePercentageDiscountsApproved('Fixture Grooming has a 99% discount.',approved),false);
 assert.equal(voicePercentageDiscountsApproved('A different package has a 20% discount.',approved),false);
 assert.equal(voicePercentageDiscountsApproved('There is a 20% discount.',approved),false);
 assert.equal(voicePercentageDiscountsApproved('I cannot offer a 99% discount.',approved),true,'a refusal is not an offer');
 assert.equal(voicePercentageDiscountsApproved('Fixture Grooming has a 20% discount.',[]),false);
});
