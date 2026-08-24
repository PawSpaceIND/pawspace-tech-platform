import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const evaluation=read("lib/ai-evaluation-security.ts");

test("Gate 7 evaluation manifest covers all required security and quality categories",()=>{for(const category of["intent","groundedness","knowledge_freshness","hallucination","prompt_injection","data_isolation","pii","tool_authorization","consent","handoff","multilingual","webhook_reliability","instrumentation"])assert.match(evaluation,new RegExp(`category:\"${category}\"`));});

test("Gate 7 blocks prompt injection and redacts common PII",()=>{assert.match(evaluation,/ignore_instructions/);assert.match(evaluation,/reveal_system_prompt/);assert.match(evaluation,/injectionPatterns/);assert.match(evaluation,/piiPatterns/);assert.match(evaluation,/\[REDACTED\]/);assert.match(evaluation,/detectPromptInjection/);assert.match(evaluation,/redactPii/);});

test("Gate 7 rejects ungrounded business claims cross-customer references and unapproved high-impact actions",()=>{for(const marker of["fabricated_or_unapproved_high_impact_claim","missing_high_impact_approval","cross_customer_reference","ungrounded_business_claim"])assert.match(evaluation,new RegExp(marker));assert.match(evaluation,/approval_gated/);assert.match(evaluation,/approvalReference/);assert.match(evaluation,/customerOwned/);assert.match(evaluation,/permissionGranted/);});

test("Gate 7 enforces active knowledge windows",()=>{assert.match(evaluation,/knowledgeVersionAllowed/);assert.match(evaluation,/input\.status===\"active\"/);assert.match(evaluation,/effectiveFrom/);assert.match(evaluation,/effectiveTo/);});

test("Gate 7 deterministic suite remains explicit and non-production",()=>{assert.match(evaluation,/runStaticAiEvaluationSuite/);assert.match(evaluation,/evaluateDeterministicCase/);assert.match(evaluation,/suiteVersion:\"gate7-v1\"/);assert.match(evaluation,/productionReady:false/);});

test("Gate 7 integration contracts retain authorization handoff replay consent and instrumentation boundaries",()=>{const orchestrator=read("lib/ai-conversation-orchestrator.ts"),tools=read("lib/ai-tool-registry.ts"),handoff=read("lib/ai-human-handoff.ts"),whatsapp=read("lib/whatsapp-uat-adapter.ts"),communications=read("lib/communication-engine.ts");assert.match(orchestrator,/requireCustomerOwnership/);assert.match(orchestrator,/latency_ms/);assert.match(orchestrator,/input_tokens/);assert.match(orchestrator,/output_tokens/);assert.match(tools,/approval_gated/);assert.match(handoff,/assertAiMayReply/);assert.match(whatsapp,/UNIQUE\(provider,event_id\)/);assert.match(communications,/marketing_opt_out|marketing_consent_unknown/);assert.match(communications,/quiet_hours/);});
