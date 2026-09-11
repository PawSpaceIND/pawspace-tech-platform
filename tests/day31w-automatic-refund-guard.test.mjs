/*
 * Day-31 wave 1c: the automatic booking refund sweep.
 *
 * cancelled booking -> refund case -> policy check -> over-refund guard -> gateway initiation.
 *
 * lib/automatic-booking-refund.ts runs unattended: it approves and initiates real refunds against
 * Razorpay with no human in the loop, on a policy flag. The only thing standing between it and
 * paying a customer twice is one guard comparing what is being refunded against what was actually
 * captured, so that guard is what this file attacks.
 *
 * The interesting case is not "two refund cases for the same booking" - that is the one the guard
 * was written for. It is a refund that happened somewhere ELSE: issued straight from the Razorpay
 * dashboard by a support agent, which produces a refund.processed webhook and moves
 * payment_reconciliation_records.refunded_amount, but creates no booking_refund_cases row at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_REF_DB__", "__D31W_REF_ENV__");

const BOOKING = "BK-REF-001";
const PAYMENT = "PAY-REF-001";
const CUSTOMER = "CUS-REF-001";
const CAPTURED = 4000;
const ENV = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };

async function seedRefund({ capturedAmount = CAPTURED, gatewayRefunded = 0 } = {}) {
  const { sqlite, db } = world("__D31W_REF_DB__", "__D31W_REF_ENV__", ENV);
  const { ensurePaymentReconciliationTables } = await import("../lib/grooming-payment-reconciliation.ts");
  await ensurePaymentReconciliationTables(db);
  const { runAutomaticBookingRefundSweep } = await import("../lib/automatic-booking-refund.ts");

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT UNIQUE,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,policy_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");

  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,status,total_amount,currency,scheduled_start) VALUES (?,?,'blr','grooming','cancelled',?,'INR',?)")
    .run(BOOKING, CUSTOMER, capturedAmount, new Date(now).toISOString());
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'INR','razorpay','full',?,'razorpay_sandbox',?,?,?)")
    .run(PAYMENT, BOOKING, CUSTOMER, capturedAmount, capturedAmount, gatewayRefunded > 0 ? "partially_refunded" : "captured", `idem-${PAYMENT}`, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO payment_gateway_links (booking_id,payment_id,provider,gateway_order_id,gateway_payment_id,environment,created_at,updated_at) VALUES (?,?,'razorpay',?,?,'sandbox',?,?)")
    .run(BOOKING, PAYMENT, "order_REF001", "pay_REF001", now, now);
  sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,'razorpay','sandbox',?,?,?,'INR','captured','matched',0,'evt',?)")
    .run(PAYMENT, BOOKING, capturedAmount, capturedAmount, gatewayRefunded, now);
  return { sqlite, db, runAutomaticBookingRefundSweep };
}

const addCase = (sqlite, id, amount, status = "requested", automatic = true) =>
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, BOOKING, PAYMENT, amount, "Day-31 cancellation refund", status,
         "system:cancellation", JSON.stringify({ automatic, requiresApproval: false, policyVersion: "d31" }),
         Date.now(), Date.now());

const caseStatus = (sqlite, id) => sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(id)?.status;

/*
 * This suite runs with no Razorpay sandbox credentials, so a case that CLEARS the over-refund guard
 * then fails at the gateway call. That is the correct behaviour and it is not what is under test -
 * so "blocked" here means blocked by the guard specifically, proven by the error text and by the
 * case never leaving 'requested'. Asserting only report.failed would have read a credentials error
 * as if it were a refused over-refund, which is exactly the trap this pass keeps finding.
 */
const blockedByGuard = (report) => report.failed === 1 && /exceed/i.test(String(report.errors[0]));
const clearedTheGuard = (report) =>
  report.failed === 0 || /credentials are not configured/i.test(String(report.errors[0] ?? ""));

test("a refund within the captured amount is approved automatically", async () => {
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund();
  addCase(sqlite, "RC-1", 4000);
  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.equal(report.processed, 1);
  assert.ok(clearedTheGuard(report), `must not be refused as an over-refund: ${JSON.stringify(report.errors)}`);
  assert.notEqual(caseStatus(sqlite, "RC-1"), "requested", "an automatic policy must move the case forward");
});

