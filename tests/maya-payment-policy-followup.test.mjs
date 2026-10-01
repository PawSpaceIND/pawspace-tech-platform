import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks} from './helpers/ai-harness.mjs';
installAiHooks();
const gateway=await import('../lib/elevenlabs-custom-llm.ts');
test('payment information reaches managed model without financial actions or old-offer confirmation',async t=>{
 const {setupJourney}=await import('./helpers/grooming-journey-harness.mjs');
 const ctx=await setupJourney();t.after(()=>ctx.close());
 globalThis.__AI_DB__=ctx.db;globalThis.__PAWSPACE_TEST_ENV__=globalThis.__GROOM_GOLDEN_ENV__;
 const account=await import('../lib/customer-account.ts'),rollout=await import('../lib/ai-audience-rollout.ts'),orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
 await account.ensureCustomerAccountTables(ctx.db);await (await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(ctx.db);await orchestrator.ensureAiConversationOrchestrator(ctx.db);
 const {applyOwnedDdl}=await import('./helpers/ai-harness.mjs');for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(ctx.sqlite,owner);
 const now=Date.now(),customerId='CUS-REPLAY',threadId='THREAD-REPLAY';
 ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,'{}',?,?)").run(customerId,'blr','Replay Tester','9876500043','customer_app',now,now);
 await rollout.setAiRolloutStage(ctx.db,{stage:'customers',reason:'mocked replay',actorEmail:'test@pawspace.test'});
 ctx.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId,customerId,now,now);
 globalThis.__PAWSPACE_TEST_ENV__={...globalThis.__GROOM_GOLDEN_ENV__,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'test-only'};
 globalThis.__GROOM_GOLDEN_ENV__=globalThis.__PAWSPACE_TEST_ENV__;
 await (await import('../lib/voice-sales-specialists.ts')).ensureVoiceSalesOffers(ctx.db);
 ctx.sqlite.prepare("INSERT INTO voice_sales_offers (id,turn_key,thread_id,customer_id,service_code,status,quote_json,actions_json,summary,expires_at,created_at) VALUES ('OLD-OFFER','OLD-TURN',?,?,'boarding','pending','{}','[]','Old unrelated offer',?,?)").run(threadId,customerId,now+60000,now);
 const oldFetch=globalThis.fetch;t.after(()=>globalThis.fetch=oldFetch);let calls=0;const requests=[];
 globalThis.fetch=async(url,init)=>{
  assert.match(String(url),/^https:\/\/api\.openai\.com\//,'no carrier or message sends');calls++;
  const req=JSON.parse(init.body);requests.push(req);
  const reply='Full upfront payment applies; split eligibility depends on the stay. What stay duration do you need?';
  const output=calls===2?JSON.stringify({reply,actions:[{toolCode:'schedule.reserve',arguments:{}},{toolCode:'booking.create',arguments:{}},{toolCode:'checkout.payment_order.create',arguments:{}}]}):reply;
  return Response.json({output_text:output,status:'completed',usage:{total_tokens:40}});
 };
 const extra={pawspace_customer_id:customerId,pawspace_thread_id:threadId};
 for(const question of ['What payment options are available?','Can I make a 50% payment?','Can you give me a quote with split payment?']){
  const before=calls;
  const result=await gateway.runElevenLabsGroundedTurn(ctx.db,{model:'pawspace-service-sales',input:[{role:'user',content:question}],elevenlabs_extra_body:extra});
  assert.equal(ctx.sqlite.prepare("SELECT status FROM voice_sales_offers WHERE id='OLD-OFFER'").get().status,'pending');assert.equal(calls,before+1,question+' must reach model, not risk handoff');
  assert.doesNotMatch(result.output,/routing this conversation|cannot continue/);
  if(calls===2)assert.match(result.output,/information-only question/);
 }
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0);
 for(const table of ['booking_payments','payment_intents','communication_outbox']){if(ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);}
 const beforeQuote=calls;await gateway.runElevenLabsGroundedTurn(ctx.db,{model:'pawspace-service-sales',input:[{role:'user',content:'Prepare a quote for boarding with split payment.'}],elevenlabs_extra_body:extra});assert.ok(calls>beforeQuote);assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n,0);
 ctx.sqlite.prepare("UPDATE communication_threads SET assigned_to='staff' WHERE id=?").run(threadId);const before=calls;
 const paused=await gateway.runElevenLabsGroundedTurn(ctx.db,{model:'pawspace-service-sales',input:[{role:'user',content:'What payment options are available?'}],elevenlabs_extra_body:extra});assert.equal(paused.path,'human_handoff');assert.equal(calls,before);
});
test('read-only payment questions and quote qualifiers do not exempt financial execution or disputes',async()=>{
 const {classifyAiIntent}=await import('../lib/ai-conversation-orchestrator.ts');
 const {policyEnquiryTopic}=await import('../lib/ai-policy-enquiry.ts');
 for(const question of ['What payment options are available?','Can I make a 50% payment?','Can you give me a quote with split payment?','Prepare a quote for boarding with split payment.'])assert.equal(classifyAiIntent(question).policyRisk,false,question);
 for(const command of ['What payment options are available? Also capture my payment.','Can I make a 50% payment and transfer the rest now?','Prepare a quote for boarding with split payment and capture the payment.','Prepare a quote for boarding with split payment and issue a refund.','My payment was charged twice.','I want a human.','Charge my card now.','Capture my payment.','Transfer my payment.','Issue my refund.','Send a payout.']){assert.equal(policyEnquiryTopic(command),null,command);if(command.includes('payment')||command.includes('refund'))assert.equal(classifyAiIntent(command).policyRisk,true,command);}
});
