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
function network(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url: String(url), body });
    if (url === "/api/uat-scheduling") return Response.json({ data: { groupId: body.clientRequestId, provider: { id: "PRV1", name: "Care Professional", model: "full_time" } } });
    if (url === "/api/canonical-bookings") return Response.json({ data: { bookingId: "B1", customerId: body.customer.id, petIds: ["PET-1"], scheduleGroupId: body.scheduleGroupId, workOrderId: "WO1", paymentId: "P1", status: "payment_pending", duplicatePrevented: false } });
    if (url === "/api/grooming-service-location") return Response.json({ data: { bookingId: body.bookingId, addressSaved: true, coordinatesSaved: true } });
    throw new Error(`Unexpected test network call ${url}`);
  });
  return calls;
}

test("V2 books the discounted total with the governed coupon quote", async (t) => {
  const calls = network(t);
  await client.createV2GroomingBooking(input({ quoteId: "CPQ-1", code: "GROOM200", discount: 200 }));
  const sent = calls.find((call) => call.url === "/api/canonical-bookings").body;
  assert.equal(sent.totalAmount, 1699); assert.equal(sent.amountDueNow, 1699);
  assert.deepEqual(sent.pricing, { discount: 200, couponCode: "GROOM200", couponQuoteId: "CPQ-1" });
});

test("without a coupon V2 still sends the full live price, and a coupon makes its own booking key", async (t) => {
  const calls = network(t);
  await client.createV2GroomingBooking(input());
  const sent = calls.find((call) => call.url === "/api/canonical-bookings").body;
  assert.equal(sent.totalAmount, 1899); assert.deepEqual(sent.pricing, { discount: 0 });
  assert.notEqual(await client.v2GroomingIdempotencyKey(input({ quoteId: "CPQ-1", code: "GROOM200", discount: 200 })), await client.v2GroomingIdempotencyKey(input()));
});

test("a coupon without a live quote, or larger than the price, never reaches the booking", async (t) => {
  const calls = network(t);
  for (const coupon of [{ quoteId: "", code: "GROOM200", discount: 200 }, { quoteId: "CPQ-1", code: "GROOM200", discount: 5000 }, { quoteId: "CPQ-1", code: "GROOM200", discount: 0 }]) {
    await assert.rejects(client.createV2GroomingBooking(input(coupon)), /Reapply the coupon/);
  }
  assert.equal(calls.length, 0, "nothing is reserved for a coupon that has to be reapplied");
});

test("the V2 page quotes coupons through its own box and blocks checkout while a code awaits its quote", async () => {
  const page = await readFile(new URL("../app/v2/grooming/page.tsx", import.meta.url), "utf8");
  const box = await readFile(new URL("../app/v2/grooming/coupon-box.tsx", import.meta.url), "utf8");
  assert.match(page, /<V2GroomingCouponBox key=\{`\$\{quote\.price\}\|\$\{bundle\.packageCode\}\|\$\{scheduledStart\}/);
  assert.match(page, /couponNeedsReapply\(coupon\.code, coupon\.quoteId\)/);
  assert.match(box, /quoteGovernedCoupon\(\{ code: normalized, customerId, serviceCode: "grooming", cityId, channel: "website", packageCode, orderValue/);
  assert.doesNotMatch(page + box, /from ["'][^"']*mobile-app\//);
});
