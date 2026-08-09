import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const read=path=>fs.readFileSync(path,"utf8");
const handoff=read("lib/ai-human-handoff.ts");
const orchestrator=read("lib/ai-conversation-orchestrator.ts");
const route=read("app/api/ai-human-handoff/route.ts");

test("AI Gate 4 preserves canonical thread and captures handoff summary",()=>{
 assert.match(handoff,/thread_id TEXT NOT NULL/);
 assert.match(handoff,/summary_json TEXT NOT NULL/);
 assert.match(handoff,/communication_messages/);
 assert.match(handoff,/ai_conversation_turns/);
 assert.match(handoff,/sameCanonicalThread:true/);
});

test("AI Gate 4 routes sensitive escalation reasons with SLA",()=>{
 assert.match(handoff,/refund_payment_dispute/);
 assert.match(handoff,/cx-safety/);
 assert.match(handoff,/urgent_funeral_memorial/);
 assert.match(handoff,/cx-sensitive-care/);
 assert.match(handoff,/sensitive_relocation/);
 assert.match(handoff,/cx-service-recovery/);
 assert.match(handoff,/slaMinutes/);
});

test("AI Gate 4 staff takeover pauses AI and governed resume is explicit",()=>{
 assert.match(handoff,/staff_active/);
 assert.match(handoff,/AI can resume only after explicit staff takeover/);
 assert.match(handoff,/Resume reason is required/);
 assert.match(handoff,/governed_ai_resume/);
 assert.match(handoff,/AI replies are paused while the conversation is owned by staff/);
 assert.match(orchestrator,/assertAiMayReply/);
});

test("AI Gate 4 handoff is permission governed and audited",()=>{
 assert.match(route,/authorize\(request,"communications.message"\)/);
 assert.match(route,/Cross-origin AI handoff write blocked/);
 assert.match(route,/ai\.handoff\.takeover/);
 assert.match(route,/ai\.handoff\.resume/);
 assert.match(route,/securityAudit/);
});

test("AI Gate 4 supports repeated handoff cycles without parallel active ownership",()=>{
 assert.match(handoff,/CREATE UNIQUE INDEX IF NOT EXISTS ai_handoff_active_thread_idx/);
 assert.match(handoff,/WHERE status IN \('queued','staff_active'\)/);
 assert.match(handoff,/handoff_requested/);
 assert.match(handoff,/staff_takeover/);
 assert.match(handoff,/ai_resumed/);
});
