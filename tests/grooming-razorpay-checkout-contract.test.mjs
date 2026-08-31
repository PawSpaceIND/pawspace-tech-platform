import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Grooming customer checkout reuses the durable verify-first payment order boundary", async () => {
  const [route, intent] = await Promise.all([
    source("app/api/payment-order/route.ts"),
    source("lib/payment-order-intent.ts"),
  ]);
  assert.match(route, /createBookingPaymentOrder/);
  assert.match(intent, /claimPaymentIntent/);
  assert.match(intent, /executeRazorpayOrderOutbox/);
  assert.match(intent, /idempotencyKey = `payment-order:/);
  assert.match(intent, /gatewayOrderId: orderId/);
});

test("Razorpay browser callback is verified against PawSpace's stored order and cannot mark captured", async () => {
  const [route, verifier] = await Promise.all([
    source("app/api/payment-order/route.ts"),
    source("lib/razorpay-checkout-verification.ts"),
  ]);
  assert.match(route, /action==="verify_checkout"/);
  assert.match(route, /gateway_order_id/);
  assert.match(route, /verifyRazorpayCheckoutSignature/);
  assert.match(route, /awaiting_webhook_capture/);
  assert.doesNotMatch(route, /payment_status='captured'/);
  assert.doesNotMatch(route, /status='captured'.*verify_checkout/s);
  assert.match(verifier, /HMAC/);
  assert.match(verifier, /SHA-256/);
  assert.match(verifier, /`${orderId}\|${paymentId}`/);
});

test("Checkout callback stores pay_ id only after signature verification and fails closed on conflicts", async () => {
  const route = await source("app/api/payment-order/route.ts");
  const verifyAt = route.indexOf("verifyRazorpayCheckoutSignature");
  const updateAt = route.indexOf("UPDATE payment_gateway_links SET gateway_payment_id");
  assert.ok(verifyAt >= 0 && updateAt > verifyAt, "gateway payment id must be persisted only after signature verification");
  assert.match(route, /checkout_signature_invalid/);
  assert.match(route, /checkout_payment_conflict/);
  assert.match(route, /gateway_payment_id IS NULL OR gateway_payment_id='' OR gateway_payment_id=\?/);
});

test("Customer payment status remains backend-derived and exposes reconciliation truth", async () => {
  const route = await source("app/api/payment-order/route.ts");
  assert.match(route, /verifiedCaptured:paymentStatus==="captured"/);
  assert.match(route, /capturedAmount/);
  assert.match(route, /refundedAmount/);
  assert.match(route, /varianceAmount/);
  assert.match(route, /reconciliationStatus/);
});
