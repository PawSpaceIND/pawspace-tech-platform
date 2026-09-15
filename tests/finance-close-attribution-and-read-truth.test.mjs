/*
 * Monthly close: whose payroll is this month's, what a READ is allowed to do, and whether the PAN
 * control the TDS module advertises actually exists.
 *
 * Three defects, all found on real seeded data and all EXECUTED here against a SQLite-backed D1
 * through the shared counting harness - no source scanning, because every one of them is a behaviour
 * a source scan would have read straight past.
 *
 *   FIN-W1-D1  One payroll run was attributed to TWO consecutive months. monthWindow() builds
 *              IST-shifted boundaries (Date.UTC(...) - 330*60_000) while payroll_runs stores
 *              plain-UTC end-of-day boundaries, and the selector was a bare OVERLAP test with no
 *              proration, so SEEDRUN-AUG2026 (2026-08-01T00:00:00Z -> 2026-08-31T23:59:59Z, 40
 *              employees, gross 11,50,000) was claimed IN FULL by both the 2026-08 and the 2026-09
 *              close. computeMonthlyTds used the identical predicate for s192, so the same salary
 *              TDS would be computed - and deposited - twice. On the seeded book it read Rs 0 only
 *              because every salary there falls under the s87A rebate, so the tests below use a
 *              salary ABOVE the rebate line and assert the rupees.
 *
 *   FIN-W1-D2  A plain GET of the compliance dashboard MUTATED the database: monthlyCloseView
 *              upserted the snapshot and ran a DELETE-then-INSERT TDS recompute on every read, and
 *              the re-insert hard-coded pan_status='pending_verification', so a PAN verification was
 *              wiped by the next page load.
 *
 *   FIN-W1-D3  Nothing anywhere could set pan_status='verified', and the "close checklist blocks on
 *              unresolved PANs" the module's header claimed did not exist - the checklist had six
 *              items and none was a PAN check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const tds = await importLibModule("tds-governance");
const close = await importLibModule("finance-monthly-close");
const statutory = await importLibModule("statutory-compliance");

const ACTOR = "finance@pawspace.test";
const IST = 330 * 60_000;
/** Rs 1.5L/month = Rs 18L/year: above the s87A rebate, so the double-count is worth rupees. */
const MONTHLY_GROSS = 150_000;
const MONTHLY_TDS = 12_566.67; // newRegimeAnnualTax(18L).totalTax / 12, pinned by statutory-finance-close

/** A D1 that remembers every statement actually EXECUTED, so "a read must not write" is assertable. */
function auditedD1(db) {
  const executed = [];
  const wrap = (statement) => ({
    ...statement,
    bind: (...bound) => wrap(statement.bind(...bound)),
    first: async (...a) => { executed.push(statement.sql); return statement.first(...a); },
    run: async (...a) => { executed.push(statement.sql); return statement.run(...a); },
    all: async (...a) => { executed.push(statement.sql); return statement.all(...a); },
  });
  return {
    executed,
    mutations: () => executed.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i.test(sql)),
    db: { ...db, prepare: (sql) => wrap(db.prepare(sql)), batch: async (list) => { for (const s of list) executed.push(s.sql); return db.batch(list); } },
  };
}

/** The source tables the close and the TDS engine read. DDL copied from the owning modules. */
function closeWorld() {
  const harness = freshCountingD1();
  harness.sqlite.exec(`
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY, idempotency_key TEXT, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, status TEXT NOT NULL, input_snapshot_json TEXT, created_by TEXT, created_at INTEGER);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY, run_id TEXT, employee_id TEXT, gross_earnings REAL);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, scheduled_start TEXT, status TEXT, total_amount REAL);
    CREATE TABLE food_orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, total_amount REAL, created_at INTEGER);
    CREATE TABLE finance_invoices (id TEXT PRIMARY KEY, issue_date TEXT, status TEXT, tax_total REAL);
    CREATE TABLE finance_bills (id TEXT PRIMARY KEY, bill_date TEXT);
    CREATE TABLE finance_vendor_tax_reviews (id TEXT PRIMARY KEY, bill_id TEXT, review_status TEXT, eligible_tax_amount REAL);
  `);
  return harness;
}

