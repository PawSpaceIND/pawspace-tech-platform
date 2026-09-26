/*
 * A booking can hold more than one captured Razorpay payment: a Stay or Taxi balance, and now the
 * difference a customer pays to move a Grooming booking to a dearer slot. Three defects made the second
 * capture unsafe:
 *
 *   1. The second capture overwrote payment_gateway_links.gateway_payment_id, so the booking's link
 *      pointed at the newest, smaller payment and a refund went there.
 *   2. A capture refused as capture_amount_mismatch wrote ITS amount as the collected total, wiping out
 *      every earlier capture (Rs 1,899 + Rs 285 collected read Rs 99).
 *   3. The refund sweep refunded one gateway payment per booking, so a refund larger than that payment
 *      could never succeed. It now splits the refund across the captured payments, newest first, each
 *      part capped at what is left of that payment.
 *
 * Real modules on in-memory node:sqlite through the grooming journey harness: real booking, signed
 * webhooks through the real /api/razorpay-webhook route (HMAC computed here, no network), the real
 * cancellation route and the real refund sweep. Razorpay's refund API is answered by a local stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setupJourney, runCompletedJourney, routeCall } from "./helpers/grooming-journey-harness.mjs";

const WEBHOOK_SECRET = "multi_capture_webhook_secret";

/** Razorpay's refund endpoint, answered locally. Any other outbound call fails the test. */
function stubRazorpayRefunds(t) {
  const refunds = [], original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const match = /^https:\/\/api\.razorpay\.com\/v1\/payments\/([^/]+)\/refund$/.exec(String(url));
    if (!match || init.method !== "POST") throw new Error(`Unexpected network call in a local test: ${init.method || "GET"} ${url}`);
    const body = JSON.parse(String(init.body));
    const refund = { id: `rfnd_${refunds.length + 1}`, payment_id: decodeURIComponent(match[1]), amount: body.amount, notes: body.notes };
    refunds.push(refund);
    return new Response(JSON.stringify(refund), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
  return refunds;
}

async function paidBooking(t, id) {
  const ctx = await setupJourney(); t.after(ctx.close);
  Object.assign(globalThis.__GROOM_GOLDEN_ENV__, { RAZORPAY_WEBHOOK_SECRET_SANDBOX: WEBHOOK_SECRET, RAZORPAY_KEY_ID_SANDBOX: "rzp_test_multi", RAZORPAY_KEY_SECRET_SANDBOX: "multi_capture_key_secret" });
  const start = new Date(Date.now() + 3 * 86_400_000); start.setUTCHours(3, 30, 0, 0);
  const config = { customerId: `CUST-MC-${id}`, customerName: "Mira", phone: "+919900000616", petSourceId: `PET-MC-${id}`, petName: "Milo", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: `GROOM-MC-${id}`, start: start.toISOString(), stopAfterCapture: true };
  const journey = await runCompletedJourney(ctx, config);
  assert.equal(journey.booked.status, 201, JSON.stringify(journey.booked.body));
  const { sqlite, db } = ctx, bookingId = journey.bookingId;
  const row = (sql, ...args) => { const value = sqlite.prepare(sql).get(...args); return value ? { ...value } : value; };
  const paymentId = row("SELECT id FROM booking_payments WHERE booking_id=?", bookingId).id;
  const { claimPaymentIntent } = await import("../lib/financial-lifecycle.ts");
  /** A second amount on the same booking: its own intent and order, as a reschedule difference is. */
  const additionalIntent = async (key, amountPaise, orderId) => {
    const intent = await claimPaymentIntent(db, { bookingId, customerId: config.customerId, paymentId, idempotencyKey: key, amountPaise, currency: "INR", environment: "sandbox", commercialSnapshot: { paymentStage: "reschedule_difference" } });
    // The outbox saga's persisted provider answer, written here instead of calling Razorpay.
    sqlite.prepare("UPDATE payment_intents SET gateway_order_id=?,order_request_state='ORDER_CREATED' WHERE id=?").run(orderId, intent.id);
    return intent;
  };
  const { POST } = await import("../app/api/razorpay-webhook/route.ts");
  const signedCapture = async (eventId, amount, orderId, gatewayPaymentId) => {
    const raw = JSON.stringify({ event: "payment.captured", created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: gatewayPaymentId, order_id: orderId, amount, currency: "INR", status: "captured", notes: { booking_id: bookingId, payment_id: paymentId } } } } });
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const response = await POST(new Request("https://uat.pawspace.in/api/razorpay-webhook", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": eventId }, body: raw }));
    return { status: response.status, body: await response.json() };
  };
  return { ...ctx, config, journey, bookingId, paymentId, row, additionalIntent, signedCapture };
}

