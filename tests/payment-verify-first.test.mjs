import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const client = await read("../lib/razorpay-client.ts");
const intent = await read("../lib/payment-order-intent.ts");
const recon = await read("../lib/grooming-payment-reconciliation.ts");
const bookingRoute = await read("../app/api/canonical-bookings/route.ts");
const orderRoute = await read("../app/api/payment-order/route.ts");
const reconRoute = await read("../app/api/payment-reconciliation/route.ts");

test("Razorpay adapter is environment-aware and fails closed", () => {
  assert.match(client, /if \(!keyId \|\| !keySecret\) return \{ connected: false/);
  assert.match(client, /RAZORPAY_KEY_ID_SANDBOX/);
  assert.match(client, /env\?\.RAZORPAY_KEY_ID\b/);
  assert.match(client, /https:\/\/api\.razorpay\.com\/v1\/orders/);
});

test("Verify-first: prepaid online bookings cannot self-capture in LIVE mode (sandbox unchanged)", () => {
  // the gate exists and is LIVE-only + excludes subscriptions
  assert.match(bookingRoute, /function recordedPaymentStatus/);
  assert.match(bookingRoute, /if\(liveMode&&!isSubscription&&payment\.mode==="prepaid"&&ONLINE_METHODS\.has\(payment\.method\)&&payment\.status==="captured"\)return "created"/);
  assert.match(bookingRoute, /return payment\.status/); // sandbox/UAT keeps the submitted status
  assert.match(bookingRoute, /PAWSPACE_PAYMENT_ENV/);
  // the payment insert now records the gated status, not the raw client value
  assert.match(bookingRoute, /input\.payment\.mode,paymentStatusRecorded,/);
  // customer order intent never self-captures; stays awaiting_payment
  assert.match(intent, /status: "awaiting_payment"/);
  assert.match(intent, /if \(!created\.connected\) return \{ connected: false/);
});

test("Reconciliation matches by ID (never by phone) and captures only on verified events", () => {
  // matching is strictly by booking/payment/order id
  assert.match(recon, /WHERE gateway_payment_id=\?/);
  assert.match(recon, /WHERE gateway_order_id=\?/);
  // never compares a phone number to match a payment
  assert.doesNotMatch(recon, /phone/i);
  // capture requires a verified signature
  assert.match(recon, /if\(!event\.signatureVerified\)throw new Error\("Gateway event signature is not verified"\)/);
});

test("Finance manual resolution of unmatched/direct payments exists and is gated", () => {
  assert.match(recon, /export async function resolvePaymentException/);
  assert.match(recon, /export async function listPaymentExceptions/);
  assert.match(recon, /Only an unmatched gateway payment can be attached to a booking/);
  assert.match(recon, /Amount mismatch: booking expects/);
  assert.match(orderRoute, /requireCustomerOwnership/);
  assert.match(reconRoute, /requirePermission\(actor,"finance\.view"\)/);
  assert.match(reconRoute, /requirePermission\(actor,"finance\.manage"\)/);
});
