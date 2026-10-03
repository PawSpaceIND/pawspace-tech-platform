import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const orchestrator = await import("../lib/ai-conversation-orchestrator.ts");
const rollout = await import("../lib/ai-audience-rollout.ts");
const account = await import("../lib/customer-account.ts");
const grounded = await import("../lib/ai-grounded-runtime-provider.ts");

const serviceActor={email:"meta-whatsapp-ai@system.pawspace",name:"Meta WhatsApp AI service",roleCode:"service_meta_whatsapp_ai",permissions:["communications.manage"],developmentPreview:false,identitySource:"workspace",principalType:"identity_subject",principalKey:"service:meta-whatsapp-ai"};

test("grounded provider accepts only bounded registered action envelopes",()=>{
 const parsed=grounded.parseGroundedActionEnvelope(JSON.stringify({reply:"Ready",actions:[{toolCode:"schedule.reserve",arguments:{serviceCode:"grooming"}},{toolCode:"booking.create",arguments:{packageCode:"dog-basic"}},{toolCode:"checkout.payment_order.create",arguments:{}}]}));
 assert.equal(parsed.actions.length,3);
 assert.equal(grounded.parseGroundedActionEnvelope(JSON.stringify({reply:"x",actions:[{toolCode:"payment.capture",arguments:{}}]})),null);
 assert.equal(grounded.parseGroundedActionEnvelope("not json"),null);
 const fenced=grounded.parseGroundedActionEnvelope("```json\n"+JSON.stringify({reply:"Ready",actions:[{toolCode:"schedule.reserve",arguments:{serviceCode:"grooming",petIds:["PET-1"],serviceAddress:"12 Test Street",servicePincode:"560038",scheduledStart:"2026-09-12T10:00:00+05:30",scheduledEnd:"2026-09-12T12:00:00+05:30"}}]})+"\n```");
 assert.equal(fenced?.actions[0]?.toolCode,"schedule.reserve");
});

test("customer confirmation detector is explicit and negative-safe",()=>{
 assert.equal(orchestrator.isExplicitCustomerActionConfirmation("Yes, go ahead and book this"),true);
 assert.equal(orchestrator.isExplicitCustomerActionConfirmation("I need grooming"),false);
 assert.equal(orchestrator.isExplicitCustomerActionConfirmation("No, do not book it"),false);
});

