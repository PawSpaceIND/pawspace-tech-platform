/**
 * PAWSPACE-PAY-002, the two blockers found on review of the first fix.
 *
 * #176 made the gateway order be for the amount due at this stage. That is necessary and not
 * sufficient: the CAPTURE side of a split stay was still wrong in two ways, and both are money.
 *
 *   1. The gateway capture never settled `stay_payment_schedules`. lib/stay-split-payments settles it
 *      on the sandbox path, but a real balance capture only set booking_payments.status='captured' —
 *      which is precisely the state lib/payment-stage-amount reports as `outstanding_balance` with a
 *      positive amount. A fully paid stay could therefore be charged its balance AGAIN.
 *
 *   2. One `payment_reconciliation_records` row serves both instalments, and captured_amount was
 *      OVERWRITTEN by each capture instead of accumulating. A fully paid Rs 10,000 stay reported
 *      Rs 5,000 collected. lib/revenue-mission-control and app/api/revenue-crm both read
 *      captured_amount as collections, so the under-report reached revenue reporting.
 *
 * Everything below the assertions is the real module: the webhook handler, the stage resolver and
 * #178's collected-funds definition, against one database. The gateway is never called — captures are
 * signature-verified sandbox events, exactly the shape app/api/razorpay-webhook forwards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAYCAP_DB__", "__PAYCAP_ENV__");

const TOTAL = 10000, HALF = 5000;

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

/** A stay as app/api/canonical-bookings writes it: payment row plus, for a split, its schedule. */
function seed({ split = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAYCAP_DB__ = db;
  globalThis.__PAYCAP_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const now = Date.UTC(2026, 6, 1);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,idempotency_key TEXT UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUS-1','boarding','confirmed',?)").run(TOTAL);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES ('PAY-1','BK-1','CUS-1',?,?,'INR','card',?,'created','razorpay','pidem',?,?)")
    .run(TOTAL, split ? HALF : TOTAL, split ? "split_50_50" : "prepaid", now, now);
  if (split) {
    sqlite.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES ('BK-1','boarding','CUS-1',?,?,?,?, 'pending_balance',?,?)")
      .run(TOTAL, HALF, HALF, now + 20 * 86_400_000, now, now);
  }
  return { sqlite, db };
}

const recon = (sqlite) => sqlite.prepare("SELECT expected_amount,captured_amount,gateway_status,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='PAY-1'").get();
const schedule = (sqlite) => sqlite.prepare("SELECT status,paid_at,payment_ref FROM stay_payment_schedules WHERE booking_id='BK-1'").get();
const paymentStatus = (sqlite) => sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-1'").get().status;

/** A verified sandbox capture for `amount` rupees, as the webhook route forwards it. */
const capture = (eventId, amount) => ({
  provider: "razorpay", environment: "sandbox", eventId, eventType: "payment.captured",
  bookingId: "BK-1", gatewayOrderId: `order_${eventId}`, gatewayPaymentId: `pay_${eventId}`,
  amountSubunits: Math.round(amount * 100), currency: "INR", signatureVerified: true, payloadHash: `hash_${eventId}`,
});

/** Open the order for whatever is due now, which is what records this stage's expected amount. */
async function linkStageOrder(db, orderId, amount) {
  const { linkGatewayOrder } = await import("../lib/grooming-payment-reconciliation.ts");
  return linkGatewayOrder(db, { bookingId: "BK-1", gatewayOrderId: orderId, environment: "sandbox", actorId: "test", expectedAmount: amount });
}

test("BLOCKER 1: capturing the balance settles the schedule, so no second balance order can be opened", async () => {
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const { paymentStageAmount } = await import("../lib/payment-stage-amount.ts");

  // First instalment: order for the half, captured.
  await linkStageOrder(db, "order_first", HALF);
  await processGatewayEvent(db, capture("evt_first", HALF));
  const afterFirst = await paymentStageAmount(db, "BK-1");
  console.error(`after first instalment -> stage=${afterFirst.stage} dueNow=${afterFirst.dueNow} schedule=${schedule(sqlite).status}`);
  assert.equal(schedule(sqlite).status, "pending_balance", "the first instalment must NOT settle the schedule");
  assert.equal(afterFirst.stage, "outstanding_balance");
  assert.equal(afterFirst.dueNow, HALF, "the balance is what is payable next");

  // Balance: order for the balance, captured.
  await linkStageOrder(db, "order_balance", HALF);
  await processGatewayEvent(db, capture("evt_balance", HALF));

  const settled = schedule(sqlite);
  const afterBalance = await paymentStageAmount(db, "BK-1");
  console.error(`after balance -> stage=${afterBalance.stage} dueNow=${afterBalance.dueNow} schedule=${settled.status} ref=${settled.payment_ref}`);
  assert.equal(settled.status, "paid", "the gateway balance capture must settle the schedule");
  assert.ok(Number(settled.paid_at) > 0, "and stamp when it was paid");
  assert.equal(settled.payment_ref, "pay_evt_balance", "recording the gateway payment that settled it");
  assert.equal(afterBalance.stage, "settled", "so the stage resolver reports nothing outstanding");
  assert.equal(afterBalance.dueNow, 0, "a further balance charge is impossible - this is the repeat-charge defect");
  assert.equal(afterBalance.outstandingBalance, 0);

  // The sandbox path's trail is written too, so the two settle paths cannot disagree.
  const events = sqlite.prepare("SELECT event_type,actor_id,idempotency_key FROM stay_payment_events WHERE booking_id='BK-1'").all();
  assert.deepEqual(events.map((row) => row.event_type), ["balance_captured"]);
  assert.equal(events[0].actor_id, "razorpay_webhook");
  assert.equal(events[0].idempotency_key, "gateway:evt_balance", "keyed on the gateway event so a replay cannot double-record");
});

test("BLOCKER 2: both instalments accumulate, so a fully paid stay reports the whole amount collected", async () => {
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");

  await linkStageOrder(db, "order_first", HALF);
  await processGatewayEvent(db, capture("evt_first", HALF));
  const afterFirst = recon(sqlite);
  console.error(`after first  -> expected=${afterFirst.expected_amount} captured=${afterFirst.captured_amount} recon=${afterFirst.reconciliation_status}`);
  assert.equal(Number(afterFirst.captured_amount), HALF, "half is collected");
  // expected_amount is the amount THIS order was opened for, deliberately. An earlier version stored
  // the booking total here and it fed straight back into the next event's variance check, raising a
  // false mismatch on the second notification for one capture. Booking-level truth is captured_amount
  // plus the schedule; see tests/split-payment-capture-idempotency.test.mjs.
  assert.equal(Number(afterFirst.expected_amount), HALF, "the per-stage expectation stays per stage");
  assert.equal(afterFirst.reconciliation_status, "partially_captured", "and it is honest that the rest is outstanding");
  assert.equal(Number(afterFirst.variance_amount), 0, "the instalment matched its own order, so there is no variance");

  await linkStageOrder(db, "order_balance", HALF);
  await processGatewayEvent(db, capture("evt_balance", HALF));
  const afterBalance = recon(sqlite);
  console.error(`after balance -> expected=${afterBalance.expected_amount} captured=${afterBalance.captured_amount} recon=${afterBalance.reconciliation_status}`);
  assert.equal(Number(afterBalance.captured_amount), TOTAL, "the balance ADDS to the first instalment - overwriting it under-reported collections");
  assert.equal(Number(afterBalance.expected_amount), HALF, "still the balance order's own amount, not the booking total");
  assert.equal(afterBalance.reconciliation_status, "matched", "cumulative collections cover the schedule");
  assert.equal(Number(afterBalance.variance_amount), 0);
});

test("the collections figure revenue reporting reads is the whole amount, not the last instalment", async () => {
  // captured_amount is what lib/revenue-mission-control passes as canonicalCapturedAmount and what
  // app/api/revenue-crm sums as `collections`. This asserts the number those two consume.
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await linkStageOrder(db, "order_first", HALF);
  await processGatewayEvent(db, capture("evt_first", HALF));
  await linkStageOrder(db, "order_balance", HALF);
  await processGatewayEvent(db, capture("evt_balance", HALF));

  const collections = sqlite.prepare("SELECT COALESCE(SUM(r.captured_amount),0) collections FROM booking_payments p LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id WHERE p.booking_id='BK-1'").get();
  assert.equal(Number(collections.collections), TOTAL, "revenue reporting must see the full Rs 10,000 collected");
});

test("#178 is preserved: collectedForBooking still reports half before the balance and all after", async () => {
  const { db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const { collectedForBooking } = await import("../lib/collected-funds.ts");

  await linkStageOrder(db, "order_first", HALF);
  await processGatewayEvent(db, capture("evt_first", HALF));
  assert.equal(await collectedForBooking(db, "BK-1"), HALF, "schedule-aware: only the first instalment is in");

  await linkStageOrder(db, "order_balance", HALF);
  await processGatewayEvent(db, capture("evt_balance", HALF));
  assert.equal(await collectedForBooking(db, "BK-1"), TOTAL, "and the whole amount once the schedule is settled");
});

test("a re-sent FIRST instalment under a new event id does not settle the schedule", async () => {
  // The settle is conditional on the amount being the balance as well as the first instalment being
  // in. Without the amount condition, any second capture would close the schedule - including a
  // duplicate first instalment arriving under a fresh gateway event id, which deduplication by
  // event_id cannot catch.
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  sqlite.exec("UPDATE stay_payment_schedules SET paid_now_amount=4000,balance_amount=6000 WHERE booking_id='BK-1'");

  await linkStageOrder(db, "order_first", 4000);
  await processGatewayEvent(db, capture("evt_first", 4000));
  assert.equal(schedule(sqlite).status, "pending_balance");

  // Same 4,000 again, new event id: it is not the balance, so the schedule stays open.
  await linkStageOrder(db, "order_first_again", 4000);
  await processGatewayEvent(db, capture("evt_first_again", 4000));
  console.error(`re-sent first instalment -> schedule=${schedule(sqlite).status} captured=${recon(sqlite).captured_amount}`);
  assert.equal(schedule(sqlite).status, "pending_balance", "a duplicated first instalment must not close the balance");
});

test("prepaid bookings are unchanged: no schedule, one capture, matched in full", async () => {
  const { sqlite, db } = seed({ split: false });
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const { paymentStageAmount } = await import("../lib/payment-stage-amount.ts");
  sqlite.exec("DROP TABLE stay_payment_schedules");

  await linkStageOrder(db, "order_full", TOTAL);
  await processGatewayEvent(db, capture("evt_full", TOTAL));

  const row = recon(sqlite);
  console.error(`prepaid -> expected=${row.expected_amount} captured=${row.captured_amount} recon=${row.reconciliation_status} paymentStatus=${paymentStatus(sqlite)}`);
  assert.equal(Number(row.captured_amount), TOTAL);
  assert.equal(Number(row.expected_amount), TOTAL);
  assert.equal(row.reconciliation_status, "matched");
  assert.equal(paymentStatus(sqlite), "captured");
  const stage = await paymentStageAmount(db, "BK-1");
  assert.equal(stage.stage, "settled");
  assert.equal(stage.dueNow, 0);
});

test("a capture that disagrees with its own order is still an exception, per stage", async () => {
  // The per-order variance check is what makes the stage amounts meaningful; accumulating the record
  // must not weaken it.
  const { sqlite, db } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await linkStageOrder(db, "order_first", HALF);
  const result = await processGatewayEvent(db, capture("evt_wrong", HALF - 1000));
  console.error(`wrong-amount capture -> ${JSON.stringify(result)}`);
  assert.equal(result.status, "exception");
  assert.equal(result.reason, "capture_amount_mismatch");
  assert.equal(schedule(sqlite).status, "pending_balance", "and it certainly does not settle anything");
  const exceptions = sqlite.prepare("SELECT exception_type FROM payment_reconciliation_exceptions WHERE booking_id='BK-1'").all();
  assert.deepEqual(exceptions.map((row) => row.exception_type), ["capture_amount_mismatch"]);
});
