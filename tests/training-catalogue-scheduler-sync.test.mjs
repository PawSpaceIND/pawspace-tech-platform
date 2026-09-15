/**
 * The Training catalogue and the scheduler ceiling must agree. [PTJA-SCHED-MAXOCC]
 *
 * WHAT WAS BROKEN. lib/training-commercial-governance.ts seeds a 16-session "Pro Training Plan" at
 * INR 20,000. app/training/page.tsx reserves `occurrences: quote.sessions` for a programme, and
 * governTrainingBooking refuses a booking that is not backed by EXACTLY `sessions` reservations. But
 * backend/src/scheduling.ts capped dog_training at maxOccurrences:12 and buildOccurrences throws a 422
 * above that, so the reserve step could never produce 16 occurrences: 12 was accepted and 13-16 were
 * refused. The most expensive product in the Training catalogue was structurally unsellable.
 *
 * WHICH SIDE WAS WRONG. The scheduler. `maxOccurrences` is not a capacity limit - capacity is proven
 * per occurrence inside evaluateProvider (roster coverage for every date touched, travel-buffer
 * conflicts, maxDailyJobs, interval leave) and the advance-booking horizon is enforced separately in
 * lib/booking-time-policy.ts. Adding occurrences only gives those checks more to reject, never less.
 * So the ceiling is a catalogue bound, and it was simply left behind when the 16-session plan shipped.
 *
 * These tests call the real buildOccurrences/schedule and read the real exported catalogue array. None
 * of them matches source text, so the ceiling cannot be "fixed" by editing a comment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// lib/ modules import each other without file extensions; this resolver is what lets the real
// catalogue and the real booking-time policy be imported here instead of being retyped as fixtures.
installWorkersHooks("__TRAINING_CATALOGUE_SYNC_DB__", "__TRAINING_CATALOGUE_SYNC_ENV__");

const { buildOccurrences, schedule, scheduleRules } = await import("../backend/src/scheduling.ts");
const { TRAINING_PACKAGE_DEFAULTS } = await import("../lib/training-commercial-governance.ts");
const { APPROVED_BOOKING_TIME_DEFAULT } = await import("../lib/booking-time-policy.ts");

const DAY = 86_400_000;
// 2026-08-10 is a Monday. 10:00-11:00 IST, which sits inside the seeded 09:00-19:00 roster window.
const START = "2026-08-10T04:30:00.000Z";
const END = "2026-08-10T05:30:00.000Z";

const trainingRequest = (overrides = {}) => ({
  cityId: "blr",
  zoneId: "blr-east",
  serviceCode: "dog_training",
  petIds: ["pet_bruno"],
  scheduledStart: START,
  scheduledEnd: END,
  cadenceDays: 7,
  ...overrides,
});

/**
 * The smallest repository `schedule()` actually reads. backend/src/repository.ts cannot be loaded
 * under --experimental-strip-types (MongoRepository uses constructor parameter properties), and this
 * test is about the rule pack, not about storage - so the roster is supplied directly and every
 * scheduling decision below is still made by the real evaluateProvider/schedule code.
 */
function trainerWorld(rosterDates) {
  const roster = new Map();
  for (const date of rosterDates) {
    roster.set(date, [{ id: `pro_nisha-${date}`, providerId: "pro_nisha", cityId: "blr", zoneId: "blr-east", date, windows: ["09:00-19:00"], source: "roster", updatedAt: "2026-08-04T00:00:00.000Z" }]);
  }
  return {
    async listEligibleProviders() {
      return [{ id: "pro_nisha", name: "Nisha", cityId: "blr", zones: ["blr-east"], services: ["dog_training"], live: true, model: "full_time", qualityScore: 92, rating: 4.9, capacity: 1, maxDailyJobs: 6, travelBufferMinutes: 30 }];
    },
    async getPet(id) {
      return { id, customerId: "cus_10428", name: "Bruno", species: "dog", vaccinationStatus: "verified" };
    },
    async listBookings() {
      return [];
    },
    async listAvailability(providerId, date) {
      return providerId === "pro_nisha" ? roster.get(date) ?? [] : [];
    },
  };
}

/** IST calendar date of an instant, which is what the scheduler's roster lookup keys on. */
const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

/** The product the bug made unsellable, read from the catalogue rather than retyped. */
const proPlan = TRAINING_PACKAGE_DEFAULTS.find((plan) => plan.code === "training-16-pro");

// ---------------------------------------------------------------------------------------------
test("the catalogue still sells a 16-session Pro Training Plan", () => {
  assert.ok(proPlan, "training-16-pro must stay in the seeded Training catalogue");
  assert.equal(proPlan.sessions, 16);
  assert.equal(proPlan.price, 20000, "a plan nobody can book is worth guarding at its real price");
});

