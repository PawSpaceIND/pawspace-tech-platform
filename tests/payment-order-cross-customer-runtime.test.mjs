import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

async function assertPaymentGatewayAllows(ctx, cookie, body) {
  const request = new Request("https://uat.pawspace.in/api/payment-order", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, ctx.db);
  const access = sessionAccess ?? await authorizeApiRequest(request, { DB: ctx.db });
  if (access instanceof Response) assert.fail(`production gateway denied payment-order request with ${access.status}`);
  assert.equal(access.permission, "scheduling.book", "production gateway must map payment-order to scheduling.book");
  assert.equal(access.actor.roleCode, "customer", "production gateway must resolve the customer platform session");
}

function gatewayLinksSnapshot(sqlite, bookingId) {
  const exists = Boolean(sqlite.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='payment_gateway_links'").get());
  return {
    exists,
    rows: exists ? sqlite.prepare("SELECT * FROM payment_gateway_links WHERE booking_id=? ORDER BY rowid").all(bookingId) : [],
  };
}

test("customer cannot open a payment order for another customer's booking", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);

  const ownerId = "CUST-PAYMENT-OWNER";
  const attackerId = "CUST-PAYMENT-ATTACKER";
  const groupId = "GROOM-PAYMENT-BINDING";
  const petSourceId = "PET-PAYMENT-BINDING";
  const start = new Date(Date.UTC(2026, 10, 26, 4, 30));
  const end = new Date(start.getTime() + 2 * 60 * 60_000);
  const ownerCookie = await sessionCookie(ctx.db, "customer", ownerId, `customer:${ownerId}`);
  const attackerCookie = await sessionCookie(ctx.db, "customer", attackerId, `customer:${attackerId}`);

  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: groupId,
    customerId: ownerId,
    petIds: [petSourceId],
    serviceCode: "grooming",
    cityId: "blr",
    zoneId: "blr-east",
    scheduledStart: start.toISOString(),
    scheduledEnd: end.toISOString(),
    preferredProviderId: "groom_arun",
  }, ownerCookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  assert.ok(scheduled.body.data?.provider, "scheduling must assign the seeded Bengaluru groomer");

  const booked = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", {
    idempotencyKey: groupId,
    scheduleGroupId: groupId,
    customer: { id: ownerId, name: "Payment Owner", primaryPhone: "+919900000707" },
    pets: [{ sourceId: petSourceId, name: "Milo", species: "dog", breed: "Indie", vaccinationStatus: "vaccinated" }],
    cityId: "blr",
    zoneId: "blr-east",
    serviceCode: "grooming",
    packageCode: "dog-basic",
    packageName: "Bath & Basic",
    scheduledStart: start.toISOString(),
    scheduledEnd: end.toISOString(),
    provider: scheduled.body.data.provider,
    totalAmount: 1899,
    amountDueNow: 1899,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "payment binding proof" },
    pricing: { discount: 0 },
  }, ownerCookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const bookingId = String(booked.body.data?.bookingId || "");
  assert.ok(bookingId, "booking setup must produce a canonical booking");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId)?.status, "created", "proof must begin before payment capture");

  const ownerRequest = { customerId: ownerId, bookingId };
  await assertPaymentGatewayAllows(ctx, ownerCookie, ownerRequest);
  const owner = await routeCall("../../app/api/payment-order/route.ts", "POST", "/api/payment-order", ownerRequest, ownerCookie);
  assert.ok([200, 201].includes(owner.status), `owner payment-order request must be allowed, got ${owner.status}: ${JSON.stringify(owner.body)}`);

  const linksBefore = gatewayLinksSnapshot(ctx.sqlite, bookingId);
  const paymentsBefore = ctx.sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id=? ORDER BY rowid").all(bookingId);
  assert.equal(paymentsBefore.length, 1, "booking setup must create one canonical payment row");

  const attackerRequest = { customerId: attackerId, bookingId };
  await assertPaymentGatewayAllows(ctx, attackerCookie, attackerRequest);
  const rejected = await routeCall("../../app/api/payment-order/route.ts", "POST", "/api/payment-order", attackerRequest, attackerCookie);

  assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
  assert.deepEqual(gatewayLinksSnapshot(ctx.sqlite, bookingId), linksBefore, "cross-customer payment attempt must not create or mutate gateway links");
  assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id=? ORDER BY rowid").all(bookingId), paymentsBefore, "cross-customer payment attempt must not mutate any payment field");
});