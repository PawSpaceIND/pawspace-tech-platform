import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ceo=fs.readFileSync("lib/executive/ceo-orchestrator.ts","utf8");
const policy=fs.readFileSync("lib/executive/decision-policy.ts","utf8");
const sales=fs.readFileSync("lib/ai-sales-goal-orchestrator.ts","utf8");
const cockpit=fs.readFileSync("app/api/admin/executive-cockpit/route.ts","utf8");
const worker=fs.readFileSync("worker/index.ts","utf8");
const vite=fs.readFileSync("vite.config.ts","utf8");

test("executive loop is scheduled every 15 minutes and idempotent per slot",()=>{
 assert.match(ceo,/EXECUTIVE_CRON="\*\/15 \* \* \* \*"/); assert.match(vite,/"\*\/15 \* \* \* \*"/); assert.match(worker,/runExecutiveDecisionLoop/); assert.match(ceo,/slot_key TEXT NOT NULL UNIQUE/);
});
test("capacity >= 90 percent throttles outbound sales and dispatcher consumes directive",()=>{
 assert.match(policy,/capacityUtilization>=0\.90/); assert.match(policy,/mode:"throttle"/); assert.match(policy,/pressureMultiplier:0/); assert.match(ceo,/capacityUtilization:cap\.utilization/); assert.match(sales,/executiveMode === "throttle" \? 0/); assert.match(sales,/executive_capacity_throttle/);
});
test("pacing lag above 25 percent only authorizes pre-approved target envelope",()=>{
 assert.match(policy,/pacingLagFraction>0\.25/); assert.match(policy,/approvedDiscountBps/); assert.match(policy,/approvedUpgradeCodes/); assert.match(ceo,/approvedDiscountBps:num\(target\.max_discount_bps\)/); assert.match(ceo,/free_upgrade_codes_json/); assert.match(ceo,/marginValidationRequired:true/); assert.doesNotMatch(policy,/approvedDiscountBps\s*\+/);
});
test("founder cockpit is role restricted with kill switch SSE and maker-checker queue",()=>{
 assert.match(cockpit,/\["founder","superuser"\]/); assert.match(cockpit,/PAWSPACE_AI_EXECUTIVE_ACTIVE/); assert.match(cockpit,/text\/event-stream/); assert.match(cockpit,/awaiting_approval_2/); assert.match(cockpit,/awaiting_finance_approval/); assert.match(cockpit,/pending_approval/); assert.match(cockpit,/booking_refund_cases/); assert.match(ceo,/PAWSPACE_AI_EXECUTIVE_ACTIVE\|\|"false"/);
});
test("previous Atlas worker hooks remain intact beside executive cadence",()=>{
 assert.match(worker,/handleAtlasWebSocket/); assert.match(worker,/runAtlasDailyAnalysis/); assert.match(vite,/"15 2 \* \* \*"/);
});
