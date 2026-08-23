import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

test("customer cannot open a payment order for another customer's booking", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);

  const ownerId = "CUST-PAYMENT-OWNER";
  const attackerId = "CUST-PAYMENT-ATTACKER";
  const journey = await runCompletedJourney(ctx, { customerId: ownerId });
  const attackerCookie = await sessionCookie(ctx.db, "customer", attackerId, `customer:${attackerId}`);
  const bookingId = String(journey.bookingId);

  const linksBefore = Number(ctx.sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_links WHERE booking_id=?").get(bookingId).n);
  const paymentBefore = ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId);
  assert.ok(paymentBefore, "journey must create a canonical payment record");

  const rejected = await routeCall("../../app/api/payment-order/route.ts", "POST", "/api/payment-order", {
    customerId: attackerId,
    bookingId,
  }, attackerCookie);

  assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
  assert.equal(Number(ctx.sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_links WHERE booking_id=?").get(bookingId).n), linksBefore, "cross-customer payment attempt must not create a gateway link");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status, paymentBefore.status, "cross-customer payment attempt must not mutate payment state");
});
