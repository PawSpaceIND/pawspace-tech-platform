import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const runbook=read("docs/END_TO_END_STAFF_UAT_EXECUTION.md");

test("final candidate runbook includes provider, GPS, Finance, AI and swarm gates",()=>{
 for(const marker of[
  "Provider onboarding configuration",
  "UAT provider activation",
  "GPS / ETA / lateness recovery",
  "Replacement and accountability governance",
  "Finance, GST and accounting",
  "Partner settlement / reconciliation",
  "Unified case/escalation",
  "AI engagement",
  "Human handoff",
  "Hosted real-D1 60-booking swarm"
 ])assert.match(runbook,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
});

test("final candidate preserves hard production boundaries",()=>{
 for(const marker of[
  "PRODUCTION READY = FALSE",
  "live=0",
  "marketplaceLive=false",
  "orderEligible=false",
  "configuration_required",
  "No live statutory filing",
  "cannot directly create money deductions",
  "If exact-SHA deployment or D1 cannot be verified, mark the run `BLOCKED`"
 ])assert.match(runbook,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
});

test("green CI is not allowed to stand in for human UAT",()=>{
 assert.match(runbook,/Exact-head green CI alone means \*\*engineering-ready\*\*, not UAT-closed and not production-ready/);
 assert.match(runbook,/every applicable step above is executed by the relevant human role/);
 assert.match(runbook,/mandatory negative checks pass/);
});
