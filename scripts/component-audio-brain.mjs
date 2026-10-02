/** Real reviewed application modules with synthetic local state, never production customer data. */
export async function createComponentBrain(env){
 const {setupJourney}=await import('../tests/helpers/grooming-journey-harness.mjs');
 const world=await setupJourney();
 try{
  const {applyOwnedDdl}=await import('../tests/helpers/ai-harness.mjs');
  for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(world.sqlite,owner);
  await(await import('../lib/customer-account.ts')).ensureCustomerAccountTables(world.db);
  await(await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(world.db);
  await(await import('../lib/ai-voice-uat.ts')).ensureAiVoiceUatTables(world.db);
  await(await import('../lib/managed-audio-test-control.ts')).ensureManagedAudioControl(world.db);
  await(await import('../lib/ai-conversation-orchestrator.ts')).ensureAiConversationOrchestrator(world.db);
  await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(world.db,{stage:'customers',actorEmail:'synthetic-component@example.invalid'});
  const controlled={...globalThis.__GROOM_GOLDEN_ENV__,...env,PAWSPACE_MANAGED_AUDIO_ISOLATION:'no-send-v1',PAWSPACE_DEPLOYMENT_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',PAWSPACE_VOICE_UAT_ALLOWLIST:'9999999999',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_AI_VOICE_MODEL:'gpt-5.6-luna',PAWSPACE_AI_MODEL:'gpt-5.6-luna',PAWSPACE_AI_PROVIDER_TIMEOUT_MS:'30000'};
  globalThis.__GROOM_GOLDEN_ENV__=controlled;globalThis.__PAWSPACE_TEST_ENV__=controlled;
  const gateway=await import('../lib/elevenlabs-custom-llm.ts');
  const now=Date.now();
  // The local fixture admission markers below do not reserve provider dollars. Only the remote
  // shared component lease does that. They admit the actual application to synthetic state and
  // retain its six-attempt-per-conversation and business-namespace fences.
  world.sqlite.prepare('UPDATE managed_audio_test_budget SET reserved_micros=5000000').run();
  const created=new Map();
  const models={grooming:'pawspace-grooming-sales',training:'pawspace-training-sales',boarding:'pawspace-boarding-sales',sitting:'pawspace-sitting-sales',taxi:'pawspace-taxi-sales'};
  return {world,async turn(service,input){
   if(!Object.hasOwn(models,service))throw Error('component_unknown_fixed_service');
   if(!created.has(service)){
    const customerId='SYNTHETIC-COMPONENT-'+service,threadId='THREAD-MANAGED-AUDIO-COMPONENT-'+service,callId='AIVCALL-MANAGED-AUDIO-COMPONENT-'+service;
    world.sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic audio fixture','9999999999','synthetic_component_test','{}',?,?)").run(customerId,now,now);
    for(const [id,name] of [['MILO','Milo'],['LUNA','Luna']])await(await import('../tests/helpers/saved-pet-fixture.mjs')).seedOwnedPet(world.db,customerId,'PET-COMPONENT-'+service+'-'+id,name);
    world.sqlite.prepare("INSERT INTO communication_threads(id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
    world.sqlite.prepare("INSERT INTO ai_voice_calls(id,thread_id,customer_id,transport_provider,direction,status,consent_status,started_at,created_by) VALUES (?,?,?,'sandbox_simulator','inbound','active','verified',?,'synthetic-component@example.invalid')").run(callId,threadId,customerId,now);
    world.sqlite.prepare("INSERT INTO managed_audio_test_conversations(thread_id,call_id,customer_id,budget_id,profile,max_attempts,max_output_tokens,attempts_used,reservation_id,reserved_micros,expires_at,created_at) VALUES (?,?,?,'managed-audio-approved-usd5-20261002','managed-audio-usd5-v1',6,700,0,?,1,?,?)").run(threadId,callId,customerId,'LOCAL-FIXTURE-'+service,now+7200000,now);
    created.set(service,{customerId,threadId,history:[]});
   }
   const ctx=created.get(service);
   const result=await gateway.runElevenLabsGroundedTurn(world.db,{model:models[service],input:[...ctx.history,{role:'user',content:input}],elevenlabs_extra_body:{pawspace_thread_id:ctx.threadId,pawspace_customer_id:ctx.customerId}});
   ctx.history.push({role:'user',content:input},{role:'assistant',content:result.output});
   return result;
  },snapshot(){
   const tables=['communication_messages','ai_conversation_turns','ai_tool_runs','managed_audio_test_conversations','canonical_bookings','ai_handoffs'];
   const rows={};for(const table of tables){const exists=world.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);rows[table]=exists?world.sqlite.prepare('SELECT * FROM '+table).all():[];}
   if((rows.canonical_bookings||[]).some(r=>String(r.customer_id).startsWith('SYNTHETIC-COMPONENT-')))throw Error('component_business_mutation_detected');
   return {syntheticFixtureOnly:true,productionPersistenceVerified:false,rows};
  },close(){world.close();}};
 }catch(e){world.close();throw e;}
}