test("a second capture keeps the booking's first gateway payment id and records both captures", async t => {
  const f = await paidBooking(t, "LINK");
  assert.equal(f.row("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id=?", f.bookingId).gateway_payment_id, "pay_GROOM-MC-LINK");
  await f.additionalIntent("difference:LINK:28500", 28500, "order_DIFF_LINK");
  const captured = await f.signedCapture("evt_DIFF_LINK", 28500, "order_DIFF_LINK", "pay_DIFF_LINK");
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(captured.body.atomicCapture, true);

  assert.equal(f.row("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id=?", f.bookingId).gateway_payment_id, "pay_GROOM-MC-LINK",
    "the booking's link still names the payment the booking was paid with");
  const captures = f.sqlite.prepare("SELECT gateway_payment_id,amount_subunits FROM payment_gateway_events WHERE booking_id=? AND event_type='payment.captured' AND processing_status='processed' ORDER BY received_at,rowid").all(f.bookingId).map(row => ({ ...row }));
  assert.deepEqual(captures, [{ gateway_payment_id: "pay_GROOM-MC-LINK", amount_subunits: 189900 }, { gateway_payment_id: "pay_DIFF_LINK", amount_subunits: 28500 }], "each capture is recorded with its own payment id and amount");
  assert.equal(f.row("SELECT gateway_payment_id FROM payment_intents WHERE gateway_order_id='order_DIFF_LINK'").gateway_payment_id, "pay_DIFF_LINK");
  const record = f.row("SELECT expected_amount,captured_amount FROM payment_reconciliation_records WHERE payment_id=?", f.paymentId);
  assert.deepEqual(record, { expected_amount: 2184, captured_amount: 2184 }, "an additional amount adds to what the payment expects instead of replacing it");
});

test("a refused capture keeps the running captured total", async t => {
  const f = await paidBooking(t, "SHORT");
  await f.additionalIntent("difference:SHORT:28500", 28500, "order_DIFF_SHORT");
  assert.equal((await f.signedCapture("evt_DIFF_SHORT", 28500, "order_DIFF_SHORT", "pay_DIFF_SHORT")).status, 200);
  assert.equal(f.row("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id=?", f.paymentId).captured_amount, 2184);

  await f.additionalIntent("difference:SHORT-2:10000", 10000, "order_SHORT_2");
  const short = await f.signedCapture("evt_SHORT_2", 9900, "order_SHORT_2", "pay_SHORT_2");
  assert.equal(short.body.status, "exception", JSON.stringify(short.body));
  assert.equal(short.body.reason, "capture_amount_mismatch");
  const record = f.row("SELECT captured_amount,reconciliation_status FROM payment_reconciliation_records WHERE payment_id=?", f.paymentId);
  assert.equal(record.captured_amount, 2184, "Rs 1,899 + Rs 285 stays collected; the refused Rs 99 does not replace it");
  assert.equal(record.reconciliation_status, "amount_mismatch");
  assert.equal(f.row("SELECT COUNT(*) n FROM payment_reconciliation_exceptions WHERE booking_id=? AND exception_type='capture_amount_mismatch'", f.bookingId).n, 1);
});