/** The two runs the live database actually holds, to the millisecond. */
function seedLivePayroll(sqlite, { employees = 2, gross = MONTHLY_GROSS } = {}) {
  const run = (id, start, end) => sqlite.prepare("INSERT INTO payroll_runs (id,period_start,period_end,status) VALUES (?,?,?,'approved')").run(id, start, end);
  run("SEEDRUN-AUG2026", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 31, 23, 59, 59));
  run("UATD-PAYRUN-1", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 12, 23, 59, 59));
  const result = sqlite.prepare("INSERT INTO employee_payroll_results (id,run_id,employee_id,gross_earnings) VALUES (?,?,?,?)");
  for (let i = 0; i < employees; i += 1) result.run(`RES-SEED-${i}`, "SEEDRUN-AUG2026", `emp-seed-${i}`, gross);
  result.run("RES-UATD-0", "UATD-PAYRUN-1", "emp-uatd-0", gross);
  return { runs: 2, employees: employees + 1, grossTotal: gross * (employees + 1) };
}

// ---------------- FIN-W1-D1: one run, one month ------------------------------------------------

test("D1: a payroll run is attributed to exactly one month - August's run is not September's too", async () => {
  const w = closeWorld();
  const seeded = seedLivePayroll(w.sqlite);

  const august = await close.monthlyCloseView(w.db, { period: "2026-08", actorId: ACTOR });
  const september = await close.monthlyCloseView(w.db, { period: "2026-09", actorId: ACTOR });

  assert.equal(august.payroll.runCount, seeded.runs, "both August runs belong to August");
  assert.deepEqual([...august.payroll.runIds].sort(), ["SEEDRUN-AUG2026", "UATD-PAYRUN-1"]);
  assert.equal(august.payroll.employees, seeded.employees);
  assert.equal(august.payroll.grossTotal, seeded.grossTotal);

  assert.equal(september.payroll.runCount, 0, "SEEDRUN-AUG2026 ends 2026-08-31T23:59:59Z - it is not September's payroll");
  assert.equal(september.payroll.employees, 0);
  assert.equal(september.payroll.grossTotal, 0);
  assert.equal(september.payroll.runStatus, null);
  assert.equal(september.checklist.find((item) => item.key === "payroll_finalised").detail,
    "no payroll run attributed to this month (acceptable for pre-payroll months)");
});

test("D1: the same salary TDS is computed once, not once per month - the money consequence", async () => {
  const w = closeWorld();
  const seeded = seedLivePayroll(w.sqlite);

  const august = await tds.computeMonthlyTds(w.db, { period: "2026-08", actorId: ACTOR });
  const september = await tds.computeMonthlyTds(w.db, { period: "2026-09", actorId: ACTOR });

  const expected = Math.round(MONTHLY_TDS * seeded.employees * 100) / 100;
  assert.equal(august.sections["192"].tds, expected, "August carries the whole s192 liability");
  assert.equal(august.sections["192"].deductees, seeded.employees);
  assert.equal(september.sections["192"], undefined, "September must raise no s192 deduction at all");
  assert.equal(september.totalTds, 0);
  assert.equal(august.totalTds + september.totalTds, expected,
    "the two months together must equal ONE month's liability - anything more is a second deposit of the same tax");

  const persisted = w.sqlite.prepare("SELECT period,COUNT(*) rows FROM tds_deductions GROUP BY period").all();
  assert.deepEqual(persisted.map((row) => [String(row.period), Number(row.rows)]), [["2026-08", seeded.employees]]);
});

test("D1: the close view and computeMonthlyTds agree about whose payroll the month is", async () => {
  const w = closeWorld();
  seedLivePayroll(w.sqlite);
  for (const period of ["2026-08", "2026-09"]) {
    const view = await close.monthlyCloseView(w.db, { period, actorId: ACTOR });
    const computed = await tds.computeMonthlyTds(w.db, { period, actorId: ACTOR, persist: false });
    assert.equal(view.payroll.employees, computed.sections["192"]?.deductees ?? 0,
      `${period}: the payroll the screen shows must be the payroll the TDS engine taxed`);
    assert.equal(view.tds.total, computed.totalTds, `${period}: the close view's TDS must be the computed TDS`);
  }
});