test("Voice short confirmation action plan executes reserve -> booking -> Razorpay order with no Ops case",async t=>{
 const ctx=await setupJourney();t.after(()=>ctx.close());
 await account.ensureCustomerAccountTables(ctx.db);
 await (await import("../lib/pricing-control-runtime.ts")).ensurePricingControlRuntime(ctx.db);
 const now=Date.now(),customerId="CUS-AI-CHAIN",petId="PET-AI-CHAIN";
 ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,'{\"whatsapp\":true}',?,?)").run(customerId,"blr","Asha","9876500042","customer_app",now,now);
 await seedOwnedPet(ctx.db,customerId,petId,"Milo");
 await rollout.setAiRolloutStage(ctx.db,{stage:"customers",reason:"AI action chain executable proof",actorEmail:"founder@pawspace.test"});
 await orchestrator.ensureAiConversationOrchestrator(ctx.db);
 const threadId="THREAD-AI-CHAIN",messageId="MSG-AI-CHAIN";
 ctx.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 ctx.sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'elevenlabs','voice','inbound','lifecycle','meta_inbound',?,'received',?,'meta-whatsapp-webhook@system.pawspace',?,?)").run(messageId,threadId,customerId,JSON.stringify({text:"Yes, go ahead and make a booking for grooming"}),"ai-chain-inbound",now,now);
 const previousDeploymentEnv=globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_DEPLOYMENT_ENV;
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:"staging",PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_ai_chain",RAZORPAY_KEY_SECRET_SANDBOX:"secret_ai_chain"};
 const priorFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=priorFetch;});
 globalThis.fetch=async(url,init)=>{
  assert.match(String(url),/^https:\/\/api\.razorpay\.com\/v1\/orders$/);
  const body=JSON.parse(String(init?.body||"{}"));
  return Response.json({id:"order_AI_CHAIN",entity:"order",amount:body.amount,amount_paid:0,amount_due:body.amount,currency:body.currency,receipt:body.receipt,status:"created"});
 };
 const provider={status:"connected",provider:"scripted-grounded-proof",modelRef:"proof-model",async generate(){return{text:"Ready",provider:"scripted-grounded-proof",modelRef:"proof-model",latencyMs:1,referencedCustomerIds:[customerId],groundingRefs:[],highImpactAction:false,actionRequests:[
  {toolCode:"schedule.reserve",arguments:{serviceCode:"grooming",petIds:[petId],serviceAddress:"12 Test Street",servicePincode:"560038",scheduledStart:"2026-10-20T04:30:00.000Z",scheduledEnd:"2026-10-20T06:30:00.000Z"}},
  {toolCode:"booking.create",arguments:{petIds:[petId],packageCode:"dog-basic",paymentMode:"prepaid"}},
  {toolCode:"checkout.payment_order.create",arguments:{}}
 ]};}};
 const {runElevenLabsGroundedTurn}=await import("../lib/elevenlabs-custom-llm.ts");
 const actions=(await provider.generate()).actionRequests;
 const razorFetch=globalThis.fetch;let modelCalls=0;
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"test-only"};
 globalThis.fetch=async(url,init)=>{
  if(!String(url).includes('api.openai.com'))return razorFetch(url,init);
  modelCalls++;
  const req=JSON.parse(init.body),input=JSON.parse(req.input);
  assert.ok(input.canonicalContext.pets.some(p=>p.id===petId));
  assert.equal(input.intent.intent,'booking_create');
  assert.ok(req.max_output_tokens>=600);
  const envelope=JSON.stringify({reply:"Ready",actions});
  return Response.json({output_text:envelope,status:"completed",usage:{total_tokens:100}});
 };
 const voice=await runElevenLabsGroundedTurn(ctx.db,{input:[{role:'user',content:'I need grooming for Milo'},{role:'assistant',content:'Shall I book this grooming slot and create checkout?'},{role:'user',content:'Yes, proceed'}],elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}},undefined,()=>{});
 assert.equal(modelCalls,1,'action execution must reuse the grounded plan, not ask the model again');
 assert.equal(voice.path,'orchestrator');
 const saved=ctx.sqlite.prepare('SELECT outcome,policy_decision,output_text FROM ai_conversation_turns WHERE id=?').get(voice.turnId);
 const result={turn:{outcome:saved.outcome,policyDecision:saved.policy_decision,output:saved.output_text}};
 assert.equal(result.turn.outcome,"reply_ready");
 assert.equal(result.turn.policyDecision,"customer_confirmed_action_executed");
 assert.match(result.turn.output,/Razorpay checkout is ready/);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(customerId).n,1);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM payment_intents WHERE customer_id=?").get(customerId).n,1);
 const completedTools=ctx.sqlite.prepare("SELECT tool_code FROM ai_tool_execution_requests WHERE customer_id=? AND status='completed' ORDER BY created_at,rowid").all(customerId).map(row=>row.tool_code);
 assert.equal(completedTools.filter(code=>code==='approved_knowledge.read').length,1,'one authorised knowledge read precedes the checkout');
 assert.deepEqual(completedTools.filter(code=>code!=='approved_knowledge.read'),['schedule.reserve','booking.create','checkout.payment_order.create'],'the original three-action checkout is exact; no fourth mutation');
 const ucc=ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unified_cases'").get();if(ucc)assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM unified_cases WHERE customer_id=?").get(customerId).n,0);
 const tasks=ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_tasks'").get();if(tasks)assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM crm_tasks").get().n,0);
 const payment=ctx.sqlite.prepare("SELECT booking_id,amount,currency,status FROM booking_payments WHERE customer_id=?").get(customerId);assert.notEqual(payment.status,"captured");
 const capture={action:"simulate_event",bookingId:payment.booking_id,eventType:"payment.captured",eventId:"evt_voice_sale_proof",gatewayPaymentId:"pay_voice_sale_proof",amount:payment.amount,currency:payment.currency};
 // Restore the pre-existing local payment simulator context after the explicitly UAT voice phase.
 if(previousDeploymentEnv===undefined)delete globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_DEPLOYMENT_ENV;else globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_DEPLOYMENT_ENV=previousDeploymentEnv;
 const captured=await routeCall("../../app/api/grooming-payment-sandbox/route.ts","POST","/api/grooming-payment-sandbox",capture);
 assert.equal(captured.status,201,JSON.stringify(captured.body));
 assert.equal(captured.body.data.synthetic,true);
 const replay=await routeCall("../../app/api/grooming-payment-sandbox/route.ts","POST","/api/grooming-payment-sandbox",capture);
 assert.equal(replay.status,201);
 assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(payment.booking_id).status,"captured");
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(customerId).n,1);

});

