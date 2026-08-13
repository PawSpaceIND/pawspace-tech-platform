/**
 * Chunking a `WHERE x IN (...)` read is not a free refactor. Splitting one statement into several
 * changes three things the single statement guaranteed, and the D1 bind-cap tests cannot see any of
 * them because they all pass under 100 rows:
 *
 *   subrequest cost  a guard or lookup inside the chunked callback now runs once PER CHUNK
 *   ORDER BY         sorts within each chunk, so the concatenation is sorted only in blocks
 *   LIMIT n          applies per chunk, so the answer can hold n rows per chunk instead of n
 *
 * The subrequest cost and the LIMIT are asserted by running the real module against a D1 shim at a
 * size above one chunk - under one chunk every assertion here passes whether the code is right or
 * wrong. ORDER BY is guarded at the class level instead: today's ordered call sites are all pre-sorted
 * or grouped by the chunked column, so no execution test can fail on them, and a guard that only
 * covers reachable-today sites would not be there for the next one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1, assertWithinBudget } from "./helpers/d1-harness.mjs";

installWorkersHooks("__CHUNK_SEMANTICS_DB__");

import { D1_IN_CHUNK } from "../lib/d1-chunked-in.ts";

/** A Worker invocation is cut off near 1,000 subrequests. Stay visibly clear of it, not just under. */
const D1_SUBREQUEST_CEILING = 1_000;

function use(harness) {
  globalThis.__CHUNK_SEMANTICS_DB__ = harness.db;
  globalThis.__CHUNK_SEMANTICS_DB___ENV = {};
  return harness;
}

test("a guarded read wrapped in chunkedIn does not pay its table guard once per chunk", async () => {
  const harness = use(freshCountingD1());
  const { sqlite } = harness;
  sqlite.exec(
    "CREATE TABLE canonical_bookings (id text PRIMARY KEY, customer_id text, provider_id text, city_id text, service_code text, status text, scheduled_start text, scheduled_end text, total_amount real)",
  );
  for (const table of [
    "coupon_redemptions", "paw_points_ledger", "pawspace_wallet_ledger",
    "provider_order_payouts", "booking_refund_cases", "service_reviews", "customer_experience_tickets",
  ]) {
    sqlite.exec(
      `CREATE TABLE ${table} (booking_id text, source_id text, discount_amount real, points real, applied_value real, amount real, stars real, status text, entry_type text)`,
    );
  }

  // 5,000 bookings is not hypothetical volume for a launched city: it is roughly one quarter.
  const BOOKINGS = 5_000;
  const insert = sqlite.prepare(
    "INSERT INTO canonical_bookings VALUES (?,?,'PRV-1','blr','grooming','completed','2026-07-01T09:00:00.000Z','2026-07-01T10:00:00.000Z',1000)",
  );
  for (let index = 0; index < BOOKINGS; index += 1) insert.run(`BK${index}`, `CUS${index}`);

  const { buildUnitEconomics } = await import("../lib/unit-economics.ts");
  const chunks = Math.ceil(BOOKINGS / D1_IN_CHUNK);

  const result = await assertWithinBudget(
    harness,
    // Eight guarded lookups. Memoised, their guards cost 8 reads for the whole request; charged per
    // chunk they cost 8 x 63 = 504 on their own, which measured 1,012 subrequests in total and put
    // the screen back over the ceiling the chunking was introduced to get it under.
    { max: chunks * 8 + 60, label: "buildUnitEconomics over 5,000 bookings" },
    () => buildUnitEconomics(harness.db, {}),
  );

  assert.equal(result.services.grooming.orders, BOOKINGS, "the reads actually returned the bookings");
  assert.equal(result.services.grooming.gmv, BOOKINGS * 1000);
  assert.ok(harness.calls() < D1_SUBREQUEST_CEILING * 0.7, `used ${harness.calls()} subrequests; a Worker gets about ${D1_SUBREQUEST_CEILING}`);
});