test("D1: the attribution rule is a total, single-valued function of the run, in SQL and in TypeScript", async () => {
  const w = closeWorld();
  // The two boundary conventions this database actually contains: plain UTC (seed/import) and
  // IST-shifted (lib/payroll-engine callers). A boundary-based rule is wrong for one of them.
  const runs = [
    ["UTC-AUG", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 31, 23, 59, 59), "2026-08"],
    ["IST-AUG", Date.UTC(2026, 7, 1) - IST, Date.UTC(2026, 7, 31) - IST, "2026-08"],
    ["UTC-SEP", Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 30, 23, 59, 59), "2026-09"],
    ["IST-SEP", Date.UTC(2026, 8, 1) - IST, Date.UTC(2026, 8, 30) - IST, "2026-09"],
    ["UTC-DEC", Date.UTC(2026, 11, 1), Date.UTC(2026, 11, 31, 23, 59, 59), "2026-12"],
    ["UTC-MAR", Date.UTC(2027, 2, 1), Date.UTC(2027, 2, 31, 23, 59, 59), "2027-03"],
  ];
  for (const [id, start, end] of runs) {
    w.sqlite.prepare("INSERT INTO payroll_runs (id,period_start,period_end,status) VALUES (?,?,?,'approved')").run(id, start, end);
  }
  for (const [id, start, end, expected] of runs) {
    assert.equal(tds.payrollRunPeriod(start, end), expected, `${id}: TypeScript rule`);
  }
  // Every run is claimed by exactly one month - never zero, never two.
  const months = ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"];
  const claims = new Map(runs.map(([id]) => [id, []]));
  for (const month of months) {
    for (const attributed of await tds.payrollRunsForPeriod(w.db, month)) claims.get(attributed.runId).push(month);
  }
  for (const [id, , , expected] of runs) {
    assert.deepEqual(claims.get(id), [expected], `${id} must be claimed by exactly one month`);
  }
});

// ---------------- FIN-W1-D2: a read must not write ----------------------------------------------

test("D2: a plain close view executes no INSERT/UPDATE/DELETE at all", async () => {
  const w = closeWorld();
  seedLivePayroll(w.sqlite);
  const audited = auditedD1(w.db);

  await close.monthlyCloseView(audited.db, { period: "2026-08", actorId: ACTOR });
  await close.monthlyCloseView(audited.db, { period: "2026-08", actorId: ACTOR });

  assert.deepEqual(audited.mutations(), [], "a GET of the compliance dashboard must not write a single row");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM finance_monthly_closes").get().c), 0);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM tds_deductions").get().c), 0);
});

test("D2: repeated views leave an existing snapshot's updated_at exactly where it was", async () => {
  const w = closeWorld();
  seedLivePayroll(w.sqlite);
  await close.ensureMonthlyCloseTables(w.db);
  const stamp = 1_700_000_000_000;
  w.sqlite.prepare("INSERT INTO finance_monthly_closes (period,status,snapshot_json,created_at,updated_at) VALUES ('2026-08','open','{}',?,?)").run(stamp, stamp);

  for (let i = 0; i < 3; i += 1) await close.monthlyCloseView(w.db, { period: "2026-08", actorId: ACTOR });

  const row = w.sqlite.prepare("SELECT status,updated_at FROM finance_monthly_closes WHERE period='2026-08'").get();
  assert.equal(Number(row.updated_at), stamp, "three plain reads moved updated_at - the read is still writing");
  assert.equal(String(row.status), "open");
});

test("D2: closing the month DOES persist - the read-only view must not have broken the lock", async () => {
  const w = closeWorld();
  w.sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','c1','2026-08-10T04:00:00.000Z','confirmed',4500)").run();
  await statutory.recordBoardApproval(w.db, { period: "2026-08", approvedBy: "founder@pawspace.in", approverRole: "founder" });

  const closed = await close.closeMonth(w.db, { period: "2026-08", actorId: ACTOR });
  assert.equal(closed.status, "closed");
  const stored = w.sqlite.prepare("SELECT status,closed_by FROM finance_monthly_closes WHERE period='2026-08'").get();
  assert.equal(String(stored.status), "closed");
  assert.equal(String(stored.closed_by), ACTOR);
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_close_periods WHERE period_code='2026-08'").get().status), "locked");
  const after = await close.monthlyCloseView(w.db, { period: "2026-08", actorId: ACTOR });
  assert.equal(after.status, "closed");
  assert.equal(after.revenue.total, 4500);
});

// ---------------- FIN-W1-D3: the PAN control exists, and it closes ------------------------------

