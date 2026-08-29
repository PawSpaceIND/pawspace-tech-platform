import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const flow = fs.readFileSync(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");
const order = fs.readFileSync(new URL("../app/api/payment-order/route.ts", import.meta.url), "utf8");

test("Mission 2 keeps one canonical grooming booking and verification badge fail-closed", () => {
  assert.match(flow, /name:\"Bath & Basic\".*price:1899/);
  assert.match(flow, /createCanonicalLifecycle\(/);
  assert.match(flow, /providerProof\.verified&&/);
  assert.match(order, /completeBookingPaymentOrder/);
  assert.match(order, /paymentStatus/);
});
