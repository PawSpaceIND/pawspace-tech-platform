import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Grooming fails closed until a governed address is resolved and saved for routing", async () => {
  const [flow, picker, route] = await Promise.all([
    read("app/mobile-app/grooming-flow.tsx"),
    read("app/mobile-app/address-picker.tsx"),
    read("app/api/grooming-service-location/route.ts"),
  ]);
  assert.match(picker, /resolveServiceCoverage\(pincode\)/);
  assert.match(picker, /complete doorstep address/i);
  assert.match(flow, /if\(!serviceLocation\)/);
  assert.match(flow, /zoneId=serviceLocation\.assignment\.zoneId/);
  assert.match(flow, /saveServiceLocation/);
  assert.doesNotMatch(flow, /All Bengaluru pincodes are covered/);
  assert.doesNotMatch(flow, /\d groomers available/);
  assert.match(route, /resolveZoneByPincode\(db, pincode\)/);
  assert.match(route, /verified address zone does not match the booking reservation/i);
  assert.match(route, /booking_service_locations/);
  assert.match(route, /customer_addresses/);
});

test("Grooming carries the governed coupon quote through final confirmation", async () => {
  const [flow, coupon, bookingRoute, governance] = await Promise.all([
    read("app/mobile-app/grooming-flow.tsx"),
    read("app/mobile-app/coupon-field.tsx"),
    read("app/api/canonical-bookings/route.ts"),
    read("lib/coupon-governance.ts"),
  ]);
  assert.match(coupon, /onDiscountChange\(result\.discount, result\.code, result\.quoteId\)/);
  assert.match(coupon, /Booking details changed — apply the coupon again/);
  assert.match(flow, /couponQuoteId/);
  assert.match(flow, /couponQuoteId:couponQuoteId\|\|undefined/);
  assert.match(flow, /addOns:addons/);
  assert.match(bookingRoute, /couponCommercial\.redemptionStatement,couponCommercial\.claimStatement/);
  assert.match(bookingRoute, /groomingAddOnPrices/);
  assert.match(governance, /D1 rolls the booking back with it/);
  assert.match(governance, /coupon_redemptions[\s\S]*campaign_id[\s\S]*NOT NULL/);
});

test("Embedded Sitting uses the governed quote, sandbox capture and canonical Sitting booking", async () => {
  const flow = await read("app/mobile-app/stay-flow.tsx");
  for (const token of ["createSittingQuote", "captureSittingQuoteSandbox", "createCanonicalSittingBooking", "sittingQuoteId:quote.quoteId", "serviceCode:mode===\"boarding\"?\"boarding\":\"pet_sitting\""]) {
    assert.ok(flow.includes(token), `missing ${token}`);
  }
  assert.match(flow, /coupons are disabled until that service has an explicit canonical redemption policy/);
  assert.doesNotMatch(flow, /Partner accepted · live calendar verified/);
  assert.doesNotMatch(flow, /<CouponField/);
});
