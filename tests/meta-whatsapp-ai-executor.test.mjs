import assert from"node:assert/strict";
import fs from"node:fs";
import test from"node:test";
import{installAiHooks,freshAiDb,seedCustomer,staffActor}from"./helpers/ai-harness.mjs";

installAiHooks();

const executorSource=fs.readFileSync("lib/meta-whatsapp-ai-executor.ts","utf8");
const webhookSource=fs.readFileSync("lib/meta-whatsapp-webhook.ts","utf8");
const executor=await import("../lib/meta-whatsapp-ai-executor.ts");
const uat=await import("../lib/whatsapp-uat-adapter.ts");
const control=await import("../lib/whatsapp-conversation-control.ts");
const rollout=await import("../lib/ai-audience-rollout.ts");

test("internal Meta AI execution is bound to the canonical signed-webhook ledger rather than an HTTP actor",()=>{
 assert.match(executorSource,/FROM whatsapp_uat_events e JOIN communication_messages m/);
 assert.match(executorSource,/e\.provider='meta_whatsapp'/);
 assert.match(executorSource,/e\.event_type='inbound_message'/);
 assert.match(executorSource,/message_provider\)!=="meta_whatsapp"/);
 assert.match(executorSource,/direction\)!=="inbound"/);
 assert.match(executorSource,/thread_customer_id/);
 assert.doesNotMatch(executorSource,/resolveActor\(/);
});

test("service executor remains narrow, audited and customer-rollout gated",()=>{
 assert.match(executorSource,/service_meta_whatsapp_ai/);
 assert.match(executorSource,/permissions:\["communications\.manage"\]/);
 assert.doesNotMatch(executorSource,/permissions:\["\*"\]/);
 assert.match(executorSource,/resolveAiAudienceGate\(db,\{audience:"customer"\}\)/);
 assert.match(executorSource,/securityAudit/);
 assert.match(executorSource,/governed_internal_boundary_rejected/);
});

test("consent, human assignment, human ownership and AI routing are rechecked immediately before execution",()=>{
 assert.match(executorSource,/whatsappConsent/);
 assert.match(executorSource,/opt_out/);
 assert.match(executorSource,/assigned_to/);
 assert.match(executorSource,/human_owned/);
 assert.match(executorSource,/assertWhatsAppAiRoutingAllowsReply/);
});

test("Meta event identity provides stable AI idempotency and no autonomous send path exists",()=>{
 assert.match(executorSource,/idempotencyKey:`meta-whatsapp-ai:\$\{input\.eventId\}`/);
 assert.match(executorSource,/approvalRequired:true/);
 assert.match(executorSource,/autoSend:false/);
 assert.match(executorSource,/autonomousExecution:false/);
 assert.match(executorSource,/recoveryArmed:false/);
 assert.doesNotMatch(executorSource,/queueWhatsAppUatOutbound/);
 assert.doesNotMatch(executorSource,/autoSend:true/);
});

test("provider failure or policy handoff becomes human-only in the transport router",()=>{
 assert.match(webhookSource,/ai\.status==="human_handoff"/);
 assert.match(webhookSource,/mode:"human_only"/);
 assert.match(webhookSource,/automationReason:"ai_handoff"/);
 assert.match(webhookSource,/failClosedAutomation/);
});

async function world({consent=true}={}){
 const{sqlite,db}=freshAiDb();
 seedCustomer(sqlite,"CUS-WA-AI","Asha","9876500099");
 sqlite.prepare("UPDATE canonical_customers SET consent_json=? WHERE id=?").run(JSON.stringify({whatsapp:consent}),"CUS-WA-AI");
 await rollout.setAiRolloutStage(db,{stage:"customers",reason:"Meta WhatsApp executed boundary proof",actorEmail:staffActor.email});
 const inbound=await uat.recordWhatsAppUatInbound(db,{provider:"meta_whatsapp",eventId:"wamid.executed-boundary",payloadHash:"signed-payload-hash",providerIdentity:"919876500099",text:"I need grooming help",receivedAt:1770000000000,detail:{signatureVerified:true}});
 await control.setWhatsAppConversationMode(db,{threadId:inbound.threadId,mode:"ai_assistant",actorEmail:staffActor.email,reason:"Executed Meta AI boundary proof"});
 return{sqlite,db,inbound};
}