test("every chunked read whose SQL orders or limits reapplies it, or is provably pre-ordered", async () => {
  // The reachable half of this class is asserted by real execution in the test below. This one guards
  // the class itself: a future chunkedIn call site with ORDER BY or LIMIT in its SQL is a decision, and
  // an undecided one is a silently wrong answer, so it has to be answered here to land.
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = new URL("../lib/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".ts"));

  // Call sites that need no reapplication, each with the reason. A "does this file re-sort somewhere"
  // check is worthless - people-reports.ts sorts payroll runs elsewhere and would satisfy it while the
  // approval trail stayed wrong - so each call site is judged on its own statement.
  const preOrdered = new Map([
    ["manager-dashboard.ts", "resolveDashboardScope already returns the scope ORDER BY e.display_name, so chunks are name-contiguous and each chunk's ORDER BY reproduces the global order"],
  ]);

  const undecided = [];
  const exemptionUsed = new Set();
  for (const name of names) {
    const source = await readFile(new URL(name, dir), "utf8");
    for (let at = source.indexOf("chunkedIn("); at !== -1; at = source.indexOf("chunkedIn(", at + 1)) {
      // The statement this call site belongs to: SQL here never contains a semicolon.
      const end = source.indexOf(";", at);
      const statement = source.slice(at, end === -1 ? source.length : end);
      if (!/ORDER BY|LIMIT \d+/.test(statement)) continue;
      if (preOrdered.has(name)) { exemptionUsed.add(name); continue; }
      // Wrapped in a named call that takes the concatenated rows: `= reapply(await chunkedIn(...))`.
      const wrapped = /=\s*[A-Za-z_$][\w$]*\(\s*await\s*$/.test(source.slice(Math.max(0, at - 40), at));
      if (!wrapped) undecided.push(`${name}: ${statement.slice(0, 70)}`);
    }
  }
  assert.deepEqual(undecided, [], "these call sites chunk a read that orders or limits, without reapplying it to the concatenated rows or recording why that is unnecessary");

  for (const [name, reason] of preOrdered) {
    assert.ok(exemptionUsed.has(name), `${name} no longer has an ordered chunked read - drop its exemption (${reason})`);
  }
});

test("a chunked LIMIT returns the newest n overall, not n per chunk", async () => {
  const harness = use(freshCountingD1());
  const { sqlite } = harness;
  const { peopleReports } = await import("../lib/people-reports.ts");
  // Read by the audit panel in the same call; not created by any of the people ensure* helpers.
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id text PRIMARY KEY, actor_email text, actor_role text, action text, resource_type text, resource_id text, outcome text, created_at integer)");

  // Let the module create its own schema, so this test cannot disagree with production about shapes.
  await peopleReports(harness.db, { actorEmail: "founder@pawspace.in", roleCode: "founder", permissions: ["*"] });

  const APPROVAL_LIMIT = 200;
  const RUNS = D1_IN_CHUNK * 2 + 5;
  const periodStart = Date.UTC(2026, 6, 1), periodEnd = Date.UTC(2026, 6, 31);
  sqlite.prepare("INSERT INTO employees (id,employee_code,display_name,work_email,user_email,employment_status,joined_at,created_at,updated_at) VALUES ('EMP-1','E-1','Payee','payee@pawspace.in','payee@pawspace.in','active',0,0,0)").run();

  let newest = 0;
  const stamps = [];
  for (let run = 0; run < RUNS; run += 1) {
    const runId = `RUN-${String(run).padStart(4, "0")}`;
    sqlite.prepare("INSERT INTO payroll_runs (id,idempotency_key,period_start,period_end,status,input_snapshot_json,created_by,created_at) VALUES (?,?,?,?,'approved','{}','seed',0)").run(runId, `${runId}-idem`, periodStart, periodEnd);
    sqlite.prepare("INSERT INTO employee_payroll_results (id,run_id,employee_id,structure_id,gross_earnings,total_deductions,reimbursements,employer_cost,net_pay,source_snapshot_json) VALUES (?,?,'EMP-1','STR-1',1000,0,0,100,900,'{}')").run(`RES-${run}`, runId);
    // Five events per run: 460 in total, and every chunk holds well under the per-chunk LIMIT of 200,
    // so the wrong answer is not "too many rows" but "the wrong rows, in the wrong order".
    for (let event = 0; event < 5; event += 1) {
      const createdAt = run * 1_000 + event;
      sqlite.prepare("INSERT INTO payroll_approval_events (id,run_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,'approved','approver@pawspace.in','{}',?)").run(`EVT-${run}-${event}`, runId, createdAt);
      stamps.push(createdAt);
      newest = Math.max(newest, createdAt);
    }
  }

  const report = await peopleReports(harness.db, {
    actorEmail: "founder@pawspace.in", roleCode: "founder", permissions: ["*"],
    periodStart, periodEnd,
  });
  const events = report.payroll.approvalEvents;

  assert.equal(events.length, APPROVAL_LIMIT, `the limit holds over the whole answer (${stamps.length} events exist)`);
  assert.equal(Number(events[0].created_at), newest, "the newest event overall is first, not the newest of chunk one");
  const descending = events.every((row, index) => index === 0 || Number(events[index - 1].created_at) >= Number(row.created_at));
  assert.ok(descending, "the trail is ordered newest-first across chunk boundaries");
  const expectedOldestKept = [...stamps].sort((left, right) => right - left)[APPROVAL_LIMIT - 1];
  assert.equal(Number(events[APPROVAL_LIMIT - 1].created_at), expectedOldestKept, "the 200 kept are the 200 newest, not the first 200 found");
});
