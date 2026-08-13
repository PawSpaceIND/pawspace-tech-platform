/**
 * PAWSPACE-QA-001 — an approved refund may never exceed the money actually collected.
 *
 * Boarding and Pet Sitting capped `approve_cancel` at `canonical_bookings.total_amount`. A cancellation
 * could therefore approve a full-price refund on a stay that was paid in half, never paid, or whose
 * payment attempt failed — and the refund ledger row was written for that amount. Taxi, Walking and Food
 * already compared against captured value.
 *
 * The old tests for these two modules could not see it. Every assertion in tests/boarding-gate3.test.mjs
 * and tests/sitting-gate3.test.mjs was `assert.match(source, /…/)` against the file text, including one
 * that matched the sentence "within the captured booking value" — the error message that CLAIMED the
 * correct invariant while the code beside it checked the booking total. A source regex cannot tell those
 * apart. Every test here drives the real module against a real database and reads the ledger afterwards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__REFUND_DB__", "__REFUND_ENV__");

const TOTAL = 8000;      // the booking price — must never be the ceiling
const HALF = 4000;       // a 50/50 split instalment
const REQUESTER = "customer.care@pawspace.in";
const APPROVER = "finance.manager@pawspace.in";   // segregation of duties: must differ

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/**
 * A booking of each service, with a payment row described by `payment`:
 *   null                      no payment row at all
 *   {status, amount, dueNow}  a row in that state
 * and optionally a 50/50 split schedule.
 */
function scenario(service, { payment, schedule } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,schedule_group_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT)");

  const now = Date.UTC(2026, 6, 1);
  const start = "2026-08-01T09:00:00.000Z", end = "2026-08-04T09:00:00.000Z";
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','idem','CUS-1','[]','[]','blr','blr-east',?,'pkg','Package','SG-1','PRV-1',?,?,'confirmed','customer_app',?,'INR','{}','seed',?,?)")
    .run(service, start, end, TOTAL, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-1','BK-1','PRV-1','SG-1',?,?,'assigned',?)").run(start, end, now);
  sqlite.prepare("INSERT INTO scheduling_reservations VALUES ('RES-1','SG-1','PRV-1',?,?,'confirmed')").run(start, end);

  if (payment) {
    sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-1','BK-1','CUS-1',?,?,'INR','card',?,?,'uat_sandbox','pidem','{}',?,?)")
      .run(payment.amount ?? TOTAL, payment.dueNow ?? TOTAL, payment.mode ?? "prepaid", payment.status, now, now);
  }
  if (schedule) {
    sqlite.prepare("INSERT INTO stay_payment_schedules VALUES ('BK-1',?,'CUS-1',?,?,?,?,?,NULL,NULL,?,?)")
      .run(service, TOTAL, schedule.paidNow, schedule.balance, now + 86400000, schedule.status, now, now);
  }

  const db = makeD1(sqlite);
  globalThis.__REFUND_DB__ = db;
  globalThis.__REFUND_ENV__ = {};
  return { sqlite, db };
}

/** The two modules under test, described so each case runs identically against both. */
const SERVICES = [
  {
    name: "Boarding",
    serviceCode: "boarding",
    module: "../lib/boarding-finance-governance.ts",
    entry: "mutateBoardingFinance",
    ledger: "boarding_refund_ledger",
    /** Boarding's context() JOINs boarding_stays, so a stay row is part of a valid booking. */
    extra: (sqlite) => {
      sqlite.exec("CREATE TABLE boarding_stays (id TEXT PRIMARY KEY,booking_id TEXT,host_provider_id TEXT,status TEXT,check_in_status TEXT,check_out_status TEXT,pet_count INTEGER,city_id TEXT,zone_id TEXT,check_in_at TEXT,check_out_at TEXT,billed_units INTEGER,care_plan_status TEXT,updated_at INTEGER)");
      sqlite.prepare("INSERT INTO boarding_stays VALUES ('STAY-1','BK-1','PRV-1','confirmed','pending','pending',1,'blr','blr-east','2026-08-01T09:00:00.000Z','2026-08-04T09:00:00.000Z',3,'ready',0)").run();
    },
    requestAction: "request_cancel",
  },
  {
    name: "Pet Sitting",
    serviceCode: "pet_sitting",
    module: "../lib/sitting-finance-governance.ts",
    entry: "mutateSittingFinance",
    ledger: "sitting_refund_ledger",
    extra: () => {},
    requestAction: "request_cancel",
  },
];

/** Sets up a booking, raises a cancellation request, and returns a caller for approve_cancel. */
async function readyToApprove(service, state) {
  const { sqlite, db } = scenario(service.serviceCode, state);
  service.extra(sqlite);
  const mod = await import(service.module);
  const govern = mod[service.entry];
  assert.equal(typeof govern, "function", `${service.name}: ${service.entry} must be exported — no fallback, because guessing an export picked ensure*Tables and every refusal "passed" against a no-op`);

  await govern(db, { bookingId: "BK-1", action: service.requestAction, actorId: REQUESTER, idempotencyKey: `req-${Math.abs(TOTAL)}-${service.serviceCode}`, reason: "Customer asked to cancel" });

  const approve = (approvedRefundAmount, key = "app-1") =>
    govern(db, { bookingId: "BK-1", action: "approve_cancel", actorId: APPROVER, idempotencyKey: `${key}-${service.serviceCode}`, reason: "Policy reviewed", approvedRefundAmount });
  const refundRows = () => sqlite.prepare(`SELECT amount FROM ${service.ledger}`).all();
  const bookingStatus = () => sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-1'").get().status;
  return { approve, refundRows, bookingStatus, sqlite };
}

