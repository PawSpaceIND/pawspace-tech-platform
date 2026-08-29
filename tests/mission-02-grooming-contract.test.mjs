import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const flow = fs.readFileSync(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");
const lifecycle = fs.readFileSync(new URL("../lib/canonical-lifecycle-client.ts", import.meta.url), "utf8");
const order = fs.readFileSync(new URL("../app/api/payment-order/route.ts", import.meta.url), "utf8");

test("Mission 2 keeps one canonical grooming booking and gates verification badge", () => {
  assert.match(flow, /name:\"Bath & Basic\".*price:1899/);
  assert.equal((flow.match(/createCanonicalLifecycle\(/g) || []).length, 1);
  assert.match(flow, /providerProof\.verified&&/);
});

test("Mission 2 grooming prepaid path uses real Razorpay Checkout and authoritative capture", () => {
  assert.match(lifecycle, /openRazorpayCheckout/);
  assert.match(lifecycle, /action:\"complete\"/);
  assert.match(lifecycle, /paymentStatus!==\"captured\"/);
  assert.doesNotMatch(lifecycle, /training-payment-sandbox.*grooming/);
  assert.match(order, /completeBookingPaymentOrder/);
  assert.match(order, /paymentStatus/);
});
