/**
 * Owner decision 2026-09-22 — a customer may cancel a Boarding reservation they have not paid for.
 *
 * Before this, every customer cancellation raised a `policy_review_required` request and stopped there,
 * whatever the booking's payment state. For a reservation nobody had paid for that was not a policy
 * decision at all — there was no money to decide about — but the stay stayed open, the host's capacity
 * stayed locked against a booking that was never happening, and only Customer Care could release it.
 *
 * What must stay true while that is fixed, and is what these tests actually assert:
 *   - nothing is captured, and no refund ledger row is ever written on this path;
 *   - the capacity lock and the scheduling reservation are released, or the fix has not fixed anything;
 *   - a booking that HAS taken money still goes to policy review, so the refund ceiling and the
 *     segregation of duties in approve_cancel still decide it;
 *   - a stay that has already been checked in is NOT a reservation. It reads as unpaid right up to its
 *     last day under pay-after-service, and cancelling one is an Operations incident — approve_cancel
 *     refuses it, so the customer path must not route around that refusal.
 *
 * These run the real module against a real database and read the rows back afterwards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_CANCEL_DB__", "__BOARDING_CANCEL_ENV__");

const TOTAL = 6000;
const CUSTOMER = "CUS-1";
const START = "2026-08-01T09:00:00.000Z";
const END = "2026-08-04T09:00:00.000Z";

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
 * A Boarding reservation with a held capacity lock and a scheduling reservation.
 * `payment` null means no payment row at all; `stayStatus`/`checkIn` move the stay along its lifecycle.
 */
