/**
 * QA (M6): the Booking Command Center showed "Payment pending 1" and "Open revenue Rs 1,241 due now" for a
 * cancelled booking whose Rs 1,241 was being refunded. Closed bookings are no longer money to collect.
 */
import test from "node:test";
import assert from "node:assert/strict";
const { awaitingPayment } = await import("../lib/booking-payment-kpis.ts");

test("a cancelled booking with a refund pending is not payment pending", () => {
  assert.equal(awaitingPayment({ status: "cancelled", payment_status: "refund_pending" }), false);
  assert.equal(awaitingPayment({ status: "cancelled", payment_status: "captured" }), false);
  assert.equal(awaitingPayment({ status: "confirmed", payment_status: "refunded" }), false);
});
test("unpaid live bookings, including pay after service, still count", () => {
  assert.equal(awaitingPayment({ status: "payment_pending", payment_status: "created" }), true);
  assert.equal(awaitingPayment({ status: "confirmed", payment_status: "created" }), true);
  assert.equal(awaitingPayment({ status: "confirmed", payment_status: "captured" }), false);
});