test("a policy that is not automatic, or needs approval, is left for a human", async () => {
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund();
  addCase(sqlite, "RC-MANUAL", 4000, "requested", false);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,'requested',?,?,?,?)")
    .run("RC-APPROVAL", BOOKING, PAYMENT, 100, "Needs a human", "system:cancellation",
         JSON.stringify({ automatic: true, requiresApproval: true }), Date.now(), Date.now());

  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.equal(report.processed, 0, "neither case may be processed unattended");
  assert.equal(caseStatus(sqlite, "RC-MANUAL"), "requested");
  assert.equal(caseStatus(sqlite, "RC-APPROVAL"), "requested");
});

test("two refund cases together may not exceed what was captured", async () => {
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund();
  addCase(sqlite, "RC-PAID", 3000, "processed");
  addCase(sqlite, "RC-OVER", 2000);
  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.ok(blockedByGuard(report), `3,000 committed + 2,000 exceeds the 4,000 captured: ${JSON.stringify(report.errors)}`);
  assert.equal(caseStatus(sqlite, "RC-OVER"), "requested", "the over-refund must not be approved");
});

test("a refund already made AT THE GATEWAY is counted against what is left", async () => {
  /*
   * THE CASE THAT MATTERS. A support agent refunds Rs 3,000 straight from the Razorpay dashboard.
   * That produces a refund.processed webhook, so payment_reconciliation_records.refunded_amount
   * becomes 3,000 - but there is no booking_refund_cases row for it, because nobody opened one.
   *
   * The unattended sweep then sees a cancelled booking with a Rs 4,000 refund case, sums the OTHER
   * refund cases (zero), compares against the 4,000 gross captured, and approves. The customer is
   * refunded Rs 7,000 against a Rs 4,000 booking, automatically, with no human involved.
   *
   * refunded_amount was already being SELECTed by the sweep and simply never read.
   */
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund({ gatewayRefunded: 3000 });
  addCase(sqlite, "RC-DOUBLE", 4000);

  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.ok(blockedByGuard(report),
    `only 1,000 of the 4,000 capture is still unrefunded - a 4,000 refund must be refused by the GUARD, not merely by absent credentials: ${JSON.stringify(report.errors)}`);
  assert.equal(caseStatus(sqlite, "RC-DOUBLE"), "requested",
    "the case must stay open for a human, not be auto-approved into a double refund");
});

test("what remains after a gateway refund is still refundable", async () => {
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund({ gatewayRefunded: 3000 });
  addCase(sqlite, "RC-REMAINDER", 1000);
  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.ok(clearedTheGuard(report), `the untouched 1,000 must still be refundable: ${JSON.stringify(report.errors)}`);
  assert.notEqual(caseStatus(sqlite, "RC-REMAINDER"), "requested");
});

test("a case whose own refund the gateway already reflects is not counted twice", async () => {
  /*
   * The opposite error. A case that was processed AND is reflected in refunded_amount is one
   * refund, not two - double-counting it would block a legitimate remaining refund.
   */
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund({ gatewayRefunded: 2000 });
  addCase(sqlite, "RC-DONE", 2000, "processed");
  addCase(sqlite, "RC-REST", 2000);
  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.ok(clearedTheGuard(report),
    `2,000 refunded once leaves 2,000 refundable - it must not be counted twice: ${JSON.stringify(report.errors)}`);
});

test("nothing is refunded against funds that were never captured", async () => {
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund();
  sqlite.prepare("UPDATE booking_payments SET status='pending' WHERE id=?").run(PAYMENT);
  sqlite.prepare("UPDATE payment_reconciliation_records SET captured_amount=0 WHERE payment_id=?").run(PAYMENT);
  addCase(sqlite, "RC-NOFUNDS", 4000);
  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.equal(report.failed, 1);
  assert.match(String(report.errors[0]), /captured/i);
});

test("a live-environment payment is never refunded from a sandbox runtime", async () => {
  const { sqlite, db, runAutomaticBookingRefundSweep } = await seedRefund();
  sqlite.prepare("UPDATE payment_gateway_links SET environment='live' WHERE payment_id=?").run(PAYMENT);
  addCase(sqlite, "RC-ENVMIX", 1000);
  const report = await runAutomaticBookingRefundSweep(db, ENV, {});
  assert.equal(report.failed, 1);
  assert.match(String(report.errors[0]), /environment mismatch/i);
});
