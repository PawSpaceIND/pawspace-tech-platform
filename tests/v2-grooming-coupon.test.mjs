/**
 * The V2 grooming checkout takes a governed coupon (GROOM200 / GROOM400 or any eligible campaign). The
 * server quotes it for the exact live price, and the canonical booking is sent the discounted total with
 * that quote, which the booking re-checks and consumes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__V2_COUPON_DB__", "__V2_COUPON_ENV__");
const client = await import("../lib/v2/grooming-checkout-client.ts");
const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
function input(coupon) {
  const pet = { id: "PET-1", sourceId: "PET-1", name: "Bruno", species: "dog", breed: "Labrador", vaccinationStatus: "verified" };
  const bundle = { petCount: 1, packageCode: "dog-basic", price: 1899, currency: "INR", slotMinutes: 120, blockingMinutes: 150, effectiveFrom: "2020-01-01", effectiveTo: null };
  return { account: { customerId: "C1", name: "V2 customer", primaryPhone: "9000000901", pets: [pet] }, selectedPets: [pet],
    pkg: { code: "dog-basic", name: "Bath & Basic", audience: "dog", bundles: [bundle] }, bundle,
    quote: { price: 1899, source: "pricing_control" }, provider: { id: "PRV1", name: "Care Professional", model: "full_time" },
    address: "21 HSR Main Road", pincode: "560102", cityId: "blr", zoneId: "blr-south",
    scheduledStart: `${future}T05:30:00.000Z`, scheduledEnd: `${future}T07:30:00.000Z`, ...(coupon ? { coupon } : {}) };
}
function network(t, fresh = { valid: true, quoteId: "CPQ-FRESH", code: "GROOM200", discount: 200, finalAmount: 1699 }) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url: String(url), body });
    if (url === "/api/coupon-governance") return Response.json({ data: fresh });
    if (url === "/api/uat-scheduling") return Response.json({ data: { groupId: body.clientRequestId, provider: { id: "PRV1", name: "Care Professional", model: "full_time" } } });
    if (url === "/api/canonical-bookings") return Response.json({ data: { bookingId: "B1", customerId: body.customer.id, petIds: ["PET-1"], scheduleGroupId: body.scheduleGroupId, workOrderId: "WO1", paymentId: "P1", status: "payment_pending", duplicatePrevented: false } });
    if (url === "/api/grooming-service-location") return Response.json({ data: { bookingId: body.bookingId, addressSaved: true, coordinatesSaved: true } });
    throw new Error(`Unexpected test network call ${url}`);
  });
  return calls;
}

test("V2 re-quotes the coupon before reserving and books the server's fresh discount and quote", async (t) => {
  const calls = network(t);
  await client.createV2GroomingBooking(input({ quoteId: "CPQ-1", code: "GROOM200", discount: 999 }));
  assert.deepEqual(calls.map((call) => call.url), ["/api/coupon-governance", "/api/uat-scheduling", "/api/canonical-bookings", "/api/grooming-service-location"]);
  assert.deepEqual(calls[0].body.input, { code: "GROOM200", customerId: "C1", serviceCode: "grooming", cityId: "blr", channel: "website", packageCode: "dog-basic", orderValue: 1899, paymentMode: "full", isSubscription: false });
  const sent = calls.find((call) => call.url === "/api/canonical-bookings").body;
  assert.equal(sent.totalAmount, 1699, "the client's shown discount is never trusted"); assert.equal(sent.amountDueNow, 1699);
  assert.deepEqual(sent.pricing, { discount: 200, couponCode: "GROOM200", couponQuoteId: "CPQ-FRESH" });
});

test("a coupon that expired or ran out since it was applied is refused before the slot is reserved", async (t) => {
  const calls = network(t, { valid: false, discount: 0, error: "Customer has reached this coupon's usage limit" });
  await assert.rejects(client.createV2GroomingBooking(input({ quoteId: "CPQ-1", code: "GROOM200", discount: 200 })), /usage limit\. Remove or reapply the coupon/);
  assert.deepEqual(calls.map((call) => call.url), ["/api/coupon-governance"], "nothing is reserved");
});

test("without a coupon V2 still sends the full live price, and a coupon makes its own booking key", async (t) => {
  const calls = network(t);
  await client.createV2GroomingBooking(input());
  const sent = calls.find((call) => call.url === "/api/canonical-bookings").body;
  assert.equal(sent.totalAmount, 1899); assert.deepEqual(sent.pricing, { discount: 0 });
  assert.notEqual(await client.v2GroomingIdempotencyKey(input({ quoteId: "CPQ-1", code: "GROOM200", discount: 200 })), await client.v2GroomingIdempotencyKey(input()));
  assert.equal(await client.v2GroomingIdempotencyKey(input({ quoteId: "CPQ-1", code: "GROOM200", discount: 200 })), await client.v2GroomingIdempotencyKey(input({ quoteId: "CPQ-2", code: "GROOM200", discount: 200 })), "a retry with a re-quoted coupon keeps the same booking");
});

test("a coupon still waiting for its quote, or a server discount above the price, never reaches the booking", async (t) => {
  let calls = network(t);
  await assert.rejects(client.createV2GroomingBooking(input({ quoteId: "", code: "GROOM200", discount: 200 })), /Reapply the coupon/);
  assert.equal(calls.length, 0);
  t.mock.restoreAll(); calls = network(t, { valid: true, quoteId: "CPQ-X", code: "GROOM200", discount: 5000 });
  await assert.rejects(client.createV2GroomingBooking(input({ quoteId: "CPQ-1", code: "GROOM200", discount: 200 })), /Reapply the coupon/);
  assert.deepEqual(calls.map((call) => call.url), ["/api/coupon-governance"]);
});

test("the V2 page quotes coupons through its own box and blocks checkout while a code awaits its quote", async () => {
  const page = await readFile(new URL("../app/v2/grooming/page.tsx", import.meta.url), "utf8");
  const box = await readFile(new URL("../app/v2/grooming/coupon-box.tsx", import.meta.url), "utf8");
  assert.match(page, /<V2GroomingCouponBox key=\{`\$\{quote\.price\}\|\$\{bundle\.packageCode\}\|\$\{scheduledStart\}/);
  assert.match(page, /couponNeedsReapply\(coupon\.code, coupon\.quoteId\)/);
  assert.match(box, /quoteGovernedCoupon\(\{ code: normalized, customerId, serviceCode: "grooming", cityId, channel: "website", packageCode, orderValue/);
  assert.doesNotMatch(page + box, /from ["'][^"']*mobile-app\//);
});
