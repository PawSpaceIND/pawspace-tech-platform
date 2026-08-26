/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — reporting truth.
 *
 * Both defects here are the same shape as the GST one already fixed in the monthly close: a figure
 * summed from a state that the workflow which actually moves the money never writes, so the report is
 * structurally wrong and looks healthy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_W2BR_DB__", "__PTJA_W2BR_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_W2BR_DB__ = db;
  globalThis.__PTJA_W2BR_ENV__ = env;
  return { sqlite, db };
}

/** One Rs 5,000 grooming booking in 2026-08, captured, with a refund case in the given state. */
function refundedMonth(refundStatus) {
  const { sqlite, db } = world();
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,city_id TEXT,zone_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',scheduled_start TEXT,scheduled_end TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL DEFAULT 0,method TEXT,mode TEXT,status TEXT NOT NULL,idempotency_key TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
`);
  const august = Date.UTC(2026, 7, 12);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,zone_id,provider_id,status,total_amount,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('BKG-1','CUS-1','grooming','blr','blr-east','PRV-1','completed',5000,'2026-08-12T09:00:00.000Z','2026-08-12T11:00:00.000Z',?,?)").run(august, august);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES ('PAY-1','BKG-1','CUS-1',5000,5000,'upi','prepaid','captured','k-1',?,?)").run(august, august);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,created_at,updated_at) VALUES ('RC-1','BKG-1','PAY-1',5000,'Groomer no-show, full refund',?,'ops@pawspace.test','fin@pawspace.test',?,?)").run(refundStatus, august, august);
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-W2B-R02 — Unit Economics counts refunds only at status='processed', which the governed staff
// refund workflow never reaches
//
// lib/unit-economics.ts matched the literal 'processed'. That value is written ONLY by the Razorpay
// refund.processed webhook path. The cross-vertical STAFF refund workflow in
// app/api/booking-operations declares its state machine as
//   {requested:[approved,rejected], approved:[processing], processing:[completed]}
// and terminates at 'completed' - a value unit-economics never matched.
//
// MEASURED: a refund driven end to end through the real ops workflow to its terminal 'completed' state.
// GET /api/unit-economics reported company {gmv:5000, refunds:0, contributionKnown:5000} and
// services.grooming {contributionPctOfGmv:100} - the service reported at 100% contribution margin when
// its true known contribution was zero. Relabelling the same row 'processed' swung the full Rs 5,000,
// so the entire figure turned on a status string the workflow cannot produce.
//
// A vertical with heavy manual refunds therefore looks like the most profitable one on the board. The
// correction counts the states that mean money actually moved, which is the same set the refund ceiling
// in app/api/grooming-payment-sandbox already uses. No new accounting rule is introduced.
// =====================================================================================================

async function unitEconomics(sqlite, db) {
  const loaded = await import("../lib/unit-economics.ts");
  const entry = loaded.buildUnitEconomics;
  assert.equal(typeof entry, "function", `unit-economics must export a computation: ${Object.keys(loaded)}`);
  return entry(db, { from: "2026-08-01", to: "2026-08-31" });
}

test("W2B-R02: a refund completed through the staff workflow is counted", async () => {
  const { sqlite, db } = refundedMonth("completed");
  const report = await unitEconomics(sqlite, db);
  assert.equal(Number(report.company.refunds), 5000,
    `a completed refund is money that left the business: ${JSON.stringify(report.company)}`);
  assert.equal(Number(report.company.contributionKnown), 0,
    "so known contribution on a fully refunded month is zero, not the gross");
});

test("W2B-R02: the gateway's own terminal state is still counted, and an unapproved request is not", async () => {
  // Non-vacuity in both directions: the pre-existing 'processed' path must keep working, and a refund
  // nobody approved must not be treated as money that moved.
  const processed = refundedMonth("processed");
  const processedReport = await unitEconomics(processed.sqlite, processed.db);
  assert.equal(Number(processedReport.company.refunds), 5000, "the gateway's 'processed' still counts");

  const requested = refundedMonth("requested");
  const requestedReport = await unitEconomics(requested.sqlite, requested.db);
  assert.equal(Number(requestedReport.company.refunds), 0,
    `a refund still awaiting approval has moved no money: ${JSON.stringify(requestedReport.company)}`);
  assert.equal(Number(requestedReport.company.contributionKnown), 5000, "so contribution is unaffected");
});

// =====================================================================================================
// PTJA-W2B-R03 — P&L turnover and nett profit never subtract refunds
//
// Revenue is the gross booking amount and nothing is ever deducted from it:
//   SELECT service_code,scheduled_start,total_amount FROM canonical_bookings WHERE status!='cancelled'
// The only other input is the expense side, matched against expenseChartOfAccounts whose codes are all
// 6xxx - so even a posted contra-revenue journal could not appear there. And the refund path posts no
// journal at all: finance_journal_entries was empty after a completed refund.
//
// MEASURED: a Rs 5,000 booking refunded IN FULL through the real governed workflow. GET
// /api/pnl-reporting?from=2026-08&to=2026-08 returned totalTurnover {"2026-08":5000} and nettProfit
// {"2026-08":5000} - Rs 5,000 of turnover and Rs 5,000 of profit for a month whose only transaction was
// refunded in full, with no refund, contra-revenue or cancellation line anywhere in the response. This
// is the statutory-style report a founder or an investor reads, and it feeds the monthly close, so a
// closed month freezes the overstated figure.
//
// The platform has ALREADY decided refunds are contra-revenue: lib/finance-accounts.ts defines
// REFUNDS: "4900-Refunds and Cancellations" as exactly that. The report simply never read them. This
// adds that line, taken from booking_refund_cases in the same states unit-economics counts, so the two
// surfaces agree on what "refunded" means.
//
// Bucketed by the month the refund was RECORDED, not the month of the original booking. Attributing it
// backwards would retroactively change a month that Finance may have closed and locked - the very
// divergence W2-08-F03 exists to stop - and the platform's own remedy for a post-close correction is
// "post corrections in the next open period".
// =====================================================================================================

async function pnl(db) {
  const loaded = await import("../lib/pnl-reporting.ts");
  return loaded.generatePnlReport(db, { fromMonth: "2026-08", toMonth: "2026-08" });
}

test("W2B-R03: a fully refunded month does not report the gross as turnover and profit", async () => {
  const { db } = refundedMonth("completed");
  const report = await pnl(db);
  assert.equal(Number(report.totalTurnover["2026-08"]), 0,
    `turnover must be net of the refund: ${JSON.stringify(report.totalTurnover)}`);
  assert.equal(Number(report.nettProfit["2026-08"]), 0,
    `and so must nett profit: ${JSON.stringify(report.nettProfit)}`);
  const refundLine = report.revenue.lines.find((line) => String(line.code).startsWith("4900"));
  assert.ok(refundLine, `the report must show the refund as its own contra-revenue line: ${JSON.stringify(report.revenue.lines.map((l) => l.code))}`);
  assert.equal(Number(refundLine.monthly["2026-08"]), -5000, "carrying the refund as a negative");
});

test("W2B-R03: an unrefunded month is unchanged, and an unapproved request deducts nothing", async () => {
  // Non-vacuity in both directions.
  const clean = refundedMonth("rejected");
  const cleanReport = await pnl(clean.db);
  assert.equal(Number(cleanReport.totalTurnover["2026-08"]), 5000,
    `a rejected refund deducts nothing: ${JSON.stringify(cleanReport.totalTurnover)}`);

  const pending = refundedMonth("requested");
  const pendingReport = await pnl(pending.db);
  assert.equal(Number(pendingReport.totalTurnover["2026-08"]), 5000,
    "and neither does one still awaiting approval");
});

// =====================================================================================================
// PTJA-W2B-R05 — Company Analytics silently drops the whole final day of any explicit date window
//
// buildCompanyAnalytics filters `scheduled_start>=? AND scheduled_start<?` binding the raw `to` value.
// scheduled_start is a full ISO timestamp ('2026-08-31T09:00:00.000Z') while `to` is a date-only string
// ('2026-08-31'), so the string comparison '2026-08-31T09:00:00.000Z' < '2026-08-31' is FALSE and every
// booking on the closing date is excluded.
//
// MEASURED: three completed Rs 1,000 grooming bookings on 1, 15 and 31 August, asked of three surfaces
// for the same calendar month. company-analytics reported bookings.total 2 and gmv 2000, while
// unit-economics reported gmv 3000 and the P&L reported turnover 3000. The 31 August booking exists and
// is completed; only company-analytics could not see it.
//
// The sibling report already does this correctly: lib/unit-economics.ts compares
// substr(scheduled_start,1,10) against date-only bounds, inclusive at both ends. That is applied here.
// =====================================================================================================

test("W2B-R05: a booking on the closing date of the window is counted", async () => {
  const { sqlite, db } = world();
  const analytics = await import("../lib/company-analytics.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,city_id TEXT,zone_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',scheduled_start TEXT,scheduled_end TEXT,created_at INTEGER,updated_at INTEGER)");
  for (const [id, day] of [["BK-1", "01"], ["BK-15", "15"], ["BK-31", "31"]]) {
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,city_id,zone_id,provider_id,status,total_amount,currency,scheduled_start,scheduled_end,created_at,updated_at) VALUES (?,?,'grooming','dog-basic','blr','blr-east','PRV-1','completed',1000,'INR',?,?,?,?)")
      .run(id, `CUS-${id}`, `2026-08-${day}T09:00:00.000Z`, `2026-08-${day}T11:00:00.000Z`, Date.UTC(2026, 7, Number(day)), Date.UTC(2026, 7, Number(day)));
  }

  const report = await analytics.buildCompanyAnalytics(db, { from: "2026-08-01", to: "2026-08-31" });
  assert.equal(Number(report.bookings.total), 3,
    `every booking in the window counts, including the closing date: ${JSON.stringify(report.bookings)}`);
  assert.equal(Number(report.money.gmv), 3000,
    `and so does its value: ${JSON.stringify(report.money)}`);
});

test("W2B-R05: the window still excludes what falls outside it", async () => {
  // Non-vacuity. Widening the bound until everything matches would satisfy the case above.
  const { sqlite, db } = world();
  const analytics = await import("../lib/company-analytics.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,city_id TEXT,zone_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',scheduled_start TEXT,scheduled_end TEXT,created_at INTEGER,updated_at INTEGER)");
  for (const [id, date] of [["BK-JUL", "2026-07-31"], ["BK-AUG", "2026-08-15"], ["BK-SEP", "2026-09-01"]]) {
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,city_id,zone_id,provider_id,status,total_amount,currency,scheduled_start,scheduled_end,created_at,updated_at) VALUES (?,?,'grooming','dog-basic','blr','blr-east','PRV-1','completed',1000,'INR',?,?,0,0)")
      .run(id, `CUS-${id}`, `${date}T09:00:00.000Z`, `${date}T11:00:00.000Z`);
  }

  const report = await analytics.buildCompanyAnalytics(db, { from: "2026-08-01", to: "2026-08-31" });
  assert.equal(Number(report.bookings.total), 1,
    `only August counts: ${JSON.stringify(report.bookings)}`);
});
