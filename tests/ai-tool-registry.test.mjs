import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const read=path=>fs.readFileSync(path,"utf8");
const registry=read("lib/ai-tool-registry.ts");
const route=read("app/api/ai-tools/route.ts");

test("AI Gate 3 registers required read-only canonical tools",()=>{
 for(const code of["service_catalogue.read","customer_bookings.read","booking_status.read","provider_status.read","subscription_wallet.read","case_status.read","approved_knowledge.read"])assert.match(registry,new RegExp(code.replace(".","\\.")));
 assert.match(registry,/canonicalService/);
 assert.match(registry,/groomingCatalogue/);
 assert.match(registry,/listCustomerSubscriptionWallets/);
 assert.match(registry,/retrieveApprovedKnowledge/);
});

test("AI Gate 3 registers governed transactional orchestration without money execution",()=>{
 for(const code of["quote.request","booking.request","booking_reschedule.request","booking_cancel.request","case.create","staff_handoff.create"])assert.match(registry,new RegExp(code.replace(".","\\.")));
 assert.match(registry,/createUnifiedCase/);
 assert.match(registry,/assignConversation/);
 assert.match(registry,/does not assign a provider or capture money/);
 assert.match(registry,/no refund is issued/);
});

test("AI Gate 3 permissions are scoped by intent channel customer and role",()=>{
 assert.match(registry,/definition\.intents\.includes\(input\.intent\)/);
 assert.match(registry,/definition\.channels\.includes\(input\.channel\)/);
 assert.match(registry,/requireCustomerOwnership/);
 assert.match(registry,/staffPermissions/);
 assert.match(registry,/AI tool permission denied/);
});

test("AI Gate 3 rejects model or browser authoritative commercial state",()=>{
 assert.match(registry,/forbiddenAuthoritativeFields/);
 assert.match(registry,/totalAmount/);
 assert.match(registry,/providerId/);
 assert.match(registry,/walletBalance/);
 assert.match(registry,/Authoritative field .* must be resolved server-side/);
 assert.match(registry,/serverAuthoritative:true/);
});

test("AI Gate 3 requires idempotency and a separate explicit confirmation for mutations",()=>{
 assert.match(registry,/ai_tool_mutation_idempotency_idx/);
 assert.match(registry,/Idempotency key is required for every AI tool mutation/);
 assert.match(registry,/confirmation_required/);
 assert.match(registry,/explicitly_confirmed/);
 assert.match(registry,/confirmAiToolExecution/);
 assert.match(registry,/awaiting_explicit_confirmation/);
});

test("AI Gate 3 keeps high-impact actions deterministic and approval gated",()=>{
 for(const code of["refund.issue","payment.capture","payout.release","price.override","provider.assign","campaign.activate"])assert.match(registry,new RegExp(code.replace(".","\\.")));
 assert.match(registry,/mode:"approval_gated"/);
 assert.match(registry,/status:"approval_required"/);
 assert.match(registry,/autonomousExecution:false/);
});

test("AI Gate 3 writes immutable tool audit events and API security audit",()=>{
 assert.match(registry,/ai_tool_audit_events/);
 assert.match(registry,/executed_read/);
 assert.match(registry,/executed_mutation/);
 assert.match(registry,/canonical_service_rejected/);
 assert.match(route,/Cross-origin AI tool write blocked/);
 assert.match(route,/securityAudit/);
 assert.match(route,/ai\.tool\.confirm_execute/);
});
