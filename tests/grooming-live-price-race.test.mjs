import test from "node:test";
import assert from "node:assert/strict";

const { groomingLivePriceState } = await import("../lib/grooming-live-price-state.ts");

// Staging refused every prepaid Grooming booking with
//   409 — Submitted Grooming total does not match governed catalogue 2026-08-07.v2
// The server resolves the live Pricing Control price for every Grooming booking, so the screen may
// only book at a price it has actually received from the server for THIS basket. These cases pin
// each way the checkout has got that wrong.

const BUNDLE = 1899, LIVE = 1699;
const BATH_SAT_9AM = "groom-dog-bath-1|2026-09-26T03:30:00.000Z|blr|blr-central";
const BATH_SAT_1PM = "groom-dog-bath-1|2026-09-26T07:30:00.000Z|blr|blr-central";
const submittable = state => !state.pending;

test("a resolved quote for the basket on screen is what the customer is quoted and can book", () => {
  const state = groomingLivePriceState({ isSubscription: false, currentKey: BATH_SAT_9AM, quote: { key: BATH_SAT_9AM, status: "resolved", price: LIVE }, fallbackPrice: BUNDLE });
  assert.equal(state.price, LIVE);
  assert.equal(submittable(state), true);
});

test("the original defect: no quote yet for this basket holds Confirm rather than booking the fallback", () => {
  // Before the fix the screen blanked its price on every re-render and fell back to the bundle, so a
  // Confirm pressed while the quote was in flight went out at the wrong number.
  const state = groomingLivePriceState({ isSubscription: false, currentKey: BATH_SAT_9AM, quote: null, fallbackPrice: BUNDLE });
  assert.equal(submittable(state), false, "the bundle price must not be bookable while the live quote is outstanding");
});

test("review finding: a quote for the previous basket is stale and neither displayed nor bookable", () => {
  // Keeping the last price across a refetch let a customer who changed slot book at the OLD slot's
  // price. The earlier version of this file asserted that as correct.
  const state = groomingLivePriceState({ isSubscription: false, currentKey: BATH_SAT_1PM, quote: { key: BATH_SAT_9AM, status: "resolved", price: LIVE }, fallbackPrice: BUNDLE });
  assert.notEqual(state.price, LIVE, "another basket's price must not be shown");
  assert.equal(submittable(state), false, "another basket's price must not be bookable");
});

test("review finding: a failed quote holds Confirm and says so, because failure is not 'no row'", () => {
  // The quote endpoint answers a basket with no Pricing Control row with a resolved price. A failure
  // therefore means the server has a price we could not read, and booking on the bundle could be
  // refused — exactly the 409 this change exists to remove.
  const state = groomingLivePriceState({ isSubscription: false, currentKey: BATH_SAT_9AM, quote: { key: BATH_SAT_9AM, status: "failed" }, fallbackPrice: BUNDLE });
  assert.equal(submittable(state), false, "a failed quote must never unblock Confirm");
  assert.equal(state.failed, true, "the screen must be able to tell the customer and offer a retry");
});

test("a basket with no Pricing Control row books at the bundle price, as the server will", () => {
  // resolveLivePrice returns the caller's fallback when no active row exists, and the endpoint sends
  // it back as a normal resolved quote — so this case must NOT be held, or every city without a
  // live row would be unable to book.
  const state = groomingLivePriceState({ isSubscription: false, currentKey: BATH_SAT_9AM, quote: { key: BATH_SAT_9AM, status: "resolved", price: BUNDLE }, fallbackPrice: BUNDLE });
  assert.equal(state.price, BUNDLE);
  assert.equal(submittable(state), true);
});

test("a subscription visit is never held on a live quote", () => {
  const state = groomingLivePriceState({ isSubscription: true, currentKey: BATH_SAT_9AM, quote: null, fallbackPrice: 2499 });
  assert.equal(state.price, 2499);
  assert.equal(submittable(state), true, "subscription pricing is governed by the plan, not Pricing Control");
});

test("no live quote applies before the address is verified", () => {
  const state = groomingLivePriceState({ isSubscription: false, currentKey: "", quote: null, fallbackPrice: BUNDLE });
  assert.equal(state.price, BUNDLE);
  assert.equal(state.pending, false, "the address gate already holds Confirm here; the price must not add a second, silent hold");
});