for(const profileLinked of [false,true])for(const inputText of ["Yes, book a grooming appointment for Lana.","Book Lana only. Do not book Coco.","Do not substitute Coco; this is only for Lana."]){
test(`wrong saved-cat proposal is refused (${profileLinked?"saved":"unsaved"} Lana): ${inputText}`,async t=>{
 const ctx=await setupJourney();t.after(()=>ctx.close());
 const customerId="CUS-PET-MEMORY",petId="PET-COCO",threadId="THREAD-PET-MEMORY",now=Date.now();
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:"staging",PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"test-only"};
 await account.ensureCustomerAccountTables(ctx.db);
 await (await import("../lib/pricing-control-runtime.ts")).ensurePricingControlRuntime(ctx.db);
 await (await import("../lib/canonical-booking-core-schema.ts")).ensureCanonicalBookingCoreTables(ctx.db);
 ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,'test','{}',?,?)").run(customerId,"blr","Synthetic pet-memory customer","9876500099",now,now);
 await seedOwnedPet(ctx.db,customerId,petId,"Coco");
 ctx.sqlite.prepare("UPDATE canonical_pets SET species='cat' WHERE id=?").run(petId);
 await rollout.setAiRolloutStage(ctx.db,{stage:"customers",reason:"isolated pet-memory regression",actorEmail:"founder@pawspace.test"});
 await orchestrator.ensureAiConversationOrchestrator(ctx.db);
 ctx.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 if(profileLinked){
  await seedOwnedPet(ctx.db,customerId,"PET-LANA","Lana");
  ctx.sqlite.prepare("UPDATE canonical_pets SET species='cat' WHERE id='PET-LANA'").run();
 }
 const before=ctx.sqlite.prepare("SELECT * FROM canonical_pets WHERE customer_id=?").all(customerId);
 const priorFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=priorFetch;});
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:"staging",PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"test-only"};
 let requests=0;
 globalThis.fetch=async(url,init)=>{
  const target=new URL(String(url));
  assert.equal(target.protocol,"https:","model mock only accepts HTTPS");
  assert.equal(target.hostname,"api.openai.com","no external message/payment/booking API");
  requests++;
  const req=JSON.parse(init.body),input=JSON.parse(req.input);
  assert.deepEqual(input.canonicalContext.voicePetMemory.unlinkedNewPetNames,profileLinked?[]:["Lana"]);
  assert.match(req.instructions,/NEW pet|new kitten/);
  return Response.json({output_text:JSON.stringify({reply:"Ready",actions:[
   {toolCode:"schedule.reserve",arguments:{serviceCode:"grooming",petIds:[petId],serviceAddress:"Synthetic address",servicePincode:"560038",scheduledStart:"2026-10-20T04:30:00Z",scheduledEnd:"2026-10-20T06:30:00Z"}},
   {toolCode:"booking.create",arguments:{petIds:[petId],packageCode:"cat-basic",paymentMode:"prepaid"}},
   {toolCode:"checkout.payment_order.create",arguments:{}}
  ]}),status:"completed",usage:{total_tokens:100}});
 };
 const {runElevenLabsGroundedTurn}=await import("../lib/elevenlabs-custom-llm.ts");
 const result=await runElevenLabsGroundedTurn(ctx.db,{input:[{role:"user",content:"Lana is my new five-month-old kitten."},{role:"user",content:`Please book a grooming appointment for Lana. ${inputText}`}],elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}});
 assert.equal(requests,1,"each isolated case reached the model and pet identity guard");
 assert.match(result.output,profileLinked?/Lana has a separate saved profile/:/Lana is a new pet without a saved profile/);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(customerId).n,0);
 assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM canonical_pets WHERE customer_id=?").all(customerId),before);
 const mutations=ctx.sqlite.prepare("SELECT tool_code FROM ai_tool_execution_requests WHERE customer_id=? AND status='completed'").all(customerId).filter(x=>x.tool_code!=="approved_knowledge.read");
 assert.deepEqual(mutations,[]);
});
}

test("staff pause explains the recorded handoff without another handoff or paid model call",async t=>{
 const ctx=await setupJourney();t.after(()=>ctx.close());
 const customerId="CUS-STAFF-PAUSE",threadId="THREAD-STAFF-PAUSE",now=Date.now();
 await account.ensureCustomerAccountTables(ctx.db);await (await import("../lib/canonical-booking-core-schema.ts")).ensureCanonicalBookingCoreTables(ctx.db);await orchestrator.ensureAiConversationOrchestrator(ctx.db);await (await import("../lib/ai-human-handoff.ts")).ensureAiHumanHandoff(ctx.db);await (await import("../lib/customer-360.ts")).ensureCustomer360Tables(ctx.db);
 ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,'test','{}',?,?)").run(customerId,"blr","Synthetic staff test","9876500098",now,now);
 ctx.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','cx-ai-handoff',?,?)").run(threadId,customerId,now,now);
 ctx.sqlite.prepare("INSERT INTO ai_handoffs (id,thread_id,customer_id,reason,queue_code,status,summary_json,requested_by,created_at) VALUES (?,?,?,'refund_review','cx-ai-handoff','queued','{}','test',?)").run("HANDOFF-ONE",threadId,customerId,now);
 const priorFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=priorFetch;});globalThis.fetch=async()=>{throw Error("network forbidden during staff pause");};
 const {runElevenLabsGroundedTurn}=await import("../lib/elevenlabs-custom-llm.ts");
 const outputs=[];
 for(const text of ["Before handing off, what information does the team need for my refund?","Can you book a free visit anyway?","Summarize the status of my refund concern."]){
  outputs.push((await runElevenLabsGroundedTurn(ctx.db,{input:text,elevenlabs_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}})).output);
 }
 assert.match(outputs[0],/booking reference/);assert.match(outputs[1],/can't approve/);assert.match(outputs[2],/queued.*nobody has joined/);
 assert.equal(new Set(outputs).size,3);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs WHERE thread_id=?").get(threadId).n,1);
 assert.equal(ctx.sqlite.prepare("SELECT assigned_to FROM communication_threads WHERE id=?").get(threadId).assigned_to,"cx-ai-handoff");
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(customerId).n,0);
});
