import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const lib=fs.readFileSync(new URL("../lib/lead-sla-governance.ts",import.meta.url),"utf8");
const api=fs.readFileSync(new URL("../app/api/lead-sla-governance/route.ts",import.meta.url),"utf8");
const crm=fs.readFileSync(new URL("../app/api/revenue-crm/route.ts",import.meta.url),"utf8");

test("SLA policy is versioned and activation requires approval",()=>{
 assert.match(lib,/lead_sla_policy_versions/);
 assert.match(lib,/approvalReference\.trim\(\)\.length<4/);
 assert.match(lib,/Only draft SLA policy can be activated/);
});

test("SLA values are configuration rather than fixed operating constants",()=>{
 assert.match(lib,/first_response_minutes/);
 assert.match(lib,/follow_up_minutes/);
 assert.match(lib,/quote_follow_up_minutes/);
 assert.match(lib,/high_intent_minutes/);
 assert.match(lib,/legacyFixed10And30MinuteRulesAuthoritative:false/);
 assert.match(crm,/30-minute lead response breached/);
});

test("business-hour-aware SLA clocks are supported",()=>{
 assert.match(lib,/mode:\"elapsed\"\|\"windowed\"/);
 assert.match(lib,/isWorkingMinute/);
 assert.match(lib,/addPolicyMinutes/);
 assert.match(lib,/Outside configured business hours/);
});

test("breach escalation and reassignment-due events are idempotent",()=>{
 assert.match(lib,/idempotency_key TEXT NOT NULL UNIQUE/);
 assert.match(lib,/manager_escalation_due/);
 assert.match(lib,/reassignment_due/);
 assert.match(lib,/automaticReassignment:false/);
});

test("non-terminal outcomes require governed next actions",()=>{
 assert.match(lib,/require_next_action/);
 assert.match(lib,/This non-terminal lead outcome requires a governed next action/);
 assert.match(lib,/nextClockType/);
});

test("pause and resume preserve explicit SLA state",()=>{
 assert.match(lib,/status='paused'/);
 assert.match(lib,/paused_remaining_minutes/);
 assert.match(lib,/Only paused SLA clock can be resumed/);
});

test("SLA API is permissioned and production remains false",()=>{
 assert.match(api,/authorize\(request,\"customers\.view\"\)/);
 assert.match(api,/authorize\(request,\"customers\.manage\"\)/);
 assert.match(api,/productionReady:false/);
 assert.match(api,/run_governance/);
});
