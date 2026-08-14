/**
 * PAWSPACE-PAY-002 — the gateway order must be for the amount due at THIS payment stage.
 *
 * lib/payment-order-intent.ts read `booking_payments.amount` — the whole booking price — and never
 * `amount_due_now`. A customer choosing a 50/50 stay worth Rs 10,000 was sent to Razorpay for
 * Rs 10,000. lib/razorpay-client.ts converts with `Math.round(amount * 100)`, so this was the real
 * gateway order amount, not a display bug.
 *
 * These tests assert the PAISE value handed to the adapter, because that is the number the customer is
 * charged. The adapter is stubbed at the fetch boundary so the request body can be read; everything
 * above it — the stage resolution, the SQL, the reconciliation record — is the real code.
 *
 * The three stages are tested separately on purpose. Fixing the total-vs-due-now defect by always
 * charging `amount_due_now` would introduce a second one: the balance instalment would then charge the
 * first instalment's amount forever.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__PAY_DB__", "__PAY_ENV__");

const TOTAL = 10000, HALF = 5000;

/** Razorpay credentials the client needs to consider itself connected. */
const ENV = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_KEY_ID_SANDBOX: "rzp_test_key", RAZORPAY_KEY_SECRET_SANDBOX: "rzp_test_secret" };

// D1's batch() is one transaction. The hand-rolled loop this replaced committed each statement as it
// went, so a capture that failed half way left half its writes behind - the opposite of production,
// and invisible to every assertion in this file. createD1 rolls the whole batch back.
const makeD1 = (sqlite) => createD1(sqlite);

/**
 * A booking with a payment row and, optionally, a split schedule — the exact shapes
 * app/api/canonical-bookings writes at booking creation.
 */
function seed({ total = TOTAL, dueNow = TOTAL, paymentStatus = "created", schedule = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER)");
  const now = Date.UTC(2026, 6, 1);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUS-1','boarding','confirmed',?)").run(total);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-1','BK-1','CUS-1',?,?,'INR','card',?,?,'razorpay','pidem','{}',?,?)")
    .run(total, dueNow, schedule ? "split_50_50" : "prepaid", paymentStatus, now, now);
  if (schedule) {
    sqlite.prepare("INSERT INTO stay_payment_schedules VALUES ('BK-1','boarding','CUS-1',?,?,?,?,?,NULL,NULL,?,?)")
      .run(total, schedule.paidNow, schedule.balance, now + 86400000, schedule.status, now, now);
  }
  const db = makeD1(sqlite);
  globalThis.__PAY_DB__ = db;
  globalThis.__PAY_ENV__ = {};
  return { sqlite, db };
}

/** Captures the order body Razorpay would receive, and returns the paise figure. */
function stubGateway() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body || "{}"));
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({ id: `order_${calls.length}`, amount: body.amount, currency: body.currency, status: "created" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; }, paise: () => calls.at(-1)?.body?.amount };
}

async function openOrder(db) {
  const { createBookingPaymentOrder } = await import("../lib/payment-order-intent.ts");
  return createBookingPaymentOrder(db, ENV, { bookingId: "BK-1", customerId: "CUS-1", actorId: "CUS-1" });
}

test("Test 1 — a 50/50 first payment charges the half due, not the booking total", async () => {
  const { db } = seed({ dueNow: HALF, schedule: { paidNow: HALF, balance: HALF, status: "pending_balance" } });
  const gateway = stubGateway();
  try {
    const result = await openOrder(db);
    assert.equal(result.connected, true, `order not opened: ${result.reason ?? ""}`);
    assert.equal(gateway.paise(), 500000, "Razorpay must receive 500000 paise (Rs 5,000), not 1000000");
    assert.equal(result.amount, HALF);
    assert.equal(result.stage, "first_instalment");
  } finally { gateway.restore(); }
});

test("Test 2 — a full payment is unchanged", async () => {
  const { db } = seed({ dueNow: TOTAL });
  const gateway = stubGateway();
  try {
    const result = await openOrder(db);
    assert.equal(gateway.paise(), 1000000, "a prepaid booking still charges the whole price");
    assert.equal(result.amount, TOTAL);
    assert.equal(result.stage, "full");
  } finally { gateway.restore(); }
});

test("Test 3 — a non-round split sends the exact due-now amount", async () => {
  // 7333.33 / 3666.67 : no rounding artefact may reach the gateway, and no figure here is a tidy half
  // of another, so a total-vs-due-now confusion cannot pass by coincidence.
  const total = 11000.0, dueNow = 7333.33, balance = 3666.67;
  const { db } = seed({ total, dueNow, schedule: { paidNow: dueNow, balance, status: "pending_balance" } });
  const gateway = stubGateway();
  try {
    const result = await openOrder(db);
    assert.equal(gateway.paise(), 733333, "exactly the due-now amount in paise");
    assert.notEqual(gateway.paise(), 1100000, "not the booking total");
    assert.equal(result.amount, dueNow);
  } finally { gateway.restore(); }
});

