/*
 * Day-31 cross-module test 2: a 50/50 boarding stay, paid in two real Razorpay captures.
 *
 * booking payment + split schedule -> advance capture -> stage recomputation -> balance capture ->
 * schedule settlement, plus the post-booking-credit guard that decides whether an already-open
 * gateway order may still be captured.
 *
 * Why this shape: PawSpace boarding takes an advance and a balance against ONE canonical
 * booking_payments row (booking_id is UNIQUE there) and ONE payment_reconciliation_records row
 * (payment_id is the primary key). Both captures therefore write to the same two rows. Nothing in
 * this suite drives a SECOND capture on the same payment - tests/adversarial-webhook-replay-
 * signature.test.mjs deliberately attacks replays of the SAME capture, which is the opposite case:
 * a replay must be absorbed, a genuine balance must be collected.
 *
 * Modules executed: razorpay-capture-atomic, payment-stage-amount, payment-capture-amount-guard,
 * stay-split-payments, booking-credit-application, financial-runtime-schema.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_PAY_DB__", "__D31_PAY_ENV__");

const BOOKING = "BRD-D31-9001";
const PAYMENT = "PAY-D31-9001";
const CUSTOMER = "CUS-D31-9001";
const TOTAL = 10000;    // Rs 10,000 stay
const ADVANCE = 5000;   // 50% taken at booking
const BALANCE = 5000;   // 50% due at check-in

async function seedStay() {
  const { sqlite, db } = world("__D31_PAY_DB__", "__D31_PAY_ENV__");
  const { ensureFinancialRuntimeTables } = await import("../lib/financial-runtime-schema.ts");
  const { ensureStayPaymentTables } = await import("../lib/stay-split-payments.ts");
  // The real webhook route ensures the reconciliation tables before it commits a capture; the
  // gateway event/link tables live there, not in the financial runtime schema.
  const { ensurePaymentReconciliationTables } = await import("../lib/grooming-payment-reconciliation.ts");
  await ensureFinancialRuntimeTables(db);
  await ensureStayPaymentTables(db);
  await ensurePaymentReconciliationTables(db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'INR','razorpay','split','pending',?,?,?)")
    .run(PAYMENT, BOOKING, CUSTOMER, TOTAL, ADVANCE, `idem-${PAYMENT}`, now, now);
  sqlite.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending_balance',?,?)")
    .run(BOOKING, "boarding", CUSTOMER, TOTAL, ADVANCE, BALANCE, now + 7 * 86400000, now, now);

  const inbox = (id) =>
    sqlite.prepare("INSERT INTO gateway_webhook_events (id,provider,environment,event_id,event_type,raw_payload,payload_sha256,signature,processing_status,received_at) VALUES (?,'razorpay','sandbox',?,'payment.captured','{}',?,'sig','PROCESSING',?)")
      .run(id, `evt-${id}`, `hash-${id}`, Date.now());
  return { sqlite, db, inbox };
}

const recon = (sqlite) =>
  sqlite.prepare("SELECT expected_amount,captured_amount,reconciliation_status FROM payment_reconciliation_records WHERE payment_id=?").get(PAYMENT);

test("the advance capture collects exactly the instalment due now, not the whole stay", async () => {
  const { sqlite, db, inbox } = await seedStay();
  const { commitRazorpayCaptureAtomic } = await import("../lib/razorpay-capture-atomic.ts");
  inbox("IB-ADV");

  const result = await commitRazorpayCaptureAtomic(db, {
    inboxId: "IB-ADV", eventId: "evt-IB-ADV", environment: "sandbox",
    bookingId: BOOKING, paymentId: PAYMENT,
    gatewayOrderId: "order_ADV001", gatewayPaymentId: "pay_ADV001",
    amountPaise: ADVANCE * 100, currency: "INR", payloadHash: "hash-IB-ADV",
  });

  assert.equal(result.duplicateCapture, false);
  assert.equal(result.capturedTotal, ADVANCE);
  assert.equal(result.collectedInFull, false, "half of a 50/50 stay is not the full stay");
  assert.equal(sqlite.prepare("SELECT status FROM stay_payment_schedules WHERE booking_id=?").get(BOOKING).status,
    "pending_balance", "the balance must still be owed");
});

test("after the advance, the payment stage asks for the BALANCE - not the total, not the advance again", async () => {
  const { db, inbox } = await seedStay();
  const { commitRazorpayCaptureAtomic } = await import("../lib/razorpay-capture-atomic.ts");
  const { paymentStageAmount } = await import("../lib/payment-stage-amount.ts");
  inbox("IB-ADV2");
  await commitRazorpayCaptureAtomic(db, {
    inboxId: "IB-ADV2", eventId: "evt-IB-ADV2", environment: "sandbox", bookingId: BOOKING, paymentId: PAYMENT,
    gatewayOrderId: "order_ADV002", gatewayPaymentId: "pay_ADV002",
    amountPaise: ADVANCE * 100, currency: "INR", payloadHash: "hash-IB-ADV2",
  });

  const stage = await paymentStageAmount(db, BOOKING);
  assert.equal(stage.stage, "outstanding_balance");
  assert.equal(stage.dueNow, BALANCE, "the second gateway order must be opened for the balance");
});

test("the balance capture is collected and settles the stay", async () => {
  /*
   * THE CASE THAT MATTERS. Both captures write to the same payment_reconciliation_records row, and
   * the advance capture set expected_amount to its OWN amount. If the balance capture is validated
   * against that overwritten figure rather than against what is genuinely still owed, a real
   * customer payment that Razorpay has already taken is refused by our own books.
   */
  const { sqlite, db, inbox } = await seedStay();
  const { commitRazorpayCaptureAtomic } = await import("../lib/razorpay-capture-atomic.ts");
  inbox("IB-ADV3"); inbox("IB-BAL3");

  await commitRazorpayCaptureAtomic(db, {
    inboxId: "IB-ADV3", eventId: "evt-IB-ADV3", environment: "sandbox", bookingId: BOOKING, paymentId: PAYMENT,
    gatewayOrderId: "order_ADV003", gatewayPaymentId: "pay_ADV003",
    amountPaise: ADVANCE * 100, currency: "INR", payloadHash: "hash-IB-ADV3",
  });

  const balance = await commitRazorpayCaptureAtomic(db, {
    inboxId: "IB-BAL3", eventId: "evt-IB-BAL3", environment: "sandbox", bookingId: BOOKING, paymentId: PAYMENT,
    gatewayOrderId: "order_BAL003", gatewayPaymentId: "pay_BAL003",
    amountPaise: BALANCE * 100, currency: "INR", payloadHash: "hash-IB-BAL3",
  });

  assert.equal(balance.duplicateCapture, false, "a genuine second instalment is not a replay");
  assert.equal(balance.capturedTotal, TOTAL, "both instalments must be on the books");
  assert.equal(balance.collectedInFull, true);
  assert.equal(sqlite.prepare("SELECT status FROM stay_payment_schedules WHERE booking_id=?").get(BOOKING).status,
    "paid", "the stay must settle once the balance is in");
  assert.equal(recon(sqlite).captured_amount, TOTAL);
});