test("D3: a verified PAN survives a page load and a recompute", async () => {
  const w = closeWorld();
  const seeded = seedLivePayroll(w.sqlite);
  await tds.computeMonthlyTds(w.db, { period: "2026-08", actorId: ACTOR });
  const pending = () => Number(w.sqlite.prepare("SELECT COUNT(*) c FROM tds_deductions WHERE period='2026-08' AND pan_status!='verified'").get().c);
  assert.equal(pending(), seeded.employees, "every fresh deduction starts pending");

  const verified = await tds.recordTdsPanVerification(w.db, { deducteeId: "emp-seed-0", pan: "ABCDE1234F", actorId: ACTOR });
  assert.equal(verified.status, "verified");
  assert.equal(verified.deductionRowsUpdated, 1);
  assert.equal(pending(), seeded.employees - 1, "nothing but recordTdsPanVerification can set 'verified' - and it does");

  await close.monthlyCloseView(w.db, { period: "2026-08", actorId: ACTOR });
  await close.monthlyCloseView(w.db, { period: "2026-08", actorId: ACTOR });
  assert.equal(pending(), seeded.employees - 1, "a page load must not undo an operator's PAN verification");

  await tds.computeMonthlyTds(w.db, { period: "2026-08", actorId: ACTOR });
  assert.equal(pending(), seeded.employees - 1, "an explicit recompute must not undo it either");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM tds_deductions WHERE period='2026-08'").get().c), seeded.employees,
    "the recompute is an upsert, not a delete-and-reinsert");
});

test("D3: the close checklist blocks on an unresolved PAN and clears when it is resolved", async () => {
  const w = closeWorld();
  const seeded = seedLivePayroll(w.sqlite, { employees: 1 });
  const period = "2026-08";
  const computed = await tds.computeMonthlyTds(w.db, { period, actorId: ACTOR });
  await tds.recordTdsDeposit(w.db, { period, challanReference: "ITNS-281-0001", amount: computed.totalTds, actorId: ACTOR });
  await statutory.recordBoardApproval(w.db, { period, approvedBy: "founder@pawspace.in", approverRole: "founder" });

  const blocked = await close.monthlyCloseView(w.db, { period, actorId: ACTOR });
  const panItem = blocked.checklist.find((item) => item.key === "tds_pans_verified");
  assert.ok(panItem, "the checklist must actually carry the PAN item the module's header promises");
  assert.equal(panItem.ok, false);
  assert.equal(panItem.value, seeded.employees);
  assert.equal(blocked.status, "open", "an unresolved PAN keeps the month out of 'ready'");
  let refused;
  try { await close.closeMonth(w.db, { period, actorId: ACTOR }); } catch (error) { refused = error; }
  assert.ok(refused instanceof Response, "the close must refuse while a deductee PAN is unverified");
  assert.equal(refused.status, 409);
  assert.match(String((await refused.clone().json()).error), /tds_pans_verified/, "and it must name the PAN item");

  for (const row of w.sqlite.prepare("SELECT DISTINCT deductee_id FROM tds_deductions WHERE period=?").all(period)) {
    await tds.recordTdsPanVerification(w.db, { deducteeId: String(row.deductee_id), pan: "ABCDE1234F", actorId: ACTOR });
  }
  const ready = await close.monthlyCloseView(w.db, { period, actorId: ACTOR });
  assert.equal(ready.checklist.find((item) => item.key === "tds_pans_verified").ok, true);
  assert.equal(ready.status, "ready");
  assert.equal((await close.closeMonth(w.db, { period, actorId: ACTOR })).status, "closed");
});

test("D3: verification refuses a malformed PAN and an unknown deductee, and never stores the PAN", async () => {
  const w = closeWorld();
  seedLivePayroll(w.sqlite, { employees: 1 });
  await tds.computeMonthlyTds(w.db, { period: "2026-08", actorId: ACTOR });

  const refusal = async (input) => {
    try { await tds.recordTdsPanVerification(w.db, input); } catch (error) { return error; }
    return null;
  };
  for (const bad of ["", "ABCDE1234", "abcde1234f1", "12345ABCDE", "ABCDE12345"]) {
    const error = await refusal({ deducteeId: "emp-seed-0", pan: bad, actorId: ACTOR });
    assert.ok(error instanceof Response && error.status === 400, `"${bad}" must be refused as a malformed PAN`);
  }
  const unknown = await refusal({ deducteeId: "emp-nobody", pan: "ABCDE1234F", actorId: ACTOR });
  assert.ok(unknown instanceof Response && unknown.status === 404, "a deductee with no deduction cannot have a PAN verified");

  await tds.recordTdsPanVerification(w.db, { deducteeId: "emp-seed-0", pan: "ABCDE1234F", actorId: ACTOR });
  const registry = w.sqlite.prepare("SELECT * FROM tds_pan_registry WHERE deductee_id='emp-seed-0'").get();
  assert.equal(String(registry.pan_reference), "*****1234F", "only a masked reference is persisted");
  assert.equal(String(registry.verified_by), ACTOR);
  assert.ok(Number(registry.verified_at) > 0);
  assert.equal(JSON.stringify(registry).includes("ABCDE1234F"), false, "the full PAN must never be stored");
});
