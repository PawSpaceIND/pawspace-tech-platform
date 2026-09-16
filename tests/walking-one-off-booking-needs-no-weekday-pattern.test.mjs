/*
 * Booking a SINGLE dog walk answered 500.
 *
 * lib/walking-governance.ts has two halves of one contract. createWalkingQuote has always written
 * `input.mode === "recurring" ? [...(input.weekdays ?? [])] : []`, so a one-off quote stores an empty
 * weekday pattern and the field is optional on the way in. governWalkingBooking then compared the
 * stored pattern against `[...input.weekdays]` - spread, unguarded, with the field typed as required.
 *
 * A one-off walk has no weekday pattern and no client sends one for it, so the ordinary case died as
 * TypeError "weekdays is not iterable" and reached the customer as
 * 500 {"error":"r.weekdays is not iterable"} at the moment they confirmed the booking.
 *
 * It survived a large walking test suite because every existing fixture passes the field explicitly -
 * tests/walking-taxi-ops-hardening.test.mjs computes `walkCount === 1 ? [] : [...]` and hands over the
 * empty array. Passing [] exercises the comparison; OMITTING it is what breaks, and that is what a
 * browser actually posts. Found by driving /api/walking-bookings against the running worker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__WALK_ONEOFF_DB__");

const FUTURE = () => {
  const start = new Date(Date.now() + 9 * 86_400_000);
  start.setUTCHours(4, 30, 0, 0);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 1_800_000).toISOString() };
};

async function world() {
  const harness = freshCountingD1();
  globalThis.__WALK_ONEOFF_DB__ = harness.db;
  enterWorkersDbScope(harness.db);
  const walking = await import("../lib/walking-governance.ts");
  await walking.ensureWalkingGovernanceTables(harness.db);
  return { harness, walking };
}

/** The arguments a booking sends, minus the weekday pattern the caller chooses to include or not. */
const bookingInput = (quote, window) => ({
  quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
  petCount: 1, walkCount: 1, paymentMode: quote.paymentMode,
  submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
  // One reserved occurrence, because one walk is what was quoted.
  reservations: [{ scheduled_start: window.scheduledStart, scheduled_end: window.scheduledEnd, occurrence_number: 1 }],
  ...window,
});

test("WALK-ONEOFF-1: a one-off walk books when the caller sends no weekday pattern at all", async () => {
  const { walking } = await world();
  const window = FUTURE();
  const quote = await walking.createWalkingQuote(globalThis.__WALK_ONEOFF_DB__, {
    packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1, paymentMode: "pay_after_service", ...window,
  });

  // No `weekdays` key. This is what the booking screen posts for a single walk.
  const governed = await walking.governWalkingBooking(globalThis.__WALK_ONEOFF_DB__, bookingInput(quote, window));
  assert.equal(governed.quoteId, quote.quoteId, "the booking must be governed against its own quote");
  assert.equal(governed.walkCount, 1);
});

test("WALK-ONEOFF-2: an explicit empty pattern still works, so the old callers are unchanged", async () => {
  const { walking } = await world();
  const window = FUTURE();
  const quote = await walking.createWalkingQuote(globalThis.__WALK_ONEOFF_DB__, {
    packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1, paymentMode: "pay_after_service", ...window,
  });
  const governed = await walking.governWalkingBooking(globalThis.__WALK_ONEOFF_DB__, { ...bookingInput(quote, window), weekdays: [] });
  assert.equal(governed.quoteId, quote.quoteId);
});

test("WALK-ONEOFF-3: a pattern that disagrees with the quote is still refused, and governed", async () => {
  /*
   * The guard this defect lived inside is real and must keep its teeth: the weekday pattern is priced,
   * so a booking may not quietly carry a different one. Absence is not disagreement - it is the
   * one-off case - but a DIFFERENT pattern is, and it must refuse with a governed 409 rather than a
   * TypeError.
   */
  const { walking } = await world();
  const window = FUTURE();
  const quote = await walking.createWalkingQuote(globalThis.__WALK_ONEOFF_DB__, {
    packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1, paymentMode: "pay_after_service", ...window,
  });
  /*
   * Read through the thrown Response, never String(error): this engine refuses with a governed
   * Response, and String(new Response(...)) is "[object Response]", so a regex assertion on the
   * stringified throw passes for ANY refusal - including the TypeError this test exists to exclude.
   */
  const refusal = await walking.governWalkingBooking(globalThis.__WALK_ONEOFF_DB__,
    { ...bookingInput(quote, window), weekdays: [1, 3] }).then(() => null, (error) => error);
  assert.ok(refusal instanceof Response, `a mismatched pattern must refuse, got ${refusal}`);
  assert.equal(refusal.status, 409, "and refuse as a conflict, not a server error");
  const body = await refusal.clone().text();
  assert.match(body, /weekdays changed after quote/i, "the refusal must name the rule it enforces");
  assert.doesNotMatch(body, /not iterable|undefined/i, "and must never be a raw JavaScript error");
});
