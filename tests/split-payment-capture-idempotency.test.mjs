/**
 * PAWSPACE-PAY-002 — a gateway capture is idempotent per CAPTURE, and a split settles only after two
 * genuinely distinct collections.
 *
 * This file exists because the previous attempt at the same fix was wrong in two ways that its own
 * tests could not see. Both are preserved here as the leading cases.
 *
 *   F1  The balance instalment was inferred from `amount == balance_amount`. The default split is
 *       total/2, so on an Rs 8,000 stay the first instalment and the balance are BOTH Rs 4,000 and that
 *       comparison cannot tell them apart: a second Rs 4,000 capture closed the schedule with half the
 *       money collected, after which the balance could never be charged. The earlier test passed only
 *       because it used an asymmetric 4,000/6,000 split, where the comparison happens to work.
 *
 *   F2  Booking-level truth was written into `expected_amount`, the very column the per-capture
 *       variance check reads. Razorpay sends `payment.captured` AND `order.paid` for one payment, with
 *       different event ids, so the second notification was compared against the Rs 8,000 booking and
 *       raised a false `capture_amount_mismatch` on every split booking.
 *
 * So the identity that matters is the gateway payment, not the webhook event, and the settle counts
 * distinct collected captures instead of guessing from an amount. Every case below drives the real
 * `processGatewayEvent`; the gateway is never called.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAYIDEM_DB__", "__PAYIDEM_ENV__");

/** The DEFAULT split: splitPaymentPlan halves the total, so both stages are the same figure. */
const PRICE = 8000, FIRST = 4000, BALANCE = 4000;

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

function seed({ paidNow = FIRST, balance = BALANCE, split = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAYIDEM_DB__ = db;
  globalThis.__PAYIDEM_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const now = Date.UTC(2026, 7, 1);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}')");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,idempotency_key TEXT UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount) VALUES ('BK','CUS','boarding','confirmed',?)").run(paidNow + balance);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES ('PAY','BK','CUS',?,?,'INR','upi',?,'created','razorpay','k',?,?)")
    .run(paidNow + balance, split ? paidNow : paidNow + balance, split ? "split_50_50" : "prepaid", now, now);
  if (split) sqlite.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES ('BK','boarding','CUS',?,?,?,?, 'pending_balance',?,?)")
    .run(paidNow + balance, paidNow, balance, now + 20 * 86_400_000, now, now);
  else sqlite.exec("DROP TABLE stay_payment_schedules");
  return { sqlite, db };
}

/**
 * A verified capture notification. `paymentRef` is the GATEWAY PAYMENT id: two notifications for one
 * payment share it while carrying different event ids, which is the whole point of these cases.
 */
const notify = ({ eventId, rupees, paymentRef, orderRef = "order_1", eventType = "payment.captured" }) => ({
  provider: "razorpay", environment: "sandbox", eventId, eventType, bookingId: "BK",
  gatewayOrderId: orderRef, gatewayPaymentId: paymentRef,
  amountSubunits: Math.round(rupees * 100), currency: "INR", signatureVerified: true, payloadHash: `h_${eventId}`,
});

const recon = (sqlite) => sqlite.prepare("SELECT expected_amount,captured_amount,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='PAY'").get();
const sched = (sqlite) => sqlite.prepare("SELECT status,payment_ref FROM stay_payment_schedules WHERE booking_id='BK'").get();
const exceptions = (sqlite) => sqlite.prepare("SELECT exception_type FROM payment_reconciliation_exceptions").all().map((row) => row.exception_type);

async function openOrder(db, orderId, amount) {
  const { linkGatewayOrder } = await import("../lib/grooming-payment-reconciliation.ts");
  return linkGatewayOrder(db, { bookingId: "BK", gatewayOrderId: orderId, environment: "sandbox", actorId: "test", expectedAmount: amount });
}

test("cases 1-3: payment.captured + order.paid for ONE payment collect once, with no exception", async () => {
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");

  await openOrder(db, "order_first", FIRST);
  const first = await processGatewayEvent(db, notify({ eventId: "evt_captured", rupees: FIRST, paymentRef: "pay_A" }));
  // Same underlying payment, second notification type, different event id.
  const second = await processGatewayEvent(db, notify({ eventId: "evt_orderpaid", rupees: FIRST, paymentRef: "pay_A", eventType: "order.paid" }));

  console.error(`first=${JSON.stringify(first.status)} second=${JSON.stringify({ status: second.status, reason: second.reason })} captured=${recon(sqlite).captured_amount} schedule=${sched(sqlite).status} exceptions=${JSON.stringify(exceptions(sqlite))}`);
  assert.equal(second.status, "processed", "the repeat notification is accepted, not failed");
  assert.equal(second.reason, "capture_already_collected", "and recognised as money already collected");
  assert.equal(Number(recon(sqlite).captured_amount), FIRST, "case 3: still only Rs 4,000 collected");
  assert.equal(sched(sqlite).status, "pending_balance", "case 3: the balance is still owed");
  assert.deepEqual(exceptions(sqlite), [], "case 3: and NO finance exception was raised - this is F2");
  assert.equal(recon(sqlite).reconciliation_status, "partially_captured");
});

