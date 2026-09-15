/*
 * A Training programme could be confirmed with a calendar that runs past the validity it was sold
 * under, and the customer found out at the last session.
 *
 * lib/training-booking-guards.ts has had trainingScheduleWithinValidity since the validity numbers
 * were first corrected, and it is called in exactly ONE place: app/mobile-app/training-flow.tsx. On
 * the server, lib/training-commercial-governance.ts checked the session COUNT against the quote and
 * the START instant against the reservation, and nothing else - so the eight sessions of a 62-day
 * package could be reserved ten days apart, spanning seventy, and /api/canonical-bookings confirmed
 * it and took the money. A direct POST, a stale screen or any non-browser caller reached that state;
 * lib/ai-tool-registry.ts books through the same route.
 *
 * The check now runs where the reservations are, against the reservations - not against a cadence a
 * client says it used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshTrainingWorld, futureTrainingStart, createTrainingQuote, expectResponseRefusal,
} from "./helpers/training-gate-harness.mjs";

const { governTrainingBooking } = await import("../lib/training-commercial-governance.ts");
const { trainingReservedSpanDays, trainingScheduleSpanDays } = await import("../lib/training-booking-guards.ts");

/** `count` session starts, `everyDays` apart, beginning at `startIso`. */
function starts(startIso, count, everyDays) {
  const first = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => new Date(first + index * everyDays * 86_400_000).toISOString());
}

/* training-8-basic: 8 sessions, 62 days of validity. The slowest cadence the app offers is weekly,
 * so 7 x 7 = 49 days, comfortably inside it - the package is sellable as described. */
const PACKAGE = { code: "training-8-basic", name: "Basic Obedience Plan", sessions: 8, validityDays: 62 };

async function confirm(world, quote, sessionStarts) {
  return governTrainingBooking(world.db, {
    quoteId: quote.quoteId, packageCode: PACKAGE.code, packageName: PACKAGE.name, petCount: 1,
    scheduledStart: quote.scheduledStart ?? sessionStarts[0], submittedTotal: quote.totalAmount,
    submittedAmountDueNow: quote.amountDueNow, paymentMode: quote.paymentMode, paymentStatus: "captured",
    reservationCount: sessionStarts.length, reservedStarts: sessionStarts,
  });
}

test("TRAIN-VALID-1: a programme reserved past its validity is refused at booking confirmation", async () => {
  const world = freshTrainingWorld();
  const start = futureTrainingStart();
  const quote = await createTrainingQuote(world.db, { packageCode: PACKAGE.code, petCount: 1, scheduledStart: start, paymentMode: "prepaid" });
  // Eight sessions ten days apart: seventy days on a sixty-two day package.
  const overrun = starts(start, PACKAGE.sessions, 10);
  assert.equal(trainingReservedSpanDays(overrun), 70, "fixture: the schedule really does overrun");

  await expectResponseRefusal(() => confirm(world, quote, overrun), { status: 409 });
  const refusal = await confirm(world, quote, overrun).then(() => null, (error) => error);
  const message = refusal instanceof Response ? await refusal.text() : String(refusal?.message ?? refusal);
  assert.match(message, /70 days/, "the refusal must say how long the schedule is");
  assert.match(message, /62/, "and what the package actually allows, so the customer can be offered a real alternative");

  assert.equal(world.sqlite.prepare("SELECT status FROM training_commercial_quotes WHERE id=?").get(quote.quoteId).status, "open",
    "a refused confirmation must not consume the quote");
});

test("TRAIN-VALID-2: the weekly cadence the app actually offers still confirms", async () => {
  const world = freshTrainingWorld();
  const start = futureTrainingStart();
  const quote = await createTrainingQuote(world.db, { packageCode: PACKAGE.code, petCount: 1, scheduledStart: start, paymentMode: "prepaid" });
  const weekly = starts(start, PACKAGE.sessions, 7);
  assert.equal(trainingReservedSpanDays(weekly), 49, "fixture: seven weeks between the first and the eighth session");

  const governed = await confirm(world, quote, weekly);
  assert.equal(governed.sessions, PACKAGE.sessions, "the guard narrows; it does not block the product");
  assert.equal(governed.validityDays, PACKAGE.validityDays);
});

