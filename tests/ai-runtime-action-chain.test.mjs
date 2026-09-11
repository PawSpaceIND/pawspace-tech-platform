import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney } from "./helpers/grooming-journey-harness.mjs";
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
});

test("customer confirmation detector is explicit and negative-safe",()=>{
 assert.equal(orchestrator.isExplicitCustomerActionConfirmation("Yes, go ahead and book this"),true);
 assert.equal(orchestrator.isExplicitCustomerActionConfirmation("I need grooming"),false);
 assert.equal(orchestrator.isExplicitCustomerActionConfirmation("No, do not book it"),false);
});

test("WhatsApp-governed AI action plan executes reserve -> booking -> Razorpay order with no Ops case",async t=>{
 const ctx=await setupJourney();t.after(()=>ctx.close());
 await account.ensureCustomerAccountTables(ctx.db);
 const now=Date.now(),customerId="CUS-AI-CHAIN",petId="PET-AI-CHAIN";
 ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,'{\"whatsapp\":true}',?,?)").run(customerId,"blr","Asha","9876500042","customer_app",now,now);
 await seedOwnedPet(ctx.db,customerId,petId,"Milo");
 await rollout.setAiRolloutStage(ctx.db,{stage:"customers",reason:"AI action chain executable proof",actorEmail:"founder@pawspace.test"});
 await orchestrator.ensureAiConversationOrchestrator(ctx.db);
 const threadId="THREAD-AI-CHAIN",messageId="MSG-AI-CHAIN";
 ctx.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 ctx.sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'meta_whatsapp','whatsapp','inbound','lifecycle','meta_inbound',?,'received',?,'meta-whatsapp-webhook@system.pawspace',?,?)").run(messageId,threadId,customerId,JSON.stringify({text:"Yes, go ahead and make a booking for grooming"}),"ai-chain-inbound",now,now);
 globalThis.__GROOM_GOLDEN_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_ai_chain",RAZORPAY_KEY_SECRET_SANDBOX:"secret_ai_chain"};
 const priorFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=priorFetch;});
 globalThis.fetch=async(url,init)=>{
  assert.match(String(url),/api\.razorpay\.com\/v1\/orders/);
  const body=JSON.parse(String(init?.body||"{}"));
  return Response.json({id:"order_AI_CHAIN",entity:"order",amount:body.amount,amount_paid:0,amount_due:body.amount,currency:body.currency,receipt:body.receipt,status:"created"});
 };
 const provider={status:"connected",provider:"scripted-grounded-proof",modelRef:"proof-model",async generate(){return{text:"Ready",provider:"scripted-grounded-proof",modelRef:"proof-model",latencyMs:1,referencedCustomerIds:[customerId],groundingRefs:[],highImpactAction:false,actionRequests:[
  {toolCode:"schedule.reserve",arguments:{serviceCode:"grooming",petIds:[petId],serviceAddress:"12 Test Street",servicePincode:"560038",scheduledStart:"2026-10-20T04:30:00.000Z",scheduledEnd:"2026-10-20T06:30:00.000Z"}},
  {toolCode:"booking.create",arguments:{petIds:[petId],packageCode:"dog-basic",paymentMode:"prepaid"}},
  {toolCode:"checkout.payment_order.create",arguments:{}}
 ]};}};
 const result=await orchestrator.orchestrateAiTurn(ctx.db,{actor:serviceActor,threadId,customerId,inputMessageId:messageId,idempotencyKey:"ai-chain-turn",channel:"whatsapp",provider});
 assert.equal(result.turn.outcome,"reply_ready");
 assert.equal(result.turn.policyDecision,"customer_confirmed_action_executed");
 assert.match(result.turn.output,/Razorpay checkout is ready/);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(customerId).n,1);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM payment_intents WHERE customer_id=?").get(customerId).n,1);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM ai_tool_execution_requests WHERE customer_id=? AND status='completed'").get(customerId).n,3);
 const ucc=ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unified_cases'").get();if(ucc)assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM unified_cases WHERE customer_id=?").get(customerId).n,0);
 const tasks=ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_tasks'").get();if(tasks)assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM crm_tasks").get().n,0);
 const payment=ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE customer_id=?").get(customerId);assert.notEqual(payment.status,"captured");
});
