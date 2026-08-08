import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const command=fs.readFileSync("lib/revenue-mission-command-center.ts","utf8");
const reporting=fs.readFileSync("lib/revenue-leadership-reporting.ts","utf8");
const commandApi=fs.readFileSync("app/api/revenue-mission-command-center/route.ts","utf8");
const reportApi=fs.readFileSync("app/api/revenue-leadership-reporting/route.ts","utf8");
const page=fs.readFileSync("app/team/revenue-mission/page.tsx","utf8");

test("Step 7 keeps pipeline and achieved revenue separate",()=>{
  assert.match(command,/pipelineIsAchievedRevenue:false/);
  assert.match(command,/forecastIsAchievedRevenue:false/);
  assert.match(command,/achievedRevenueSource:\"revenue_mission_events\"/);
  assert.match(page,/Pipeline — not achieved revenue/);
});

test("Step 7 exposes target pace gap queues breakdowns productivity and warnings",()=>{
  for(const token of["paceTarget","paceVariance","leadQueue","breakdowns","productivity","warnings","sourceIntegrity"])assert.match(command,new RegExp(token));
  assert.match(commandApi,/authorize\(request,\"reports\.view\"\)/);
  assert.match(page,/REVENUE MISSION CONTROL · UAT ONLY/);
  assert.match(page,/Production ready: NO/);
});

test("Step 7 does not make synthetic opportunity or leaderboard truth authoritative",()=>{
  assert.match(command,/syntheticOpportunityCredit:false/);
  assert.match(command,/legacyLeaderboardAuthority:false/);
  assert.match(command,/incentiveAuthority:false/);
  assert.doesNotMatch(command,/sales_performance_daily/);
  assert.doesNotMatch(command,/generateDaily100/);
});

test("Step 8 version-locks report snapshots to metric and mission definitions",()=>{
  assert.match(reporting,/revenue_metric_definitions/);
  assert.match(reporting,/metric_definition_version/);
  assert.match(reporting,/mission_config_version/);
  assert.match(reporting,/metricDefinitionVersion/);
  assert.match(reporting,/missionConfigVersion/);
});

test("Step 8 report generation is idempotent and immutable",()=>{
  assert.match(reporting,/idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(reporting,/reportSnapshotImmutable:true/);
  assert.match(reporting,/snapshotsImmutable:true/);
  assert.match(reporting,/duplicatePrevented:true/);
});

test("delivery state is independent from report metric truth",()=>{
  assert.match(reporting,/deliveryChangesTruth:false/);
  assert.match(reporting,/metricTruthChanged:false/);
  assert.match(reporting,/deliveryIndependentFromMetricTruth:true/);
});

test("leadership reporting remains secured and UAT-only",()=>{
  assert.match(reportApi,/authorize\(request,\"reports\.view\"\)/);
  assert.match(reportApi,/authorize\(request,\"customers\.manage\"\)/);
  assert.match(reportApi,/productionReady:false/);
  assert.match(reporting,/legacyCommandReportRunsAuthoritative:false/);
  assert.doesNotMatch(reporting,/command_report_runs/);
});
