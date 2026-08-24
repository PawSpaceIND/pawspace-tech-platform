import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Test-only .ts resolve fallback (registerHooks needs Node >=22.15; CI runs 22.13).
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
  };
}

// ---------------- Salary TDS: exact new-regime FY2025-26 values --------------------------------

test("192: Rs 8L gross is fully rebated (s87A) - zero TDS", async () => {
  const { newRegimeAnnualTax, monthlySalaryTds } = await import("../lib/tds-governance.ts");
  const result = newRegimeAnnualTax(800_000);
  assert.equal(result.taxableIncome, 725_000);
  assert.equal(result.totalTax, 0);
  assert.equal(result.rebateApplied, true);
  assert.equal(monthlySalaryTds(800_000 / 12), 0);
});

test("192: Rs 18L gross pays exactly Rs 1,50,800 (slabs + 4% cess), Rs 12,566.67/month", async () => {
  const { newRegimeAnnualTax, monthlySalaryTds } = await import("../lib/tds-governance.ts");
  const result = newRegimeAnnualTax(1_800_000);
  assert.equal(result.taxableIncome, 1_725_000);
  // 4-8L @5% = 20,000 · 8-12L @10% = 40,000 · 12-16L @15% = 60,000 · 16-17.25L @20% = 25,000
  assert.equal(result.slabTax, 145_000);
  assert.equal(result.cess, 5_800);
  assert.equal(result.totalTax, 150_800);
  assert.equal(monthlySalaryTds(150_000), 12_566.67);
});

test("192: marginal relief just above the 12L rebate line - Rs 12.8L gross pays Rs 5,200, not Rs 63,180", async () => {
  const { newRegimeAnnualTax } = await import("../lib/tds-governance.ts");
  const result = newRegimeAnnualTax(1_280_000); // taxable 12,05,000
  assert.equal(result.taxableIncome, 1_205_000);
  assert.equal(result.marginalReliefApplied, true);
  assert.equal(result.slabTax, 5_000); // capped at the excess over 12,00,000
  assert.equal(result.totalTax, 5_200);
});

// ---------------- 194H / 194J: thresholds and cumulative crossing ------------------------------

function financeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY, period_start INTEGER, period_end INTEGER, status TEXT);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY, run_id TEXT, employee_id TEXT, gross_earnings REAL);
    CREATE TABLE provider_commercial_terms (id TEXT PRIMARY KEY, engagement_model TEXT);
    CREATE TABLE provider_payout_computations (booking_id TEXT PRIMARY KEY, provider_id TEXT, provider_net_payout REAL, computed_at INTEGER, term_id TEXT);
    CREATE TABLE boarding_host_settlement_ledger (booking_id TEXT PRIMARY KEY, provider_id TEXT, payout_amount REAL, eligible_at INTEGER);
  `);
  return { sqlite, db: makeD1(sqlite) };
}
const IST = 330 * 60_000;
const monthMs = (year, month, day = 15) => Date.UTC(year, month - 1, day) - IST;

test("194H: below the Rs 20,000 FY aggregate threshold nothing is deducted; crossing taxes the full cumulative", async () => {
  const { computeMonthlyTds } = await import("../lib/tds-governance.ts");
  const { db, sqlite } = financeDb();
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,engagement_model) VALUES ('term-comm','commission')").run();
  // May: 12,000 commission payout (below threshold)
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-1','host_sana',12000,?, 'term-comm')").run(monthMs(2026, 5));
  const may = await computeMonthlyTds(db, { period: "2026-05", actorId: "test" });
  assert.equal(may.totalTds, 0, "below threshold - no deduction");
  // June: another 10,000 -> FY cumulative 22,000 crosses 20,000 -> whole 22,000 taxed at 2% = 440
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-2','host_sana',10000,?, 'term-comm')").run(monthMs(2026, 6));
  const june = await computeMonthlyTds(db, { period: "2026-06", actorId: "test" });
  assert.equal(june.sections["194H"].base, 22_000);
  assert.equal(june.sections["194H"].tds, 440);
  // July: 5,000 more -> only the month's amount is taxed now (100 at 2%)
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-3','host_sana',5000,?, 'term-comm')").run(monthMs(2026, 7));
  const july = await computeMonthlyTds(db, { period: "2026-07", actorId: "test" });
  assert.equal(july.sections["194H"].base, 5_000);
  assert.equal(july.sections["194H"].tds, 100);
});

test("194J: contract providers deduct 10% after the Rs 50,000 threshold; recompute is idempotent", async () => {
  const { computeMonthlyTds } = await import("../lib/tds-governance.ts");
  const { db, sqlite } = financeDb();
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,engagement_model) VALUES ('term-contract','contract')").run();
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-10','trainer_x',60000,?, 'term-contract')").run(monthMs(2026, 8));
  const first = await computeMonthlyTds(db, { period: "2026-08", actorId: "test" });
  assert.equal(first.sections["194J"].base, 60_000);
  assert.equal(first.sections["194J"].tds, 6_000);
  const again = await computeMonthlyTds(db, { period: "2026-08", actorId: "test" });
  assert.equal(again.sections["194J"].tds, 6_000, "recompute must not double-count");
  const rowCount = sqlite.prepare("SELECT COUNT(*) c FROM tds_deductions WHERE period='2026-08'").get();
  assert.equal(Number(rowCount.c), 1);
});

test("192 from a real payroll run + deposit gating: deposit must equal computed liability", async () => {
  const { computeMonthlyTds, recordTdsDeposit } = await import("../lib/tds-governance.ts");
  const { db, sqlite } = financeDb();
  // Payroll run covering August 2026 with one employee at 1.5L/month (18L annual)
  sqlite.prepare("INSERT INTO payroll_runs VALUES ('run-8', ?, ?, 'approved')").run(monthMs(2026, 8, 1), monthMs(2026, 8, 31));
  sqlite.prepare("INSERT INTO employee_payroll_results VALUES ('res-1','run-8','emp-priya',150000)").run();
  const computed = await computeMonthlyTds(db, { period: "2026-08", actorId: "test" });
  assert.equal(computed.sections["192"].tds, 12_566.67);
  assert.equal(computed.depositDueDate, "2026-09-07");
  await assert.rejects(() => recordTdsDeposit(db, { period: "2026-08", challanReference: "CHL-1", amount: 999, actorId: "test" }), (error) => error instanceof Response && error.status === 409);
  const deposit = await recordTdsDeposit(db, { period: "2026-08", challanReference: "CHL-1", amount: 12_566.67, actorId: "test" });
  assert.equal(deposit.duplicatePrevented, false);
  const retry = await recordTdsDeposit(db, { period: "2026-08", challanReference: "CHL-2", amount: 12_566.67, actorId: "test" });
  assert.equal(retry.duplicatePrevented, true);
});

test("March TDS deposit due date is 30 April (statutory exception)", async () => {
  const { computeMonthlyTds } = await import("../lib/tds-governance.ts");
  const { db } = financeDb();
  const result = await computeMonthlyTds(db, { period: "2027-03", actorId: "test" });
  assert.equal(result.depositDueDate, "2027-04-30");
});

test("quarterly 26Q aggregates non-salary sections for the Indian FY quarter with deposits matched", async () => {
  const { computeMonthlyTds, recordTdsDeposit, prepareTdsQuarterlyReturn, markTdsReturnFiled } = await import("../lib/tds-governance.ts");
  const { db, sqlite } = financeDb();
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,engagement_model) VALUES ('term-comm','commission')").run();
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-20','host_a',30000,?, 'term-comm')").run(monthMs(2026, 7));
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BK-21','host_a',10000,?, 'term-comm')").run(monthMs(2026, 8));
  await computeMonthlyTds(db, { period: "2026-07", actorId: "test" }); // 30,000 * 2% = 600
  await computeMonthlyTds(db, { period: "2026-08", actorId: "test" }); // 10,000 * 2% = 200
  await recordTdsDeposit(db, { period: "2026-07", challanReference: "CHL-JUL", amount: 600, actorId: "test" });
  const prepared = await prepareTdsQuarterlyReturn(db, { fyLabel: "FY2026-27", quarter: 2, form: "26Q", actorId: "test" });
  assert.equal(prepared.totalTds, 800);
  assert.equal(prepared.totalDeposited, 600);
  assert.equal(prepared.fullyDeposited, false);
  await assert.rejects(() => markTdsReturnFiled(db, { fyLabel: "FY2026-27", quarter: 3, form: "26Q", acknowledgementRef: "ACK", actorId: "test" }), (error) => error instanceof Response && error.status === 409, "unprepared quarter cannot be filed");
  const filed = await markTdsReturnFiled(db, { fyLabel: "FY2026-27", quarter: 2, form: "26Q", acknowledgementRef: "TRACES-123", actorId: "test" });
  assert.equal(filed.status, "filed");
});

// ---------------- Statutory calendar: exact Indian due dates -----------------------------------

test("statutory calendar for 2026-08: every Indian due date is exact", async () => {
  const { statutoryObligationsFor } = await import("../lib/statutory-compliance.ts");
  const map = Object.fromEntries(statutoryObligationsFor("2026-08").map((o) => [o.code, o.dueDate]));
  assert.equal(map.gstr1, "2026-09-11");
  assert.equal(map.gstr3b, "2026-09-20");
  assert.equal(map.tds_deposit, "2026-09-07");
  assert.equal(map.epf, "2026-09-15");
  assert.equal(map.esi, "2026-09-15");
  assert.equal(map.professional_tax, "2026-09-20");
  assert.equal(map.board_approval, "2026-09-05");
  assert.equal(map.advance_tax, undefined, "August has no advance tax instalment");
  assert.equal(map.tds_return_26q, undefined, "August is not a quarter end");
});

test("quarter-end and special months attach the right obligations", async () => {
  const { statutoryObligationsFor } = await import("../lib/statutory-compliance.ts");
  const sep = Object.fromEntries(statutoryObligationsFor("2026-09").map((o) => [o.code, o.dueDate]));
  assert.equal(sep.tds_return_24q, "2026-10-31");
  assert.equal(sep.tds_return_26q, "2026-10-31");
  assert.equal(sep.advance_tax, "2026-09-15");
  const march = Object.fromEntries(statutoryObligationsFor("2027-03").map((o) => [o.code, o.dueDate]));
  assert.equal(march.tds_deposit, "2027-04-30", "March deposit exception");
  assert.equal(march.tds_return_24q, "2027-05-31", "Q4 return due 31 May");
  const dec = statutoryObligationsFor("2026-12");
  assert.ok(dec.some((o) => o.code === "gstr9" && o.dueDate === "2026-12-31"));
});

test("reminder sweep raises idempotent finance alerts for due-soon and overdue obligations", async () => {
  const { runStatutoryReminderSweep } = await import("../lib/statutory-compliance.ts");
  const { db, sqlite } = financeDb();
  // asOf 9 Sep 2026: GSTR-1 for August (due 11 Sep) is T-2; TDS deposit for August (due 7 Sep) is overdue.
  const asOf = Date.UTC(2026, 8, 9, 6, 0);
  const sweep = await runStatutoryReminderSweep(db, { asOf });
  assert.ok(sweep.created > 0);
  const overdue = sqlite.prepare("SELECT * FROM staff_alerts WHERE idempotency_key LIKE 'statutory:tds_deposit:2026-08:%'").all();
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].severity, "critical");
  const gstr1 = sqlite.prepare("SELECT * FROM staff_alerts WHERE idempotency_key LIKE 'statutory:gstr1:2026-08:%'").all();
  assert.equal(gstr1.length, 1);
  const again = await runStatutoryReminderSweep(db, { asOf });
  assert.equal(again.created, 0, "same day sweep must not duplicate alerts");
});

// ---------------- Monthly close: real aggregation + board approval + lock ----------------------

function closeDb() {
  const { sqlite, db } = financeDb();
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, scheduled_start TEXT, status TEXT, total_amount REAL);
    CREATE TABLE food_orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, total_amount REAL, created_at INTEGER);
    CREATE TABLE finance_invoices (id TEXT PRIMARY KEY, issue_date TEXT, status TEXT, tax_total REAL);
    CREATE TABLE finance_bills (id TEXT PRIMARY KEY, bill_date TEXT);
    CREATE TABLE finance_vendor_tax_reviews (id TEXT PRIMARY KEY, bill_id TEXT, review_status TEXT, eligible_tax_amount REAL);
  `);
  return { sqlite, db };
}

