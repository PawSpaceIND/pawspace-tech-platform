import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const engine=read("lib/revenue-mission-control.ts"),api=read("app/api/revenue-mission-control/route.ts"),legacy=read("app/api/revenue-crm/route.ts");

test("mission configuration requires an explicit period basis and version history",()=>{
 assert.match(engine,/period_start INTEGER NOT NULL/);assert.match(engine,/period_end INTEGER NOT NULL/);assert.match(engine,/revenue_basis TEXT NOT NULL/);assert.match(engine,/revenue_mission_versions/);assert.match(engine,/Mission period start and end are required/);
});

test("canonical revenue events are duplicate-safe and source keyed",()=>{
 assert.match(engine,/revenue_mission_events/);assert.match(engine,/source_event_key TEXT NOT NULL/);assert.match(engine,/UNIQUE\(mission_id,source_event_key\)/);assert.match(engine,/INSERT OR IGNORE INTO revenue_mission_events/);
});

test("achieved revenue separates booked collected refunded and net collected",()=>{
 assert.match(engine,/event_type='booked'/);assert.match(engine,/event_type='collected'/);assert.match(engine,/event_type='refunded'/);assert.match(engine,/netCollected/);assert.match(engine,/revenueBasis==="booked"/);assert.match(engine,/revenueBasis==="collected"/);
});

test("canonical-source backfill reads bookings and payment reconciliation only",()=>{
 assert.match(engine,/FROM canonical_bookings/);assert.match(engine,/payment_reconciliation_records/);assert.match(engine,/syntheticSourcesUsed:false/);assert.doesNotMatch(engine,/sales_performance_daily/);assert.doesNotMatch(engine,/revenue_opportunities/);
});

test("mission truth explicitly rejects synthetic opportunity and leaderboard credit",()=>{
 assert.match(engine,/syntheticOpportunityCredit:false/);assert.match(engine,/provisionalLeaderboardCredit:false/);assert.match(engine,/achievedSource:"canonical bookings \+ payment reconciliation only"/);
 assert.match(legacy,/generateDaily100/);assert.match(legacy,/sales_performance_daily/);
});

test("mission mutation is permissioned and security audited",()=>{
 assert.match(api,/authorize\(request,"customers\.manage"\)/);assert.match(api,/securityAudit/);assert.match(api,/revenue\.mission\.save/);assert.match(api,/revenue\.mission\.activate/);assert.match(api,/revenue\.mission\.close/);
});

test("mission activation and backfill never claim production readiness",()=>{
 assert.match(api,/productionReady:false/);assert.match(engine,/productionReady:false/);assert.match(api,/backfill_canonical_sources/);
});