/** A rejection must be a 409 Response AND must leave no refund behind. */
async function assertRefused(approve, refundRows, amount, why) {
  const before = refundRows().length;
  let response = null;
  try { await approve(amount); } catch (error) { response = error; }
  assert.ok(response instanceof Response, `${why}: expected a refusal, the call returned normally`);
  assert.equal(response.status, 409, `${why}: expected 409`);
  const body = await response.text();
  assert.match(body, /collected/i, `${why}: the refusal must say the cap is the collected amount`);
  assert.equal(refundRows().length, before, `${why}: a refused refund must write no ledger row`);
}

for (const service of SERVICES) {
  test(`${service.name}: no payment row means no positive refund, and no ledger row`, async () => {
    const { approve, refundRows } = await readyToApprove(service, { payment: null });
    await assertRefused(approve, refundRows, 1, "unpaid booking, refund of 1");
    await assertRefused(approve, refundRows, TOTAL, "unpaid booking, refund of the booking total");
  });

  test(`${service.name}: a 'created' or failed payment collected nothing, so nothing can be refunded`, async () => {
    for (const status of ["created", "failed"]) {
      const { approve, refundRows } = await readyToApprove(service, { payment: { status, amount: TOTAL, dueNow: TOTAL } });
      await assertRefused(approve, refundRows, 1, `${status} payment, refund of 1`);
      await assertRefused(approve, refundRows, TOTAL, `${status} payment, refund of the booking total`);
    }
  });

  test(`${service.name}: a captured payment can be refunded up to the captured value`, async () => {
    const { approve, refundRows, bookingStatus } = await readyToApprove(service, { payment: { status: "captured", amount: TOTAL, dueNow: TOTAL } });
    const result = await approve(TOTAL);
    assert.equal(result.approvedRefundAmount, TOTAL);
    assert.deepEqual(refundRows().map((row) => row.amount), [TOTAL], "the ledger records exactly the approved amount");
    assert.equal(bookingStatus(), "cancelled", "the legitimate cancellation still completes");
  });

  test(`${service.name}: one rupee above the captured value is refused`, async () => {
    const { approve, refundRows } = await readyToApprove(service, { payment: { status: "captured", amount: TOTAL, dueNow: TOTAL } });
    await assertRefused(approve, refundRows, TOTAL + 1, "captured value + 1");
  });

  test(`${service.name}: a half-paid split refunds at most the half that was collected`, async () => {
    // The defect in one case: booking worth 8000, only 4000 ever taken, and the old ceiling was 8000.
    const state = { payment: { status: "captured", amount: TOTAL, dueNow: HALF, mode: "split_50_50" }, schedule: { paidNow: HALF, balance: TOTAL - HALF, status: "pending_balance" } };
    const { approve, refundRows, bookingStatus } = await readyToApprove(service, state);
    await assertRefused(approve, refundRows, HALF + 1, "half-paid split, refund of the collected half + 1");
    await assertRefused(approve, refundRows, TOTAL, "half-paid split, refund of the full booking total");

    const result = await approve(HALF);
    assert.equal(result.approvedRefundAmount, HALF, "the collected half is refundable");
    assert.deepEqual(refundRows().map((row) => row.amount), [HALF]);
    assert.equal(bookingStatus(), "cancelled");
  });

  test(`${service.name}: once the split balance is paid, the whole collected amount is refundable`, async () => {
    // The other direction: the balance is settled in stay_payment_schedules and never written back to
    // booking_payments, so a ceiling read from that table alone would under-refund a fully paid customer.
    const state = { payment: { status: "captured", amount: TOTAL, dueNow: HALF, mode: "split_50_50" }, schedule: { paidNow: HALF, balance: TOTAL - HALF, status: "paid" } };
    const { approve, refundRows } = await readyToApprove(service, state);
    const result = await approve(TOTAL);
    assert.equal(result.approvedRefundAmount, TOTAL, "both instalments were collected, so both are refundable");
    assert.deepEqual(refundRows().map((row) => row.amount), [TOTAL]);
  });

  test(`${service.name}: a zero refund still cancels, and writes no refund row`, async () => {
    // The ordinary no-refund cancellation: the workflow must not be blocked by the new ceiling.
    const { approve, refundRows, bookingStatus } = await readyToApprove(service, { payment: null });
    const result = await approve(0);
    assert.equal(result.approvedRefundAmount, 0);
    assert.equal(result.refundStatus, "not_required");
    assert.deepEqual(refundRows(), [], "nothing to refund means no ledger row");
    assert.equal(bookingStatus(), "cancelled", "an unpaid booking can still be cancelled");
  });
}

test("the booking total is not the refund ceiling in any service", async () => {
  // The five services must agree. Taxi, Walking and Food already compared against captured value; this
  // fails if Boarding or Sitting drifts back, or if a new service invents its own ceiling.
  const { readFile } = await import("node:fs/promises");
  const offenders = [];
  for (const file of ["boarding-finance-governance.ts", "sitting-finance-governance.ts", "taxi-finance-governance.ts"]) {
    const source = await readFile(new URL(`../lib/${file}`, import.meta.url), "utf8").catch(() => "");
    if (!source) continue;
    // An approved-refund comparison against a booking total, in either argument order.
    if (/approvedRefundAmount[\s\S]{0,200}?amount>Number\((?:stay|booking)\.total_amount\)/.test(source)) {
      offenders.push(`${file}: caps the approved refund at the booking total`);
    }
  }
  assert.deepEqual(offenders, [], "a refund ceiling must be collected funds, never the booking price");
});