test("monthly close aggregates real revenue/GST/TDS, blocks without board approval, then locks", async () => {
  const { monthlyCloseView, closeMonth } = await import("../lib/finance-monthly-close.ts");
  const { recordBoardApproval } = await import("../lib/statutory-compliance.ts");
  const { db, sqlite } = closeDb();
  // Real August activity: two bookings (one cancelled - excluded), one food order,
  // GST output 1800 across two invoices, eligible input 300 (one canonical eligible review, one pending).
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','c1','2026-08-10T04:00:00.000Z','confirmed',4500)").run();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-2','c1','2026-08-12T04:00:00.000Z','cancelled',999)").run();
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-1','c1','confirmed',799,?)").run(monthMs(2026, 8));
  sqlite.prepare("INSERT INTO finance_invoices VALUES ('INV-1','2026-08-10','issued',1200)").run();
  sqlite.prepare("INSERT INTO finance_invoices VALUES ('INV-2','2026-08-15','issued',600)").run();
  sqlite.prepare("INSERT INTO finance_bills VALUES ('BILL-1','2026-08-05')").run();
  sqlite.prepare("INSERT INTO finance_bills VALUES ('BILL-2','2026-08-06')").run();
  sqlite.prepare("INSERT INTO finance_vendor_tax_reviews VALUES ('REV-1','BILL-1','eligible',300)").run();
  sqlite.prepare("INSERT INTO finance_vendor_tax_reviews VALUES ('REV-2','BILL-2','review_required',500)").run();

  const view = await monthlyCloseView(db, { period: "2026-08", actorId: "finance@test" });
  assert.equal(view.revenue.total, 5299, "4500 booking + 799 food; cancelled excluded");
  assert.equal(view.gst.outputTax, 1800);
  assert.equal(view.gst.eligibleInputTax, 300, "unreviewed input credit never claimed");
  assert.equal(view.gst.netPayable, 1500);
  assert.equal(view.status, "open", "board approval still pending");

  await assert.rejects(() => closeMonth(db, { period: "2026-08", actorId: "finance@test" }), (error) => error instanceof Response && error.status === 409, "close blocked before board approval");

  const approval = await recordBoardApproval(db, { period: "2026-08", approvedBy: "founder@pawspace.in", approverRole: "founder" });
  assert.equal(approval.duplicatePrevented, false);
  const repeat = await recordBoardApproval(db, { period: "2026-08", approvedBy: "someone@else.in", approverRole: "manager" });
  assert.equal(repeat.duplicatePrevented, true, "one board approval per period");

  const closed = await closeMonth(db, { period: "2026-08", actorId: "finance@test" });
  assert.equal(closed.status, "closed");
  const canonicalLock = sqlite.prepare("SELECT status,locked_by FROM finance_close_periods WHERE period_code='2026-08'").get();
  assert.equal(canonicalLock.status, "locked", "monthly close must lock the canonical period used by GST, payroll and export mutations");
  assert.equal(canonicalLock.locked_by, "finance@test");
  await assert.rejects(() => closeMonth(db, { period: "2026-08", actorId: "finance@test" }), (error) => error instanceof Response && error.status === 409, "locked month cannot re-close");

  // The locked snapshot survives new data: a late booking must NOT change the closed numbers.
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-LATE','c1','2026-08-20T04:00:00.000Z','confirmed',9999)").run();
  const afterLock = await monthlyCloseView(db, { period: "2026-08", actorId: "finance@test" });
  assert.equal(afterLock.status, "closed");
  assert.equal(afterLock.revenue.total, 5299, "locked snapshot is immutable");
});

// ---------------- Contracts --------------------------------------------------------------------

test("route + gateway + scheduler wiring contracts", () => {
  const route = read("app/api/statutory-compliance/route.ts");
  assert.match(route, /cloudflare:workers/);
  assert.doesNotMatch(route, /globalThis/);
  assert.match(route, /authorize\(request,"finance\.view"\)/);
  assert.match(route, /authorize\(request,"finance\.manage"\)/);
  const gateway = read("lib/api-gateway.ts");
  assert.match(gateway, /if\(url\.pathname==="\/api\/statutory-compliance"\)return method==="GET"\?"finance\.view":"finance\.manage";/);
  const scheduler = read("lib/background-scheduler.ts");
  assert.match(scheduler, /runStatutoryReminderSweep\(db,\{asOf\}\)/);
  assert.match(scheduler, /"statutoryReminders"/);
  const page = read("app/team/finance-compliance/page.tsx");
  assert.match(page, /"use client"/);
  assert.match(page, /statutory-compliance/);
});
