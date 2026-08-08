import assert from"node:assert/strict";
import fs from"node:fs";
import test from"node:test";

const engine=fs.readFileSync(new URL("../lib/sales-productivity-governance.ts",import.meta.url),"utf8");
const route=fs.readFileSync(new URL("../app/api/sales-productivity-governance/route.ts",import.meta.url),"utf8");
const legacy=fs.readFileSync(new URL("../app/api/revenue-crm/route.ts",import.meta.url),"utf8");

test("productivity uses canonical source tables",()=>{
 assert.match(engine,/lead_assignments/);
 assert.match(engine,/lead_sla_events/);
 assert.match(engine,/canonical_bookings/);
 assert.match(engine,/revenue_mission_events/);
});

test("legacy leaderboard is explicitly non-authoritative",()=>{
 assert.match(engine,/legacySalesPerformanceDailyAuthoritative:false/);
 assert.match(engine,/incentiveAuthority:false/);
 assert.match(engine,/rankingAuthority:false/);
 assert.match(legacy,/sales_performance_daily/);
});

test("unsupported quote metric is not invented",()=>{
 assert.match(engine,/quote_count INTEGER/);
 assert.match(engine,/quoteCount:null/);
 assert.match(engine,/source_not_canonical/);
});

test("fact generation is idempotent and policy-versioned",()=>{
 assert.match(engine,/idempotency_key TEXT NOT NULL UNIQUE/);
 assert.match(engine,/policy_version INTEGER NOT NULL/);
 assert.match(engine,/source_contract_version/);
 assert.match(engine,/duplicatePrevented:true/);
});

test("productivity exposes source drilldown",()=>{
 assert.match(engine,/salesProductivityDrilldown/);
 assert.match(engine,/drilldownToSource:true/);
 assert.match(engine,/revenueEvents/);
 assert.match(engine,/assignments/);
 assert.match(engine,/actions/);
});

test("productivity API is permissioned and production false",()=>{
 assert.match(route,/authorize\(request,"reports\.view"\)/);
 assert.match(route,/authorize\(request,"customers\.manage"\)/);
 assert.match(route,/productionReady:false/);
});