test("case 4: a fresh event id for the same underlying capture is still idempotent", async () => {
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await openOrder(db, "order_first", FIRST);
  await processGatewayEvent(db, notify({ eventId: "evt_1", rupees: FIRST, paymentRef: "pay_A" }));
  await processGatewayEvent(db, notify({ eventId: "evt_2_fresh", rupees: FIRST, paymentRef: "pay_A" }));
  await processGatewayEvent(db, notify({ eventId: "evt_3_fresh", rupees: FIRST, paymentRef: "pay_A" }));
  console.error(`case 4: after three notifications captured=${recon(sqlite).captured_amount} schedule=${sched(sqlite).status}`);
  assert.equal(Number(recon(sqlite).captured_amount), FIRST, "one capture, however many notifications");
  assert.equal(sched(sqlite).status, "pending_balance", "and nothing settles - this is F1 on an equal split");
  assert.deepEqual(exceptions(sqlite), []);
});

test("cases 5-6: a genuine balance capture reaches Rs 8,000, settles, and refuses another order", async () => {
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const { paymentStageAmount } = await import("../lib/payment-stage-amount.ts");
  const { createBookingPaymentOrder } = await import("../lib/payment-order-intent.ts");

  await openOrder(db, "order_first", FIRST);
  await processGatewayEvent(db, notify({ eventId: "evt_first", rupees: FIRST, paymentRef: "pay_A" }));
  // Repeat notification in between, to prove it does not consume the balance stage.
  await processGatewayEvent(db, notify({ eventId: "evt_first_again", rupees: FIRST, paymentRef: "pay_A", eventType: "order.paid" }));
  assert.equal(sched(sqlite).status, "pending_balance");

  // A DIFFERENT gateway payment: this is the balance.
  await openOrder(db, "order_balance", BALANCE);
  await processGatewayEvent(db, notify({ eventId: "evt_balance", rupees: BALANCE, paymentRef: "pay_B", orderRef: "order_balance" }));

  const row = recon(sqlite), schedule = sched(sqlite);
  console.error(`case 5: captured=${row.captured_amount} recon=${row.reconciliation_status} schedule=${schedule.status} ref=${schedule.payment_ref}`);
  assert.equal(Number(row.captured_amount), PRICE, "case 5: cumulative collected is the whole Rs 8,000");
  assert.equal(row.reconciliation_status, "matched");
  assert.equal(schedule.status, "paid", "case 5: two distinct captures settle the schedule");
  assert.equal(schedule.payment_ref, "pay_B", "settled by the balance payment");

  const stage = await paymentStageAmount(db, "BK");
  assert.equal(stage.stage, "settled");
  assert.equal(stage.dueNow, 0);
  await assert.rejects(() => createBookingPaymentOrder(db, globalThis.__PAYIDEM_ENV__, { bookingId: "BK", customerId: "CUS", actorId: "test" }), /already paid/, "case 6: no further order can be opened");
  assert.deepEqual(exceptions(sqlite), []);
});

test("case 7: an asymmetric split still works", async () => {
  const { sqlite, db } = seed({ paidNow: 3000, balance: 5000 });
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await openOrder(db, "order_first", 3000);
  await processGatewayEvent(db, notify({ eventId: "a1", rupees: 3000, paymentRef: "pay_A" }));
  assert.equal(sched(sqlite).status, "pending_balance");
  await openOrder(db, "order_balance", 5000);
  await processGatewayEvent(db, notify({ eventId: "a2", rupees: 5000, paymentRef: "pay_B", orderRef: "order_balance" }));
  console.error(`case 7: captured=${recon(sqlite).captured_amount} schedule=${sched(sqlite).status}`);
  assert.equal(Number(recon(sqlite).captured_amount), 8000);
  assert.equal(sched(sqlite).status, "paid");
});