async function reservation({ payment = null, stayStatus = "confirmed", checkIn = "pending" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE boarding_stays (id TEXT PRIMARY KEY,booking_id TEXT,host_provider_id TEXT,status TEXT,check_in_status TEXT,check_out_status TEXT,pet_count INTEGER,city_id TEXT,zone_id TEXT,check_in_at TEXT,check_out_at TEXT,billed_units INTEGER,care_plan_status TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT)");

  const now = Date.UTC(2026, 6, 1);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','idem',?,'[]','[]','blr','blr-east','boarding','pkg','Package','SG-1','PRV-1',?,?,'confirmed','customer_app',?,'INR','{}','seed',?,?)")
    .run(CUSTOMER, START, END, TOTAL, now, now);
  sqlite.prepare("INSERT INTO boarding_stays VALUES ('STAY-1','BK-1','PRV-1',?,?,'pending',1,'blr','blr-east',?,?,3,'ready',?)")
    .run(stayStatus, checkIn, START, END, now);
  sqlite.prepare("INSERT INTO scheduling_reservations VALUES ('RES-1','SG-1','PRV-1',?,?,'confirmed')").run(START, END);

  const db = makeD1(sqlite);
  globalThis.__BOARDING_CANCEL_DB__ = db;
  globalThis.__BOARDING_CANCEL_ENV__ = {};

  const mod = await import("../lib/boarding-finance-governance.ts");
  assert.equal(typeof mod.mutateBoardingFinance, "function", "mutateBoardingFinance must be exported");
  // The lifecycle tables (boarding_capacity_locks among them) are created by the module itself, so the
  // held lock has to be written after it has built them — not by a hand-copied CREATE TABLE here that
  // could drift from the real schema.
  await mod.ensureBoardingFinanceTables(db);
  sqlite.prepare("INSERT INTO boarding_capacity_locks VALUES ('STAY-1','BK-1','PRV-1',?,?,1,'FAM-1','active',?,?)").run(START, END, now, now);
  if (payment) {
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES ('PAY-1','BK-1',?,?,?,'INR','card',?,?,'uat_sandbox','pidem','{}',?,?)")
      .run(CUSTOMER, TOTAL, payment.dueNow ?? TOTAL, payment.mode ?? "prepaid", payment.status, now, now);
  }

  const cancel = (key = "req-1") => mod.mutateBoardingFinance(db, { bookingId: "BK-1", action: "request_cancel", actorId: CUSTOMER, idempotencyKey: key, reason: "Our plans changed; please cancel this reservation." });
  const one = (sql) => sqlite.prepare(sql).get();
  const count = (sql) => sqlite.prepare(sql).get().n;
  return { sqlite, db, cancel, one, count };
}

test("a customer cancels an unpaid Boarding reservation outright, and the host's capacity is released", async () => {
  const { cancel, one } = await reservation({ payment: null });

  const result = await cancel();

  assert.equal(result.status, "cancelled", "the reservation is cancelled, not filed for review");
  assert.equal(result.bookingPreserved, false);
  assert.equal(result.capacityReleased, true);
  assert.equal(one("SELECT status FROM canonical_bookings WHERE id='BK-1'").status, "cancelled");
  assert.equal(one("SELECT status FROM boarding_stays WHERE id='STAY-1'").status, "cancelled");
  assert.equal(one("SELECT status FROM boarding_capacity_locks WHERE stay_id='STAY-1'").status, "released", "a lock left active keeps the host blocked for a stay that is not happening");
  assert.equal(one("SELECT status FROM scheduling_reservations WHERE id='RES-1'").status, "cancelled");
  assert.equal(one("SELECT status FROM boarding_cancellation_requests WHERE booking_id='BK-1'").status, "cancelled");
});

test("cancelling an unpaid Boarding reservation moves no money", async () => {
  const { cancel, count, one } = await reservation({ payment: { status: "created" } });

  const result = await cancel();

  assert.equal(result.status, "cancelled", "a payment that was never captured collected nothing");
  assert.equal(result.approvedRefundAmount, 0);
  assert.equal(result.refundId, null);
  assert.equal(result.refundStatus, "not_required", "there is nothing to refund, and the customer is told exactly that");
  assert.equal(count("SELECT COUNT(*) n FROM boarding_refund_ledger"), 0, "no refund obligation may be created where no money was taken");
  assert.equal(one("SELECT status FROM booking_payments WHERE booking_id='BK-1'").status, "created", "the cancellation must not capture the pending payment");
});

test("a Boarding booking that has taken money still goes to policy review", async () => {
  // Non-vacuity: this is the same customer action on the same route. If it also cancelled outright, the
  // refund ceiling and the segregation of duties in approve_cancel would have been routed around.
  const { cancel, one, count } = await reservation({ payment: { status: "captured" } });

  const result = await cancel();

  assert.equal(result.status, "policy_review_required", "a paid stay is a refund decision, and refund decisions belong to Finance");
  assert.equal(result.bookingPreserved, true);
  assert.equal(one("SELECT status FROM canonical_bookings WHERE id='BK-1'").status, "confirmed", "the booking stands until the refund is decided");
  assert.equal(one("SELECT status FROM boarding_capacity_locks WHERE stay_id='STAY-1'").status, "active");
  assert.equal(count("SELECT COUNT(*) n FROM boarding_refund_ledger"), 0);
});

test("a Boarding stay that has already been checked in is not a reservation the customer can close", async () => {
  // A pay-after-service or unsettled stay reads as unpaid right up to its last day. approve_cancel
  // refuses an in-progress stay and sends it to an Operations incident workflow; the customer path must
  // reach the same refusal rather than releasing a stay that is being delivered, at zero liability.
  const { cancel, one } = await reservation({ payment: null, stayStatus: "in_progress", checkIn: "complete" });

  const result = await cancel();

  assert.equal(result.status, "policy_review_required", "a stay in progress is an Operations decision, whatever its payment state");
  assert.equal(one("SELECT status FROM canonical_bookings WHERE id='BK-1'").status, "confirmed");
  assert.equal(one("SELECT status FROM boarding_stays WHERE id='STAY-1'").status, "in_progress", "the stay being delivered must not be closed out from under the host");
  assert.equal(one("SELECT status FROM boarding_capacity_locks WHERE stay_id='STAY-1'").status, "active");
});

test("a completed Boarding stay is still refused outright", async () => {
  const { cancel } = await reservation({ payment: null, stayStatus: "completed", checkIn: "complete" });
  let refusal = null;
  try { await cancel(); } catch (error) { refusal = error; }
  assert.ok(refusal instanceof Response, "expected a refusal, the call returned normally");
  assert.equal(refusal.status, 409);
});
