import assert from"node:assert/strict";
import fs from"node:fs";
import test from"node:test";

const executor=fs.readFileSync("lib/meta-whatsapp-ai-executor.ts","utf8");
const webhook=fs.readFileSync("lib/meta-whatsapp-webhook.ts","utf8");

test("internal Meta AI execution is bound to the canonical signed-webhook ledger rather than an HTTP actor",()=>{
 assert.match(executor,/FROM whatsapp_uat_events e JOIN communication_messages m/);
 assert.match(executor,/e\.provider='meta_whatsapp'/);
 assert.match(executor,/e\.event_type='inbound_message'/);
 assert.match(executor,/message_provider\)!=="meta_whatsapp"/);
 assert.match(executor,/direction\)!=="inbound"/);
 assert.match(executor,/thread_customer_id/);
 assert.doesNotMatch(executor,/resolveActor\(/);
});

test("service executor remains narrow, audited and customer-rollout gated",()=>{
 assert.match(executor,/service_meta_whatsapp_ai/);
 assert.match(executor,/permissions:\["communications\.manage"\]/);
 assert.doesNotMatch(executor,/permissions:\["\*"\]/);
 assert.match(executor,/resolveAiAudienceGate\(db,\{audience:"customer"\}\)/);
 assert.match(executor,/securityAudit/);
 assert.match(executor,/governed_internal_boundary_rejected/);
});

test("consent, human assignment, human ownership and AI routing are rechecked immediately before execution",()=>{
 assert.match(executor,/whatsappConsent/);
 assert.match(executor,/opt_out/);
 assert.match(executor,/assigned_to/);
 assert.match(executor,/human_owned/);
 assert.match(executor,/assertWhatsAppAiRoutingAllowsReply/);
});

test("Meta event identity provides stable AI idempotency and no autonomous send path exists",()=>{
 assert.match(executor,/idempotencyKey:`meta-whatsapp-ai:\$\{input\.eventId\}`/);
 assert.match(executor,/approvalRequired:true/);
 assert.match(executor,/autoSend:false/);
 assert.match(executor,/autonomousExecution:false/);
 assert.match(executor,/recoveryArmed:false/);
 assert.doesNotMatch(executor,/queueWhatsAppUatOutbound/);
 assert.doesNotMatch(executor,/autoSend:true/);
});

test("provider failure or policy handoff becomes human-only in the transport router",()=>{
 assert.match(webhook,/ai\.status==="human_handoff"/);
 assert.match(webhook,/mode:"human_only"/);
 assert.match(webhook,/automationReason:"ai_handoff"/);
 assert.match(webhook,/failClosedAutomation/);
});