test("case 8: a wrong amount is still a real mismatch exception, measured per order", async () => {
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await openOrder(db, "order_first", FIRST);
  const result = await processGatewayEvent(db, notify({ eventId: "evt_short", rupees: FIRST - 900, paymentRef: "pay_A" }));
  console.error(`case 8: ${JSON.stringify({ status: result.status, reason: result.reason })} expected=${recon(sqlite).expected_amount} exceptions=${JSON.stringify(exceptions(sqlite))}`);
  assert.equal(result.reason, "capture_amount_mismatch");
  assert.deepEqual(exceptions(sqlite), ["capture_amount_mismatch"]);
  assert.equal(Number(recon(sqlite).expected_amount), FIRST, "the check is against THIS order's amount, never the booking total - this is F2");
  assert.equal(sched(sqlite).status, "pending_balance");
});

test("a short second capture cannot settle a stay even though it is a distinct capture", async () => {
  // Two distinct captures are necessary but not sufficient: the cumulative money must also cover the
  // schedule. Otherwise a Rs 100 second capture would close an Rs 8,000 stay.
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await openOrder(db, "order_first", FIRST);
  await processGatewayEvent(db, notify({ eventId: "s1", rupees: FIRST, paymentRef: "pay_A" }));
  await openOrder(db, "order_tip", 100);
  await processGatewayEvent(db, notify({ eventId: "s2", rupees: 100, paymentRef: "pay_B", orderRef: "order_tip" }));
  console.error(`short second capture -> captured=${recon(sqlite).captured_amount} schedule=${sched(sqlite).status}`);
  assert.equal(Number(recon(sqlite).captured_amount), FIRST + 100, "both distinct captures are counted");
  assert.equal(sched(sqlite).status, "pending_balance", "but Rs 4,100 does not settle an Rs 8,000 stay");
});

test("prepaid bookings are untouched by any of this", async () => {
  const { sqlite, db } = seed({ paidNow: PRICE, balance: 0, split: false });
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const { paymentStageAmount } = await import("../lib/payment-stage-amount.ts");
  await openOrder(db, "order_full", PRICE);
  await processGatewayEvent(db, notify({ eventId: "p1", rupees: PRICE, paymentRef: "pay_A" }));
  // And a repeat notification for it changes nothing.
  await processGatewayEvent(db, notify({ eventId: "p2", rupees: PRICE, paymentRef: "pay_A", eventType: "order.paid" }));
  const row = recon(sqlite);
  console.error(`prepaid: captured=${row.captured_amount} recon=${row.reconciliation_status} exceptions=${JSON.stringify(exceptions(sqlite))}`);
  assert.equal(Number(row.captured_amount), PRICE);
  assert.equal(row.reconciliation_status, "matched");
  assert.deepEqual(exceptions(sqlite), []);
  const stage = await paymentStageAmount(db, "BK");
  assert.equal(stage.stage, "settled");
});

test("#178 is preserved: collectedForBooking tracks the schedule through both stages", async () => {
  const { db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const { collectedForBooking } = await import("../lib/collected-funds.ts");
  await openOrder(db, "order_first", FIRST);
  await processGatewayEvent(db, notify({ eventId: "c1", rupees: FIRST, paymentRef: "pay_A" }));
  await processGatewayEvent(db, notify({ eventId: "c1_repeat", rupees: FIRST, paymentRef: "pay_A", eventType: "order.paid" }));
  assert.equal(await collectedForBooking(db, "BK"), FIRST, "a repeat notification does not inflate collected money");
  await openOrder(db, "order_balance", BALANCE);
  await processGatewayEvent(db, notify({ eventId: "c2", rupees: BALANCE, paymentRef: "pay_B", orderRef: "order_balance" }));
  assert.equal(await collectedForBooking(db, "BK"), PRICE);
});

test("case 4b: payment.captured carries a payment id, order.paid carries only the order id", async () => {
  // A provider need not send both references on both notifications. Matching on a single preferred key
  // would make one capture look like two: payment.captured is identified by its payment id, order.paid
  // by its order id. Either reference matching is enough to recognise the same money.
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await openOrder(db, "order_first", FIRST);
  await processGatewayEvent(db, notify({ eventId: "m1", rupees: FIRST, paymentRef: "pay_A", orderRef: "order_first" }));
  // Same order, no payment id at all.
  await processGatewayEvent(db, { ...notify({ eventId: "m2", rupees: FIRST, paymentRef: undefined, orderRef: "order_first", eventType: "order.paid" }), gatewayPaymentId: undefined });
  console.error(`case 4b: captured=${recon(sqlite).captured_amount} schedule=${sched(sqlite).status} exceptions=${JSON.stringify(exceptions(sqlite))}`);
  assert.equal(Number(recon(sqlite).captured_amount), FIRST, "one capture, matched by its order reference");
  assert.equal(sched(sqlite).status, "pending_balance");
  assert.deepEqual(exceptions(sqlite), []);
});