test("the scheduler ceiling covers every programme the Training catalogue sells", () => {
  const largest = Math.max(...TRAINING_PACKAGE_DEFAULTS.map((plan) => plan.sessions));
  assert.equal(largest, 16, "the largest seeded Training programme is the 16-session Pro plan");
  assert.ok(
    scheduleRules.dog_training.maxOccurrences >= largest,
    `scheduleRules.dog_training.maxOccurrences is ${scheduleRules.dog_training.maxOccurrences}, ` +
      `below the ${largest}-session plan the catalogue sells - that plan cannot be reserved at all`,
  );
});

test("every Training plan in the catalogue generates exactly its session count", () => {
  for (const plan of TRAINING_PACKAGE_DEFAULTS) {
    const occurrences = buildOccurrences(trainingRequest({ occurrences: plan.sessions }));
    assert.equal(
      occurrences.length,
      plan.sessions,
      `${plan.code} sells ${plan.sessions} sessions; the scheduler produced ${occurrences.length}`,
    );
    assert.deepEqual(
      occurrences.map((item) => item.occurrenceNumber),
      Array.from({ length: plan.sessions }, (_, index) => index + 1),
    );
  }
});

test("a 16-occurrence Training request is accepted and assigns one trainer to all sixteen", async () => {
  const planned = buildOccurrences(trainingRequest({ occurrences: 16 }));
  assert.equal(planned.length, 16);
  const repository = trainerWorld(planned.map((occurrence) => istDate(occurrence.start)));

  const decision = await schedule(repository, trainingRequest({ occurrences: 16 }));

  assert.ok(decision.provider, "a rostered trainer must be assignable to the full 16-session programme");
  assert.equal(decision.provider.id, "pro_nisha");
  assert.equal(decision.occurrences.length, 16, "governTrainingBooking demands exactly `sessions` reservations");
  assert.notEqual(decision.mode, "manual_review");
  // Weekly cadence, one trainer, sixteen distinct dates.
  assert.equal(new Set(decision.occurrences.map((item) => item.start)).size, 16);
  for (const [index, occurrence] of decision.occurrences.entries()) {
    assert.equal(
      new Date(occurrence.start).getTime() - new Date(START).getTime(),
      index * 7 * DAY,
      "a 16-session programme runs on the requested weekly cadence",
    );
  }
});

test("the weekday recurrence generator can actually reach sixteen sessions", () => {
  // The weekday branch scans a bounded window; 16 weekly Mondays need ~106 days of it.
  const occurrences = buildOccurrences(trainingRequest({ occurrences: 16, weekdays: [1] }));
  assert.equal(occurrences.length, 16);
  for (const occurrence of occurrences) {
    assert.equal(new Date(new Date(occurrence.start).getTime() + 330 * 60_000).getUTCDay(), 1);
  }
});

test("a 16-session weekly programme stays inside the approved booking horizon", () => {
  const occurrences = buildOccurrences(trainingRequest({ occurrences: 16 }));
  const spanDays = (new Date(occurrences.at(-1).start).getTime() - new Date(START).getTime()) / DAY;
  assert.equal(spanDays, 105);
  assert.ok(
    spanDays < APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays,
    `a 16-session weekly calendar spans ${spanDays} days, which must stay under the ` +
      `${APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays}-day advance-booking horizon that ` +
      "assertBookingWindow measures the LAST occurrence against",
  );
});

test("a genuinely out-of-range Training request is still refused", () => {
  for (const requested of [17, 20, 100]) {
    const error = refusal(() => buildOccurrences(trainingRequest({ occurrences: requested })));
    assert.ok(error, `${requested} occurrences must still be refused - the ceiling was raised, not removed`);
    assert.equal(error.statusCode, 422);
    assert.match(error.message, /Occurrences must be between 1 and 16/);
  }
  for (const requested of [0, -1]) {
    const error = refusal(() => buildOccurrences(trainingRequest({ occurrences: requested })));
    assert.ok(error, `${requested} occurrences must be refused`);
    assert.equal(error.statusCode, 422);
  }
});

test("raising the Training ceiling did not widen any other service", () => {
  // Grooming, Boarding, Pet Sitting, Pet Taxi and Vet Consult are single-reservation services; Dog
  // Walking is 12 because createWalkingQuote itself caps a recurring booking at 2-12 walks.
  for (const service of ["grooming", "boarding", "pet_sitting", "pet_taxi", "vet_consult"]) {
    assert.equal(scheduleRules[service].maxOccurrences, 1, `${service} is one reservation per booking`);
  }
  assert.equal(scheduleRules.dog_walking.maxOccurrences, 12, "the Dog Walking catalogue sells at most 12 recurring walks");

  const error = refusal(() =>
    buildOccurrences({
      cityId: "blr",
      zoneId: "blr-east",
      serviceCode: "dog_walking",
      petIds: ["pet_bruno"],
      scheduledStart: START,
      scheduledEnd: "2026-08-10T05:00:00.000Z",
      occurrences: 16,
      cadenceDays: 7,
    }),
  );
  assert.ok(error, "Dog Walking must not inherit the Training ceiling");
  assert.match(error.message, /between 1 and 12/);
});
