import test from "node:test";
import assert from "node:assert/strict";

const { groomingLivePriceState } = await import("../lib/grooming-live-price-state.ts");

// Staging refused every prepaid Grooming booking with
//   409 — Submitted Grooming total does not match governed catalogue 2026-08-07.v2
// while pay-after succeeded seconds earlier on the same package and window. The cause was not the
// payment mode: the checkout re-ran its live-price effect on every render (its dependency array
// held freshly-built `pack` / `serviceLocation` objects), and each run reset the resolved price to
// null before refetching. Clicking "Pay online" is a render, so the price was in flight at exactly
// the moment Confirm was pressed, and the booking went out at the hardcoded bundle price while the
// server resolved the live Pricing Control price.

const BUNDLE = 1899, LIVE = 1699;

test("a settled live price is what the customer is quoted", () => {
  const state = groomingLivePriceState({ isSubscription: false, livePrice: LIVE, fallbackPrice: BUNDLE, liveQuoteInFlight: false });
  assert.equal(state.price, LIVE);
  assert.equal(state.pending, false, "a resolved live price must not hold up Confirm");
});

test("a live price still in flight is pending, so Confirm cannot submit the fallback", () => {
  const state = groomingLivePriceState({ isSubscription: false, livePrice: null, fallbackPrice: BUNDLE, liveQuoteInFlight: true });
  assert.equal(state.pending, true, "booking must be held while the governed price is unknown");
});

test("the in-flight window does not quote a price the server will refuse", () => {
  // The regression in one line: whenever the quoted figure is the fallback and a live price could
  // still arrive and differ, the booking must not be submittable. `submittable` mirrors the screen's
  // own gate — Confirm is enabled only when the price is not pending.
  const state = groomingLivePriceState({ isSubscription: false, livePrice: null, fallbackPrice: BUNDLE, liveQuoteInFlight: true });
  const submittable = !state.pending;
  assert.equal(state.price, BUNDLE, "the fallback is still what the screen shows");
  assert.equal(submittable, false, "a fallback price must never be submittable while the live quote is outstanding");
});

test("a settled quote with no Pricing Control row books at the bundle price", () => {
  // resolveLivePrice returns the caller's fallback when no active row exists, so client and server
  // agree on the bundle price. Holding Confirm here would strand every city without a live row.
  const state = groomingLivePriceState({ isSubscription: false, livePrice: null, fallbackPrice: BUNDLE, liveQuoteInFlight: false });
  assert.equal(state.price, BUNDLE);
  assert.equal(state.pending, false);
});

test("a subscription visit is never held on a live quote", () => {
  const state = groomingLivePriceState({ isSubscription: true, livePrice: null, fallbackPrice: 2499, liveQuoteInFlight: true });
  assert.equal(state.price, 2499);
  assert.equal(state.pending, false, "subscription pricing is governed by the plan, not Pricing Control");
});

test("a resolved live price wins even while another refetch is in flight", () => {
  // The fix stops nulling the last good price on refetch, so revalidation must not reintroduce the
  // window this test exists to close.
  const state = groomingLivePriceState({ isSubscription: false, livePrice: LIVE, fallbackPrice: BUNDLE, liveQuoteInFlight: true });
  assert.equal(state.price, LIVE);
  assert.equal(state.pending, false);
});
