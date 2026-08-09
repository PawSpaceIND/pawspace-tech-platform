import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const read=path=>fs.readFileSync(path,"utf8");
const orchestrator=read("lib/ai-conversation-orchestrator.ts");
const handoff=read("lib/ai-human-handoff.ts");
const route=read("app/api/ai-conversation/route.ts");

test("AI conversation Gate 1 persists canonical session and turn records",()=>{
 assert.match(orchestrator,/ai_conversation_sessions/);
 assert.match(orchestrator,/ai_conversation_turns/);
 assert.match(orchestrator,/idempotency_key TEXT NOT NULL UNIQUE/);
 assert.match(orchestrator,/input_message_id TEXT NOT NULL/);
});

test("AI conversation Gate 1 uses canonical conversation and minimum customer context",()=>{
 assert.match(orchestrator,/communication_messages/);
 assert.match(orchestrator,/communication_threads/);
 assert.match(orchestrator,/buildCustomer360/);
 assert.match(orchestrator,/requireCustomerOwnership/);
 assert.match(orchestrator,/createAiContext/);
});

test("AI conversation Gate 1 has explicit confidence fallback and human handoff",()=>{
 assert.match(orchestrator,/intent\.confidence<0\.65/);
 assert.match(orchestrator,/requestAiHumanHandoff/);
 assert.match(handoff,/assignConversation/);
 assert.match(orchestrator,/human_handoff/);
 assert.match(orchestrator,/provider_unavailable/);
 assert.match(orchestrator,/provider_error/);
});

test("AI conversation Gate 1 blocks high-impact autonomy",()=>{
 assert.match(orchestrator,/refund_review/);
 assert.match(orchestrator,/blocked_high_impact/);
 assert.match(orchestrator,/autonomousExecution:false/);
 assert.match(orchestrator,/forbiddenAutonomousActions/);
});

test("AI conversation Gate 1 records provider audit metadata without requiring a live model",()=>{
 assert.match(orchestrator,/provider:"not_connected"/);
 assert.match(orchestrator,/model_ref/);
 assert.match(orchestrator,/latency_ms/);
 assert.match(orchestrator,/input_tokens/);
 assert.match(orchestrator,/output_tokens/);
 assert.match(orchestrator,/cost_minor/);
});

test("AI conversation API requires canonical message and idempotency input",()=>{
 assert.match(route,/inputMessageId/);
 assert.match(route,/idempotencyKey/);
 assert.match(route,/Cross-origin AI conversation write blocked/);
 assert.match(route,/securityAudit/);
});