test("Test 4 — the later instalment charges the outstanding balance, not the total and not the first half", async () => {
  // First instalment captured, schedule still owes the balance. Charging dueNow again here is the second
  // defect a naive fix introduces; charging the total is the original one.
  const { db } = seed({ dueNow: HALF, paymentStatus: "captured", schedule: { paidNow: HALF, balance: HALF, status: "pending_balance" } });
  const gateway = stubGateway();
  try {
    const result = await openOrder(db);
    assert.equal(result.stage, "outstanding_balance");
    assert.equal(gateway.paise(), 500000, "the outstanding balance, in paise");
    assert.equal(result.amount, HALF);
  } finally { gateway.restore(); }

  // An asymmetric split makes the three candidate amounts distinct, so the assertion cannot be satisfied
  // by the wrong one: total 12000, first 9000, balance 3000.
  const asym = seed({ total: 12000, dueNow: 9000, paymentStatus: "captured", schedule: { paidNow: 9000, balance: 3000, status: "pending_balance" } });
  const second = stubGateway();
  try {
    const result = await openOrder(asym.db);
    assert.equal(second.paise(), 300000, "the balance (Rs 3,000), not the total (Rs 12,000) and not the first instalment (Rs 9,000)");
    assert.equal(result.stage, "outstanding_balance");
  } finally { second.restore(); }
});

test("Test 4b — a fully settled split cannot open another order", async () => {
  const { db } = seed({ dueNow: HALF, paymentStatus: "captured", schedule: { paidNow: HALF, balance: HALF, status: "paid" } });
  const gateway = stubGateway();
  try {
    await assert.rejects(openOrder(db), /already paid/, "nothing outstanding means no further order");
    assert.equal(gateway.calls.length, 0, "and the gateway is never called");
  } finally { gateway.restore(); }
});

test("Test 5 — gateway verification expects the instalment amount, not the booking total", async () => {
  const { sqlite, db } = seed({ dueNow: HALF, schedule: { paidNow: HALF, balance: HALF, status: "pending_balance" } });
  const gateway = stubGateway();
  try { await openOrder(db); } finally { gateway.restore(); }

  const record = sqlite.prepare("SELECT expected_amount FROM payment_reconciliation_records WHERE payment_id='PAY-1'").get();
  assert.ok(record, "opening an order must record what it expects");
  assert.equal(record.expected_amount, HALF, "the reconciliation record expects the instalment, not the Rs 10,000 total");

  // And the webhook must agree: a correct Rs 5,000 capture is reconciled, not flagged as a shortfall.
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const outcome = await processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-1", eventType: "payment.captured",
    bookingId: "BK-1", gatewayOrderId: "order_1", gatewayPaymentId: "pay_1",
    amountSubunits: 500000, currency: "INR", signatureVerified: true, payloadHash: "hash-1",
  });
  assert.ok(outcome, "the webhook must process the event");
  const recon = sqlite.prepare("SELECT captured_amount,variance_amount,reconciliation_status FROM payment_reconciliation_records WHERE payment_id='PAY-1'").get();
  assert.equal(recon.captured_amount, HALF, "the captured half is recorded");
  assert.equal(recon.variance_amount, 0, "a correct instalment payment must show no variance against the booking total");
});

test("Test 6 — the records still hold total, due now and outstanding balance after the order", async () => {
  const { sqlite, db } = seed({ dueNow: HALF, schedule: { paidNow: HALF, balance: HALF, status: "pending_balance" } });
  const gateway = stubGateway();
  let result;
  try { result = await openOrder(db); } finally { gateway.restore(); }

  const payment = sqlite.prepare("SELECT amount,amount_due_now,status FROM booking_payments WHERE booking_id='BK-1'").get();
  assert.equal(payment.amount, TOTAL, "the booking total is untouched");
  assert.equal(payment.amount_due_now, HALF, "the due-now amount is untouched");
  assert.equal(payment.status, "created", "opening an order never self-captures");

  const schedule = sqlite.prepare("SELECT paid_now_amount,balance_amount,status FROM stay_payment_schedules WHERE booking_id='BK-1'").get();
  assert.equal(schedule.balance_amount, HALF, "the outstanding balance is untouched");
  assert.equal(schedule.status, "pending_balance");

  assert.equal(result.bookingTotal, TOTAL, "the caller can still see the total");
  assert.equal(result.outstandingBalance, HALF, "and what remains owed");
  assert.equal(result.amount, HALF, "while being charged only the instalment");
});

test("the order path no longer reads the booking total as the amount to charge", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../lib/payment-order-intent.ts", import.meta.url), "utf8");
  assert.match(source, /paymentStageAmount/, "the amount must come from the stage helper");
  assert.doesNotMatch(source, /const amount = Number\(row\.amount \|\| 0\)/, "the booking total must not be the charged amount again");
});
