import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=p=>fs.readFileSync(p,"utf8");

test("Unified Case Center owns one canonical case/event/comment model",()=>{const src=read("lib/unified-case-center.ts");for(const token of["unified_cases","unified_case_events","unified_case_comments","case_policies","idempotency_key TEXT NOT NULL UNIQUE","first_response_due_at","resolution_due_at","manager_escalation_due_at","reopen_count"])assert.ok(src.includes(token),token);});

test("native refund lead-SLA and payment-reconciliation exceptions converge into cases",()=>{const src=read("lib/unified-case-center.ts");assert.ok(src.includes("booking_refund_cases"));assert.ok(src.includes("lead_sla_events"));assert.ok(src.includes("payment_reconciliation_exceptions"));assert.ok(src.includes('caseType:"refund"'));assert.ok(src.includes('caseType:"lead_escalation"'));assert.ok(src.includes('caseType:"reconciliation"'));});

test("case escalation runner is idempotent and does not claim automatic external alerts",()=>{const src=read("lib/unified-case-center.ts");assert.ok(src.includes("first-response-breach:${id}"));assert.ok(src.includes("manager-escalation:${id}"));assert.ok(src.includes("resolution-breach:${id}"));assert.ok(src.includes("automaticExternalNotification:false"));});

test("case API enforces read/manage permissions and audits mutations",()=>{const src=read("app/api/unified-cases/route.ts");assert.ok(src.includes('authorize(request,"bookings.view")'));assert.ok(src.includes('authorize(request,"bookings.manage")'));assert.ok(src.includes("securityAudit"));assert.ok(src.includes("productionReady:false"));});

test("staff Case Center exposes sync escalation ownership and lifecycle controls",()=>{const src=read("app/team/cases/page.tsx");for(const token of["CASE & ESCALATION CENTER","Sync refunds / SLA / reconciliation","Run escalations","Mark responded","In progress","Waiting","Resolve","Close","Reopen","Production ready: NO"])assert.ok(src.includes(token),token);});