test("a refund on a booking with two captures is split across them, newest first, each part capped at its payment", async t => {
  const f = await paidBooking(t, "SPLIT");
  const refunds = stubRazorpayRefunds(t);
  await f.additionalIntent("difference:SPLIT:28500", 28500, "order_DIFF_SPLIT");
  assert.equal((await f.signedCapture("evt_DIFF_SPLIT", 28500, "order_DIFF_SPLIT", "pay_DIFF_SPLIT")).status, 200);
  const cancelled = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change", { bookingId: f.bookingId, customerId: f.config.customerId, action: "cancel", reason: "Plans changed after paying twice" }, f.journey.customerCookie);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const caseId = cancelled.body.data.refundCaseId;
  // Everything collected goes back: the booking price and the second amount.
  f.sqlite.prepare("UPDATE booking_refund_cases SET amount=2184 WHERE id=?").run(caseId);

  const { runAutomaticBookingRefundSweep } = await import("../lib/automatic-booking-refund.ts");
  const report = await runAutomaticBookingRefundSweep(f.db, globalThis.__GROOM_GOLDEN_ENV__, {});
  assert.equal(report.failed, 0, JSON.stringify(report.errors));
  assert.deepEqual(refunds.map(refund => ({ payment: refund.payment_id, paise: refund.amount })), [
    { payment: "pay_DIFF_SPLIT", paise: 28500 },
    { payment: "pay_GROOM-MC-SPLIT", paise: 189900 },
  ], "newest payment first, and no refund larger than the payment it goes back to");
  const cases = f.sqlite.prepare("SELECT id,amount,gateway_payment_id,status,gateway_reference FROM booking_refund_cases WHERE booking_id=? ORDER BY id").all(f.bookingId).map(row => ({ ...row }));
  assert.deepEqual(cases, [
    { id: caseId, amount: 285, gateway_payment_id: "pay_DIFF_SPLIT", status: "processing", gateway_reference: "rfnd_1" },
    { id: `${caseId}-P2`, amount: 1899, gateway_payment_id: "pay_GROOM-MC-SPLIT", status: "processing", gateway_reference: "rfnd_2" },
  ], "one case per Razorpay refund, the amounts adding up to the refund that was asked for");

  // A replay of the sweep sends nothing more.
  await runAutomaticBookingRefundSweep(f.db, globalThis.__GROOM_GOLDEN_ENV__, {});
  assert.equal(refunds.length, 2);
});

test("a refund that names a payment is never larger than what is left of that payment", async t => {
  const f = await paidBooking(t, "CAP");
  const refunds = stubRazorpayRefunds(t);
  await f.additionalIntent("difference:CAP:28500", 28500, "order_DIFF_CAP");
  assert.equal((await f.signedCapture("evt_DIFF_CAP", 28500, "order_DIFF_CAP", "pay_DIFF_CAP")).status, 200);
  const { ensureBookingRefundCaseTargets } = await import("../lib/automatic-booking-refund.ts");
  await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change", { bookingId: f.bookingId, customerId: f.config.customerId, action: "cancel", reason: "Plans changed after paying twice" }, f.journey.customerCookie);
  await ensureBookingRefundCaseTargets(f.db);
  f.sqlite.prepare("DELETE FROM booking_refund_cases WHERE booking_id=?").run(f.bookingId);
  const policy = JSON.stringify({ automatic: true, requiresApproval: false, policyVersion: "test" });
  f.sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,purpose,gateway_payment_id,created_at,updated_at) VALUES ('RC-OVER',?,?,300,'more than the payment','requested','test',?,'reschedule_difference','pay_DIFF_CAP',?,?)").run(f.bookingId, f.paymentId, policy, Date.now(), Date.now());
  const { runAutomaticBookingRefundSweep } = await import("../lib/automatic-booking-refund.ts");
  const report = await runAutomaticBookingRefundSweep(f.db, globalThis.__GROOM_GOLDEN_ENV__, {});
  assert.equal(report.failed, 1);
  assert.match(report.errors[0], /exceed the captured payment pay_DIFF_CAP/);
  assert.equal(refunds.length, 0);
  assert.equal(f.row("SELECT status FROM booking_refund_cases WHERE id='RC-OVER'").status, "requested");
});
