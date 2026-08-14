/**
 * PAWSPACE-PAY-002 — the third blocker, on the READ side of the split-payment fix.
 *
 * Once a gateway balance capture settles stay_payment_schedules ('paid') and accumulates the balance
 * into payment_reconciliation_records.captured_amount (lib/grooming-payment-reconciliation.ts), the
 * revenue-mission backfill would count that balance TWICE: once from captured_amount and again from its
 * synthetic stay-balance lane (keyed on schedule.status='paid'). The capture-side tests assert the
 * record itself is right; this asserts the number the mission/CRM backfill actually attributes.
 *
 * Everything below the assertions is real code: the signature-verified webhook handler, the stage
 * resolver, #178's collected-funds definition and the real revenue-mission backfill, on one database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__PAYMSN_DB__", "__PAYMSN_ENV__");

const TOTAL = 10000, HALF = 5000, DAY = 86_400_000;

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

/** A split stay, with every column the mission backfill reads on canonical_bookings. */
function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAYMSN_DB__ = db;
  globalThis.__PAYMSN_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  // Real time: the reconciliation record's updated_at is the collection event's sourceAt, so the
  // mission window has to span wall-clock as well as the booking.
  const now = Date.now();
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,city_id TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,idempotency_key TEXT UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUS-1','boarding','blr','confirmed',?,'INR',?)").run(TOTAL, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES ('PAY-1','BK-1','CUS-1',?,?,'INR','card','split_50_50','created','razorpay','pidem',?,?)")
    .run(TOTAL, HALF, now, now);
  sqlite.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES ('BK-1','boarding','CUS-1',?,?,?,?, 'pending_balance',?,?)")
    .run(TOTAL, HALF, HALF, now + 20 * DAY, now, now);
  return { sqlite, db, now };
}

const capture = (eventId, amount) => ({
  provider: "razorpay", environment: "sandbox", eventId, eventType: "payment.captured",
  bookingId: "BK-1", gatewayOrderId: `order_${eventId}`, gatewayPaymentId: `pay_${eventId}`,
  amountSubunits: Math.round(amount * 100), currency: "INR", signatureVerified: true, payloadHash: `hash_${eventId}`,
});

async function linkStageOrder(db, orderId, amount) {
  const { linkGatewayOrder } = await import("../lib/grooming-payment-reconciliation.ts");
  return linkGatewayOrder(db, { bookingId: "BK-1", gatewayOrderId: orderId, environment: "sandbox", actorId: "test", expectedAmount: amount });
}

test("a gateway-settled balance is attributed once by the revenue-mission backfill, never double-counted", async () => {
  const { sqlite, db, now } = seed();
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const mission = await import("../lib/revenue-mission-control.ts");

  // Full gateway lifecycle: deposit then balance, distinct orders — the balance capture settles the schedule.
  await linkStageOrder(db, "order_first", HALF);
  await processGatewayEvent(db, capture("evt_first", HALF));
  await linkStageOrder(db, "order_balance", HALF);
  await processGatewayEvent(db, capture("evt_balance", HALF));
  assert.equal(sqlite.prepare("SELECT status FROM stay_payment_schedules WHERE booking_id='BK-1'").get().status, "paid", "the balance capture settles the schedule");
  assert.equal(Number(sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id='PAY-1'").get().captured_amount), TOTAL, "captured_amount already carries both instalments");

  const missionId = "MSN-PAY002";
  await mission.saveRevenueMission(db, { id: missionId, name: "Split attribution audit", targetAmount: 100000, currency: "INR", periodStart: now - DAY, periodEnd: now + 7 * DAY, scope: { type: "company" }, revenueBasis: "collected", reason: "pay-002 double-count guard", actorId: "uat" });
  await mission.activateRevenueMission(db, { missionId, approvalReference: "APPR-1", actorId: "uat", reason: "guard activation" });
  await mission.backfillRevenueMissionFromCanonicalSources(db, missionId, "uat");

  const first = await mission.revenueMissionSummary(db, missionId);
  console.error(`gateway-settled attribution -> collected=${first.metrics.collected} (record=${TOTAL}, stay-lane residual must be 0)`);
  assert.equal(first.metrics.collected, TOTAL, "the balance already inside captured_amount is not credited a second time by the stay-balance lane");

  // Delta-idempotent: rebuilding does not accumulate.
  await mission.backfillRevenueMissionFromCanonicalSources(db, missionId, "uat");
  const again = await mission.revenueMissionSummary(db, missionId);
  assert.equal(again.metrics.collected, TOTAL, "re-running the backfill must not double-count");
});
