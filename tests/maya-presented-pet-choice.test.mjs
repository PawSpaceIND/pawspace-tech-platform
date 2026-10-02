import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {seedOwnedPet} from './helpers/saved-pet-fixture.mjs';
import {applyOwnedDdl} from './helpers/ai-harness.mjs';
import {presentedOwnedPetChoice,proposalMatchesSelectedPet} from '../lib/voice-presented-pet-choice.ts';
const pets=[{id:'PET-BEAGLE',name:'Maya',breed:'Beagle'},{id:'PET-LAB',name:'Maya',breed:'Labrador'}];
const list={role:'assistant',content:'First: your pet Maya, Labrador; second: your pet Maya, Beagle. Which one?'};
test('ordinal choice comes only from explicit owned options, with corrections and ambiguity preserved',()=>{
 assert.equal(presentedOwnedPetChoice([list],'First one.',pets).selectedPet.id,'PET-LAB');
 assert.equal(presentedOwnedPetChoice([list],'First one, first one.',pets).selectedPet.id,'PET-LAB');
 assert.equal(presentedOwnedPetChoice([list,{role:'user',content:'First one.'}],'No, second one.',pets).selectedPet.id,'PET-BEAGLE');
 assert.equal(presentedOwnedPetChoice([list,{role:'user',content:'First one.'}],'Prepare a quote for Maya.',pets).selectedPet.id,'PET-LAB');
 for(const history of [[],[{role:'assistant',content:'There are two saved pets called Maya.'}],[{role:'assistant',content:'First: Maya; second: Maya.'}],[{role:'assistant',content:'First: unowned Rover; second: Maya, Beagle.'}]]){
  const choice=presentedOwnedPetChoice(history,'First Maya.',pets);assert.equal(choice.selectedPet,null);assert.match(choice.clarification,/clear saved-pet list/);
 }
 assert.equal(presentedOwnedPetChoice([list,{role:'user',content:'First one.'}],'Both pets.',pets).selectedPet,null);
 assert.equal(presentedOwnedPetChoice([list,{role:'user',content:'First one.'}],'Actually the Beagle.',pets).selectedPet,null);
 assert.equal(presentedOwnedPetChoice([list],'First one.',[{id:'OTHER',name:'Other',breed:'Other'}]).selectedPet,null);
 const packageChoice=presentedOwnedPetChoice([{role:'assistant',content:'First: basic grooming; second: premium grooming. Which package?'}],'First one.',pets);
 assert.equal(packageChoice.selectedPet,null);assert.equal(packageChoice.clarification,null,'package options cannot trigger pet clarification');
 assert.equal(packageChoice.proposalClarification,null);
 const timeChoice=presentedOwnedPetChoice([list,{role:'user',content:'First one.'},{role:'assistant',content:'First: 10 AM; second: 2 PM. Which time?'}],'Second one.',pets);
 assert.equal(timeChoice.selectedPet.id,'PET-LAB','a time ordinal cannot change the established pet');
 const movedChoice=presentedOwnedPetChoice([list,{role:'user',content:'First one.'},{role:'assistant',content:'Which appointment time do you prefer, 10 AM or 2 PM?'}],'No, second one.',pets);
 assert.equal(movedChoice.selectedPet.id,'PET-LAB','a time correction cannot change the pet');
 for(const question of ['Which appointment time do you prefer for Maya, 10 AM or 2 PM?','For your pet Maya, first: 10 AM; second: 2 PM. Which time do you prefer?']){
  const choice=presentedOwnedPetChoice([list,{role:'user',content:'First one.'},{role:'assistant',content:question}],'No, second one.',pets);
  assert.equal(choice.selectedPet.id,'PET-LAB',question);assert.equal(choice.clarification,null);
 }
 const conflicting=presentedOwnedPetChoice([list,{role:'user',content:'First one.'}],'No, first one, second one.',pets);
 assert.equal(conflicting.selectedPet.id,'PET-LAB','conflicting alternatives do not replace the established preference');
 assert.match(conflicting.clarification,/Which pet/);assert.match(conflicting.proposalClarification,/Which pet/);
 const rejected=presentedOwnedPetChoice([list,{role:'user',content:'First one.'},{role:'user',content:'Not the first one.'}],'Prepare a quote.',pets);
 assert.equal(rejected.selectedPet,null);assert.match(rejected.clarification,/Which pet/);
 assert.equal(presentedOwnedPetChoice([list,{role:'user',content:'First one.'}],'Not the second one.',pets).selectedPet.id,'PET-LAB');
 assert.equal(proposalMatchesSelectedPet([{toolCode:'schedule.reserve',arguments:{petIds:['PET-BEAGLE']}},{toolCode:'booking.create',arguments:{petIds:['PET-LAB']}}],pets[1]),false);
});

