import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// A screen that empties itself as time passes.
//
// employeePerformanceCenter asks for the latest sales_productivity_fact_runs row, and it used to ask
// for one whose period sat INSIDE [now-31d, now+1d]. A run spanning 30 days - which is what the
// generator emits, and what a monthly productivity run is - only satisfies that for two days:
//
//     period_start >= now-31d   and   period_end <= now+1d
//     with a 30-day run:  period_start ∈ [now-31d, now-29d]
//
// Outside those two days the query returns nothing, `facts` stays empty, and both
// /team/people/performance and employee self-service render as if the business did nothing - with no
// error anywhere. It was measured on the real demo seed: visible from 2026-08-12 10:00 to
// 2026-08-14 10:00 UTC and invisible either side of that.
//
// It was found by a test that had been passing for the same reason - by calendar coincidence - and
// failed four minutes after the window shut. So the tests below pin the window semantics against
// wall-clock offsets rather than fixed dates, which is the only way this class stays fixed.
// ---------------------------------------------------------------------------
installWorkersHooks("__PWF_DB__", "__PWF_ENV__");

const DAY = 86_400_000;

async function seedRun({ startDaysAgo, spanDays }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__PWF_DB__ = db;
  globalThis.__PWF_ENV__ = {};

  const { ensureSalesProductivityTables } = await import("../lib/sales-productivity-governance.ts");
  await ensureSalesProductivityTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role_code TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)");
  sqlite.prepare("INSERT OR IGNORE INTO app_users VALUES ('u1','rep@pawspace.test','Rep','associate','active',0,0)").run();

  const now = Date.now();
  const periodStart = now - startDaysAgo * DAY;
  const periodEnd = periodStart + spanDays * DAY;
  sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES ('R1','r1','P1',1,?,?,'completed','v1','test',?,'{}')")
    .run(periodStart, periodEnd, periodEnd);
  sqlite.prepare(`INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,leads_assigned,assignments_accepted,meaningful_actions,qualified_leads,first_response_clocks,first_response_met,first_response_breached,booking_conversions,booked_revenue,collected_revenue,refunds,net_collected_revenue,cx_escalations,opt_out_or_consent_blocks,data_quality_blocks,quote_count,source_detail_json,created_at)
    VALUES ('F1','R1','rep@pawspace.test','sales',?,?,10,9,20,6,6,5,1,4,80000,60000,0,60000,0,0,0,NULL,'{}',?)`)
    .run(periodStart, periodEnd, periodEnd);

  const { employeePerformanceCenter } = await import("../lib/employee-performance-center.ts");
  return employeePerformanceCenter(db, { metric: "net_collected_revenue", days: 30 });
}

test("a 30-day fact run ending today is visible", async () => {
  const board = await seedRun({ startDaysAgo: 30, spanDays: 30 });
  assert.equal(board.rows.length, 1, "the freshest possible run must be readable");
});

test("a 30-day fact run that ended three weeks ago is still visible", async () => {
  // The case that was broken. period_start is 51 days back, so the old containment test rejected it
  // (`period_start >= now-31d` fails) and every performance screen went blank - even though the run
  // covers three of the last four weeks. This is the ordinary state of a seed a few weeks after it was
  // applied, which is to say: the normal state of staging.
  const board = await seedRun({ startDaysAgo: 51, spanDays: 30 });
  assert.equal(board.rows.length, 1, "a run overlapping the window must be readable, not silently dropped");
  assert.equal(board.rows[0].employeeEmail, "rep@pawspace.test");
});

test("a 30-day fact run whose period has not started yet is visible while it overlaps", async () => {
  // A run generated slightly ahead of the clock (the seed anchors to 06:00 UTC, so for part of each day
  // period_end is in the future) must not disappear.
  const board = await seedRun({ startDaysAgo: 29, spanDays: 30 });
  assert.equal(board.rows.length, 1, "a run ending tomorrow still overlaps today");
});

test("a fact run that does not touch the last 30 days is NOT shown", async () => {
  // Overlap must stay honest: a quarter-old run may not masquerade as this month's numbers. This is the
  // assertion that stops the fix above from becoming "show whatever you can find".
  const board = await seedRun({ startDaysAgo: 200, spanDays: 30 });
  assert.equal(board.rows.length, 0, "a run from six months ago must not be presented as the last 30 days");
});
