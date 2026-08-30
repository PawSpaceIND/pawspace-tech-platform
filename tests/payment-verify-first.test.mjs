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
  assert.match(client, /const RAZORPAY_API = "https:\/\/api\.razorpay\.com"/);
  assert.match(client, /providerRequest\(env, environment, "\/v1\/orders"/);
  assert.match(client, /AbortController/);
});

test("Verify-first: prepaid online bookings cannot self-capture in LIVE mode (sandbox unchanged)", () => {
  // the gate exists and is LIVE-only + excludes subscriptions
  assert.match(bookingRoute, /function recordedPaymentStatus/);
  // This used to pin the condition verbatim, INCLUDING the two mode names it tested for. The platform
  // also uses "full" and "split", so the guard it was pinning let those bypass verification entirely —
  // and this assertion passed the whole time, because the source matched the source. The gate no longer
  // consults payment.mode at all; the behaviour is exercised across every mode in
  // tests/live-payment-integrity.test.mjs.
  assert.match(bookingRoute, /liveMode&&payment\.status==="captured"&&!offlineAuthorized\)return "created"/);
  assert.doesNotMatch(bookingRoute, /liveMode&&ONLINE_METHODS\.has\(payment\.method\)&&payment\.status==="captured"/, "an online-method allowlist let an off-list method through — the demotion keys off server authorization now");
  assert.doesNotMatch(bookingRoute, /payment\.mode==="prepaid"\|\|payment\.mode==="split_50_50"/, "LIVE financial truth must not depend on a client-supplied mode label");
  // Nor on whether the purchase happens to be a subscription: that carve-out was PAY-002 defect 1.
  assert.doesNotMatch(bookingRoute, /!isSubscription/, "no payment class may be exempt from LIVE verification");
  assert.match(bookingRoute, /return payment\.status/); // sandbox/UAT keeps the submitted status
  // The environment decision moved into lib/payment-environment.ts (W2-07-PAY-003): an ABSENT
  // PAWSPACE_PAYMENT_ENV used to resolve to "sandbox" and exempt the booking from verification, so the
  // route now asks for an EXPLICIT sandbox declaration. Pinned on the call, and exercised behaviourally
  // in tests/ptja-p1-regressions.test.mjs ("W2-PAY-07").
  assert.match(bookingRoute, /sandboxCapabilitiesUnlocked\(env/, "the environment is still read from the Worker env, via the shared resolver");
  assert.doesNotMatch(bookingRoute, /PAWSPACE_PAYMENT_ENV\s*\|\|\s*"sandbox"/, "an absent variable must not resolve to sandbox and unlock the verify-first exemption");
  // the payment insert now records the gated status, not the raw client value
  assert.match(bookingRoute, /paymentStatusPersisted=sittingCapture\?\.status\?\?paymentStatusRecorded/);
  assert.match(bookingRoute, /input\.payment\.method,paymentModePersisted,paymentStatusPersisted,/);
  // customer order intent never self-captures; stays awaiting_payment
  assert.match(intent, /status: "awaiting_payment"/);
  assert.match(intent, /if \(execution\.claimed && !execution\.connected\)/);
  assert.match(intent, /return \{ connected: false, environment, reason: execution\.reason/);
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