test('managed sales provider binds explicit ordinal preference and rejects a different owned pet proposal',async t=>{
 const w=await setupJourney();t.after(()=>w.close());
 const account=await import('../lib/customer-account.ts'),orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
 await account.ensureCustomerAccountTables(w.db);await orchestrator.ensureAiConversationOrchestrator(w.db);await(await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(w.db);
 for(const owner of ['training-commercial-governance','boarding-governance','sitting-governance','walking-governance','taxi-governance'])applyOwnedDdl(w.sqlite,`lib/${owner}.ts`);
 const now=Date.now(),customerId='CUS-ORDINAL',threadId='THREAD-ORDINAL';
 w.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic tester','9876500090','test','{}',?,?)").run(customerId,now,now);
 w.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 for(const pet of pets){await seedOwnedPet(w.db,customerId,pet.id,pet.name);w.sqlite.prepare('UPDATE canonical_pets SET breed=? WHERE id=?').run(pet.breed,pet.id);}
 const actor={email:'elevenlabs-voice@system.pawspace',name:'Ordinal test',roleCode:'service_elevenlabs_voice',permissions:['communications.manage','customers.manage','bookings.manage','scheduling.book'],developmentPreview:false,identitySource:'workspace',principalType:'identity_subject',principalKey:'service:elevenlabs-voice'};
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'synthetic-not-real'};
 const previousFetch=globalThis.fetch;t.after(()=>globalThis.fetch=previousFetch);let sent,calls=0;
 const actions=[{toolCode:'schedule.reserve',arguments:{serviceCode:'grooming',petIds:['PET-BEAGLE']}},{toolCode:'booking.create',arguments:{petIds:['PET-BEAGLE']}},{toolCode:'checkout.payment_order.create',arguments:{}}];
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');calls++;sent=JSON.parse(init.body);return Response.json({status:'completed',output_text:JSON.stringify({reply:'Your pet quote is ready.',actions}),usage:{total_tokens:20}});};
 const {createGroundedAiRuntimeProvider}=await import('../lib/ai-grounded-runtime-provider.ts');
 const provider=await createGroundedAiRuntimeProvider(w.db,actor,'voice',{salesService:'all_services'});
 const history=[list,{role:'user',content:'First one.'}];
 const result=await provider.generate({threadId,customerId,channel:'voice',inputText:'Prepare a quote for grooming.',intent:orchestrator.classifyAiIntent('Prepare a quote for grooming.'),context:{pets,conversationHistory:history}});
 assert.equal(result.actionRequests?.length??0,0,'the other owned pet cannot reach quote preparation');
 assert.equal(JSON.parse(sent.input).canonicalContext.voicePetSelection.canonicalPetIndex,1);
 assert.match(result.text,/Maya.*Labrador/);
 const corrected=await provider.generate({threadId,customerId,channel:'voice',inputText:'No, second one.',intent:orchestrator.classifyAiIntent('No, second one.'),context:{pets,conversationHistory:history}});
 assert.equal(JSON.parse(sent.input).canonicalContext.voicePetSelection.canonicalPetIndex,0);assert.equal(corrected.actionRequests.length,3,'corrected preference may produce an unconfirmed proposal, never a booking');
 globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic ordinal replay',actorEmail:actor.email});
 const {runElevenLabsGroundedTurn}=await import('../lib/elevenlabs-custom-llm.ts');
 const extra={pawspace_customer_id:customerId,pawspace_thread_id:threadId};
 const replay=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[...history,{role:'user',content:'Prepare a quote for grooming.'}],elevenlabs_extra_body:extra});
 assert.match(replay.output,/Maya.*Labrador.*haven't prepared an offer/);
 const before=calls;
 const ambiguous=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[{role:'assistant',content:'First: Maya; second: Maya.'},{role:'user',content:'First one.'}],elevenlabs_extra_body:extra});
 assert.match(ambiguous.output,/clear saved-pet list.*first:.*Maya.*Beagle.*second:.*Maya.*Labrador/i);assert.equal(calls,before,'ambiguity is clarified by the server without model selection');
 const rejected=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[...history,{role:'user',content:'Not the first one.'},{role:'user',content:'Prepare a quote for grooming.'}],elevenlabs_extra_body:extra});
 assert.match(rejected.output,/clear saved-pet list/);assert.equal(calls,before,'a rejected pet cannot become a model offer');
 const undecided=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[list,{role:'user',content:'Prepare a quote for grooming.'}],elevenlabs_extra_body:extra});
 assert.match(undecided.output,/clear saved-pet list/,'a model cannot choose one option while the caller has not selected a pet');
 const timeCorrection=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[...history,{role:'assistant',content:'Which appointment time do you prefer, 10 AM or 2 PM?'},{role:'user',content:'No, second one.'},{role:'user',content:'Prepare a quote for grooming.'}],elevenlabs_extra_body:extra});
 assert.match(timeCorrection.output,/Maya.*Labrador.*haven't prepared an offer/,'the wrong-pet proposal is rejected after a time correction');
 const beforeConflict=calls;
 const conflict=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[...history,{role:'user',content:'No, first one, second one.'},{role:'user',content:'Prepare a quote for grooming.'}],elevenlabs_extra_body:extra});
 assert.match(conflict.output,/clear saved-pet list/);assert.equal(calls,beforeConflict,'conflicting pet choices are clarified before model selection');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM voice_sales_offers WHERE customer_id=?').get(customerId).n,0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0);
});
