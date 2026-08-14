import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// What counts as revenue in the monthly close the board approves.
//
// The filter was `status NOT IN ('cancelled','refunded')`, and the result was labelled Revenue. Two
// problems in one line. It counted work that had been booked and not yet delivered - 58% of the figure
// on the seeded data - and, being a DENYLIST of two, it counted every status the product had grown
// since: a booking the customer never confirmed (draft, pending), one the provider never accepted
// (awaiting_host_acceptance, awaiting_acceptance), and one where nobody turned up (no_show).
//
// Founder's decision on task #37: report delivered and committed as separate figures, and exclude the
// four that are not revenue on any basis.
//
// The whole suite passed both before and after that change, which is the more useful finding: the
// definition of a board-approved number could move by 58% without a single test noticing. It could not
// notice - the one assertion on this figure checked a total that happens to be unaffected when
// `confirmed` moves from "revenue" to "committed". So these tests assert the SPLIT and each excluded
// status by name, and the last one guards the class rather than the instance.
// ---------------------------------------------------------------------------
installWorkersHooks("__MCRR_DB__", "__MCRR_ENV__");

const IST = 330 * 60 * 1000;
const dayInAugust = (day) => `2026-08-${String(day).padStart(2, "0")}T04:00:00.000Z`;
const augustMs = (day = 15) => Date.UTC(2026, 7, day) - IST;

function closeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY, period_start INTEGER, period_end INTEGER, status TEXT);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY, run_id TEXT, employee_id TEXT, gross_earnings REAL);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, scheduled_start TEXT, status TEXT, total_amount REAL);
    CREATE TABLE food_orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, total_amount REAL, created_at INTEGER);
    CREATE TABLE finance_invoices (id TEXT PRIMARY KEY, issue_date TEXT, status TEXT, tax_total REAL);
    CREATE TABLE finance_bills (id TEXT PRIMARY KEY, bill_date TEXT);
    CREATE TABLE finance_vendor_tax_reviews (id TEXT PRIMARY KEY, bill_id TEXT, review_status TEXT, eligible_tax_amount REAL);
  `);
  const db = createD1(sqlite);
  globalThis.__MCRR_DB__ = db;
  globalThis.__MCRR_ENV__ = {};
  return { sqlite, db };
}

const booking = (sqlite, id, status, amount, day = 10) =>
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?,?)").run(id, "c1", dayInAugust(day), status, amount);

const view = async (db) => {
  const { monthlyCloseView } = await import("../lib/finance-monthly-close.ts");
  return monthlyCloseView(db, { period: "2026-08", actorId: "finance@test" });
};

test("delivered work and work merely booked are reported as separate figures", async () => {
  const { sqlite, db } = closeDb();
  booking(sqlite, "BK-DONE", "completed", 5000);
  booking(sqlite, "BK-BOOKED", "confirmed", 4000);
  booking(sqlite, "BK-RUNNING", "in_progress", 1000);

  const close = await view(db);

  assert.equal(close.revenue.delivered, 5000, "only completed work is delivered revenue");
  assert.equal(close.revenue.deliveredCount, 1);
  assert.equal(close.revenue.committed, 5000, "confirmed + in_progress are committed, not earned");
  assert.equal(close.revenue.committedCount, 2);
  assert.equal(close.revenue.total, 10000, "the total is the sum of the two, and says so");
});

test("a booking nobody confirmed, nobody accepted, or nobody turned up for is not revenue", async () => {
  const { sqlite, db } = closeDb();
  booking(sqlite, "BK-DONE", "completed", 5000);
  // Each of these was counted as revenue before. Named individually so a failure says which one came back.
  const excluded = {
    draft: 1111,
    pending: 2222,
    awaiting_host_acceptance: 3333,
    awaiting_acceptance: 4444,
    no_show: 5555,
    cancelled: 6666,
    refunded: 7777,
  };
  let day = 11;
  for (const [status, amount] of Object.entries(excluded)) booking(sqlite, `BK-${status}`, status, amount, day++);

  const close = await view(db);

  assert.equal(close.revenue.delivered, 5000, `delivered must be the completed booking alone, not ${close.revenue.delivered}`);
  assert.equal(close.revenue.committed, 0, `nothing above is committed revenue, got ${close.revenue.committed}`);
  assert.equal(close.revenue.total, 5000, `total must ignore all seven, got ${close.revenue.total}`);
});

test("the closed snapshot records both figures, so a closed period cannot be reinterpreted later", async () => {
  const { sqlite, db } = closeDb();
  const { closeMonth } = await import("../lib/finance-monthly-close.ts");
  const { recordBoardApproval } = await import("../lib/statutory-compliance.ts");
  booking(sqlite, "BK-DONE", "completed", 5000);
  booking(sqlite, "BK-BOOKED", "confirmed", 4000);
  await recordBoardApproval(db, { period: "2026-08", approvedBy: "founder@test", approverRole: "founder", minutesReference: "BM-2026-08", resolutionText: "August close approved" });

  await closeMonth(db, { period: "2026-08", actorId: "finance@test" });

  const row = sqlite.prepare("SELECT snapshot_json FROM finance_monthly_closes WHERE period='2026-08'").get();
  const snapshot = JSON.parse(String(row.snapshot_json));
  // snapshot_json freezes the whole view, so the split is preserved per stream. A snapshot holding one
  // combined number could not answer "how much of that had we actually delivered?" after the fact, which
  // is exactly the question this change exists to make answerable.
  assert.equal(snapshot.revenue.delivered, 5000);
  assert.equal(snapshot.revenue.committed, 4000);
  assert.equal(snapshot.revenue.total, 9000);
  assert.equal(snapshot.status, "closed", "the frozen snapshot records the period as closed");
});

test("a status invented tomorrow does not become revenue on its own", async () => {
  // The guard for the class, not the instance. The original defect was not that no_show was counted -
  // it was that the filter was a denylist, so EVERY status added to the product became revenue by
  // default, silently, and nobody had to decide. An allowlist means a new status contributes nothing
  // until someone puts it in one of the two buckets on purpose.
  const { sqlite, db } = closeDb();
  booking(sqlite, "BK-DONE", "completed", 5000);
  booking(sqlite, "BK-FUTURE", "awaiting_vet_clearance", 9999);

  const close = await view(db);

  assert.equal(
    close.revenue.total, 5000,
    "an unrecognised status was counted as revenue without anyone deciding it should be. Add it to DELIVERED or COMMITTED in lib/finance-monthly-close.ts deliberately, or leave it out.",
  );
});

test("food orders split on their own terminal status, and their totals are unchanged", async () => {
  const { sqlite, db } = closeDb();
  // Food carries a different vocabulary (reserved, picked, packed, revoked, ops_review_required...).
  // The four booking statuses excluded above were a decision about BOOKING statuses and are NOT applied
  // here, so which food rows count is exactly as before - only the presentation splits.
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-DONE','c1','delivered',800,?)").run(augustMs(10));
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-PACKED','c1','packed',600,?)").run(augustMs(11));
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-GONE','c1','cancelled',999,?)").run(augustMs(12));

  const close = await view(db);

  assert.equal(close.revenue.delivered, 800, "a delivered food order is delivered revenue");
  assert.equal(close.revenue.committed, 600, "packed is committed - still not delivered");
  assert.equal(close.revenue.foodOrders, 1400, "cancelled stays excluded, as it always was");
  assert.equal(close.revenue.total, 1400);
});