test("TRAIN-VALID-3: a caller that sends no reserved starts is not silently exempted from the count check", async () => {
  /*
   * reservedStarts is optional so the signature change cannot break a caller that has not adopted it,
   * and that optionality is exactly how a guard quietly stops running. The session-count check must
   * still refuse such a caller, so the weaker path is never the free one.
   */
  const world = freshTrainingWorld();
  const start = futureTrainingStart();
  const quote = await createTrainingQuote(world.db, { packageCode: PACKAGE.code, petCount: 1, scheduledStart: start, paymentMode: "prepaid" });
  await expectResponseRefusal(() => governTrainingBooking(world.db, {
    quoteId: quote.quoteId, packageCode: PACKAGE.code, packageName: PACKAGE.name, petCount: 1,
    scheduledStart: start, submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
    paymentMode: quote.paymentMode, paymentStatus: "captured", reservationCount: 3,
  }), { status: 409 });
});

test("TRAIN-VALID-4: the two span measures agree, so the screen and the server cannot disagree", () => {
  /*
   * trainingScheduleSpanDays predicts the span from the cadence the screen is about to reserve;
   * trainingReservedSpanDays measures it from what was reserved. If they ever return different
   * numbers for the same calendar, a schedule the screen allows becomes one the server refuses - a
   * dead end at the payment step rather than a correction at the picker.
   */
  const MONDAY = Date.UTC(2026, 8, 7); // a Monday, so startWeekday is 1
  for (const [weekdays, sessions] of [[[1], 8], [[1, 4], 8], [[1, 3, 5], 12], [[0, 6], 4], [[1, 2, 3, 4, 5], 16]]) {
    const predicted = trainingScheduleSpanDays({ weekdays, sessions, startWeekday: new Date(MONDAY).getUTCDay() });
    // Walk the same cadence forward to build the calendar the reservation rows would hold.
    const dates = [MONDAY];
    for (let offset = 1; dates.length < sessions; offset += 1) {
      const day = MONDAY + offset * 86_400_000;
      if (weekdays.includes(new Date(day).getUTCDay())) dates.push(day);
    }
    const measured = trainingReservedSpanDays(dates.map((value) => new Date(value).toISOString()));
    assert.equal(measured, predicted, `weekdays ${weekdays} x ${sessions} sessions: screen said ${predicted}, server measured ${measured}`);
  }
});

test("TRAIN-VALID-5: an unreadable schedule fails closed rather than counting as zero days", async () => {
  // Math.max of a NaN would make an unparseable start look like a nought-day span, which passes every
  // validity there is. It has to be the other way round.
  assert.equal(trainingReservedSpanDays(["not-a-date", new Date().toISOString()]), Number.POSITIVE_INFINITY);
  assert.equal(trainingReservedSpanDays([]), Number.POSITIVE_INFINITY);

  const world = freshTrainingWorld();
  const start = futureTrainingStart();
  const quote = await createTrainingQuote(world.db, { packageCode: PACKAGE.code, petCount: 1, scheduledStart: start, paymentMode: "prepaid" });
  const broken = starts(start, PACKAGE.sessions, 7);
  broken[4] = "not-a-date";
  await expectResponseRefusal(() => confirm(world, quote, broken), { status: 409 });
});

test("TRAIN-VALID-6: the booking route hands the guard the reservations it is meant to measure", async () => {
  /*
   * A WIRING pin, and it reads the source on purpose. Everything above drives governTrainingBooking
   * directly, so all of it still passes if app/api/canonical-bookings/route.ts stops passing
   * reservedStarts - the argument is optional (TRAIN-VALID-3 explains why), so the guard would simply
   * not run and no assertion here would notice. Driving the whole route would mean a fixture with a
   * training quote and eight reservations to prove one argument is still bound; this says the same
   * thing directly.
   */
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(new URL("../app/api/canonical-bookings/route.ts", import.meta.url), "utf8");
  assert.match(route, /reservedStarts:reservations\.results\.map\(row=>String\(row\.scheduled_start\)\)/,
    "the training branch must pass the reserved session starts, or the validity guard silently stops running");
  // And that those reservations really are every session, in order, rather than the first one.
  assert.match(route, /FROM scheduling_reservations WHERE group_id=\? AND status!='cancelled' ORDER BY occurrence_number/,
    "the rows passed must be the whole group in occurrence order");
});