test("real D1 execution accepts only a canonical Meta inbound and reaches the governed orchestrator without a human actor",async()=>{
 const{sqlite,db,inbound}=await world();
 const result=await executor.runGovernedMetaWhatsAppAiTurn(db,{eventId:"wamid.executed-boundary",threadId:inbound.threadId,customerId:inbound.customerId,inputMessageId:inbound.messageId});
 assert.equal(result.status,"human_handoff","an unconfigured provider must fail safely to a human, proving the real orchestrator was reached");
 assert.equal(result.autoSend,false);
 assert.equal(result.autonomousExecution,false);
 assert.equal(result.recoveryArmed,false);
 const turns=sqlite.prepare("SELECT outcome,handoff_reason FROM ai_conversation_turns WHERE thread_id=?").all(inbound.threadId);
 assert.equal(turns.length,1);
 assert.equal(turns[0].outcome,"handoff");
 const audit=sqlite.prepare("SELECT actor_email,action,outcome FROM security_audit_events WHERE entity_id=? AND action='ai.conversation.meta.internal' ORDER BY created_at DESC LIMIT 1").get(inbound.threadId);
 assert.equal(audit.actor_email,"meta-whatsapp-ai@system.pawspace");
 assert.equal(audit.outcome,"completed");
});

test("replaying the same canonical Meta event is idempotent and does not create a second turn or handoff",async()=>{
 const{sqlite,db,inbound}=await world();
 const input={eventId:"wamid.executed-boundary",threadId:inbound.threadId,customerId:inbound.customerId,inputMessageId:inbound.messageId};
 const first=await executor.runGovernedMetaWhatsAppAiTurn(db,input);
 const replay=await executor.runGovernedMetaWhatsAppAiTurn(db,input);
 assert.equal(first.status,"human_handoff");
 assert.equal(replay.status,"human_handoff");
 assert.equal(replay.duplicatePrevented,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ai_conversation_turns WHERE thread_id=?").get(inbound.threadId).n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs WHERE thread_id=?").get(inbound.threadId).n,1);
});

test("missing Meta ledger evidence is rejected before AI execution and audited as blocked",async()=>{
 const{sqlite,db,inbound}=await world();
 await assert.rejects(executor.runGovernedMetaWhatsAppAiTurn(db,{eventId:"wamid.not-recorded",threadId:inbound.threadId,customerId:inbound.customerId,inputMessageId:inbound.messageId}),error=>error instanceof Response&&error.status===403);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ai_conversation_turns WHERE thread_id=?").get(inbound.threadId).n,0);
 const audit=sqlite.prepare("SELECT outcome FROM security_audit_events WHERE entity_id=? AND action='ai.conversation.meta.internal' ORDER BY created_at DESC LIMIT 1").get(inbound.threadId);
 assert.equal(audit.outcome,"blocked");
});

test("revoked consent and human assignment both block the service executor before any model turn",async()=>{
 {
  const{sqlite,db,inbound}=await world();
  sqlite.prepare("UPDATE canonical_customers SET consent_json='{}' WHERE id=?").run(inbound.customerId);
  await assert.rejects(executor.runGovernedMetaWhatsAppAiTurn(db,{eventId:"wamid.executed-boundary",threadId:inbound.threadId,customerId:inbound.customerId,inputMessageId:inbound.messageId}),error=>error instanceof Response&&error.status===409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ai_conversation_turns WHERE thread_id=?").get(inbound.threadId).n,0);
 }
 {
  const{sqlite,db,inbound}=await world();
  sqlite.prepare("UPDATE communication_threads SET assigned_to='agent@pawspace.in' WHERE id=?").run(inbound.threadId);
  await assert.rejects(executor.runGovernedMetaWhatsAppAiTurn(db,{eventId:"wamid.executed-boundary",threadId:inbound.threadId,customerId:inbound.customerId,inputMessageId:inbound.messageId}),error=>error instanceof Response&&error.status===409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ai_conversation_turns WHERE thread_id=?").get(inbound.threadId).n,0);
 }
});