test("a replay of the advance is absorbed and never double-counted", async () => {
  const { sqlite, db, inbox } = await seedStay();
  const { commitRazorpayCaptureAtomic } = await import("../lib/razorpay-capture-atomic.ts");
  inbox("IB-ADV4"); inbox("IB-RPL4");
  const args = {
    environment: "sandbox", bookingId: BOOKING, paymentId: PAYMENT,
    gatewayOrderId: "order_ADV004", gatewayPaymentId: "pay_ADV004",
    amountPaise: ADVANCE * 100, currency: "INR",
  };
  await commitRazorpayCaptureAtomic(db, { ...args, inboxId: "IB-ADV4", eventId: "evt-IB-ADV4", payloadHash: "h1" });
  const replay = await commitRazorpayCaptureAtomic(db, { ...args, inboxId: "IB-RPL4", eventId: "evt-IB-RPL4", payloadHash: "h2" });

  assert.equal(replay.duplicateCapture, true, "the same gateway payment id arriving twice is one capture");
  assert.equal(recon(sqlite).captured_amount, ADVANCE, "a replay must not inflate collections");
});

test("a capture for the wrong amount is refused, in both directions", async () => {
  const { db, inbox } = await seedStay();
  const { commitRazorpayCaptureAtomic, RazorpayCaptureAmountMismatchError } = await import("../lib/razorpay-capture-atomic.ts");
  for (const [label, paise] of [["overcharge", (ADVANCE + 1) * 100], ["undercharge", (ADVANCE - 1) * 100]]) {
    inbox(`IB-${label}`);
    await assert.rejects(
      () => commitRazorpayCaptureAtomic(db, {
        inboxId: `IB-${label}`, eventId: `evt-IB-${label}`, environment: "sandbox", bookingId: BOOKING, paymentId: PAYMENT,
        gatewayOrderId: `order_${label}`, gatewayPaymentId: `pay_${label}`,
        amountPaise: paise, currency: "INR", payloadHash: `hash-${label}`,
      }),
      RazorpayCaptureAmountMismatchError,
      `a ${label} must not be silently accepted`,
    );
  }
});
