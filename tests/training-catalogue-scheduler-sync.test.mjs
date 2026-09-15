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
 *
 * WHAT THIS FILE MISSED THE FIRST TIME, and what the second half below now covers.
 *
 * Every assertion above this line is about NUMBERS AGREEING - maxOccurrences >= the largest plan,
 * buildOccurrences returning `sessions` occurrences, the 105-day span sitting under the 180-day horizon.
 * All of them passed once the ceiling was raised to 16, and the 16-session plan was STILL unbookable,
 * because nothing here ever reserved one. seedUatRoster in app/api/uat-scheduling published a hardcoded
 * 100-day roster for the recurring services, so the sixteenth weekly session - day 105 - fell five days
 * past the seeded horizon and backend/src/scheduling.ts refused the entire reservation with
 * "No published availability on <date>". Measured on this branch before the fix: occurrences=12 -> 200
 * with 12 reservation rows, occurrences=16 -> 409 with zero. Two numbers that had to agree, and the test
 * only checked one pair of them.
 *
 * So the cases below drive the REAL route against a fresh in-memory D1 and assert the ROWS: a reserve of
 * the largest catalogue plan must leave exactly `sessions` scheduling_reservations, numbered 1..sessions.
 * That is the assertion whose absence let this ship, and it fails for any future plan that outgrows
 * either the occurrence ceiling or the seeded roster horizon.
 *
 * They also lock the two refusals that shared the same scheduling entry point: a malformed scheduledStart
 * reported as a 500, and a governed policy 409 whose reason lib/server-auth.ts authError() erased because
 * the Response was thrown ungoverned. Both are asserted through the real authError, and the WeakSet that
 * decides which bodies survive is read from the same module instance the library throws from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

// lib/ modules import each other without file extensions; this resolver is what lets the real
// catalogue and the real booking-time policy be imported here instead of being retyped as fixtures.
installWorkersHooks("__TRAINING_CATALOGUE_SYNC_DB__", "__TRAINING_CATALOGUE_SYNC_ENV__");
// The runtime declaration seedUatRoster requires. It is a capability, not a default: without it the
// route publishes no synthetic roster at all and a reserve is refused for a different reason entirely.
globalThis.__TRAINING_CATALOGUE_SYNC_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat" };

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

// =================================================================================================
// ROUND 2: the reservation itself, against the real route and a real database.
//
// Everything above proves the scheduler will GENERATE sixteen occurrences. Nothing above proved the
// platform will BOOK them, and it would not: the roster the UAT route seeds stopped at day 100.
// =================================================================================================

const CUSTOMER = "CUST-TRAINING-SYNC";
const PET = "PET-TRAINING-SYNC";
/** A seeded, live Training provider in blr/blr-east. Training is customer_select + strict, so the
 *  request must name one; picking it here is what the /training screen does with the chosen trainer. */
const TRAINER = "train_kiran";

/** A fresh in-memory D1 with the security, capacity and saved-pet fixtures the reserve path requires. */
async function reserveWorld() {
  const { sqlite, db } = freshCountingD1();
  globalThis.__TRAINING_CATALOGUE_SYNC_DB__ = db;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await seedProviderCapacityDefaults(db);
  await seedOwnedPet(db, CUSTOMER, PET, "Bruno");
  return { sqlite, db };
}

/** A real verified customer session, so the reserve runs as the customer and not as staff. */
async function customerCookie(db) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${CUSTOMER}`,
    subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified",
    actorId: "training-catalogue-sync", reason: "Training catalogue/scheduler executable regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: CUSTOMER,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

/** The real POST handler, including its outer catch - so every refusal below goes through authError. */
async function reserve(cookie, body) {
  const route = await import("../app/api/uat-scheduling/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/uat-scheduling", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON body */ }
  return { status: response.status, body: parsed };
}

/**
 * A start far enough ahead to clear Training's 24-hour lead time, and early enough that a full
 * 16-session weekly calendar (105 days) still lands inside the 180-day advance-booking horizon.
 * 10:00-11:00 IST, inside the 09:00-19:00 window the UAT roster publishes for Training.
 */
function futureWindow(offsetDays = 30) {
  const day = new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
  return { scheduledStart: `${day}T04:30:00.000Z`, scheduledEnd: `${day}T05:30:00.000Z` };
}

let requestSeq = 0;
const reserveBody = (overrides = {}) => ({
  clientRequestId: `training-sync-${++requestSeq}`,
  customerId: CUSTOMER,
  petIds: [PET],
  serviceCode: "dog_training",
  cityId: "blr",
  zoneId: "blr-east",
  cadenceDays: 7,
  preferredProviderId: TRAINER,
  ...futureWindow(),
  ...overrides,
});

/** scheduling_reservations is created by the route itself, so a world whose every request was refused
 *  before that point has no table at all. Read through sqlite_master rather than letting the assertion
 *  die with ERR_SQLITE_ERROR - "no rows" and "no table" are both "nothing was reserved". */
const hasReservationsTable = (sqlite) =>
  Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduling_reservations'").get());
const reservationRows = (sqlite, groupId) =>
  hasReservationsTable(sqlite)
    ? sqlite.prepare("SELECT occurrence_number,scheduled_start,provider_id,status FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number").all(groupId)
    : [];
const reservationCount = (sqlite) =>
  hasReservationsTable(sqlite) ? sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n : 0;

// -------------------------------------------------------------------------------------------------
test("the largest Training plan the catalogue sells is actually reservable, one row per session", async () => {
  // THE MISSING ASSERTION. Round 1 proved 16 === 16 and shipped; this proves sixteen reservation rows
  // exist in the database after the customer presses Confirm.
  const { sqlite, db } = await reserveWorld();
  const cookie = await customerCookie(db);
  const body = reserveBody({ occurrences: proPlan.sessions });

  const result = await reserve(cookie, body);

  assert.equal(result.status, 200,
    `the ${proPlan.sessions}-session ${proPlan.code} plan must reserve end to end: ` +
    `${JSON.stringify(result.body).slice(0, 600)}`);
  assert.equal(result.body?.data?.status, "assigned");
  assert.equal(result.body?.data?.provider?.id, TRAINER, "strict customer selection must assign the chosen trainer");

  const rows = reservationRows(sqlite, body.clientRequestId);
  assert.equal(rows.length, proPlan.sessions,
    `governTrainingBooking refuses a programme that is not backed by EXACTLY ${proPlan.sessions} ` +
    `reservations; the reserve wrote ${rows.length}`);
  assert.deepEqual(
    rows.map((row) => Number(row.occurrence_number)),
    Array.from({ length: proPlan.sessions }, (_, index) => index + 1),
    "sessions must be numbered 1..sessions with none dropped",
  );
  assert.equal(new Set(rows.map((row) => row.provider_id)).size, 1, "one trainer for the whole programme");
  for (const row of rows) assert.equal(row.status, "assigned");

  // The occurrence the 100-day roster could not cover: 15 gaps x 7 days past the first session.
  const last = rows.at(-1);
  assert.equal(
    new Date(last.scheduled_start).getTime() - new Date(body.scheduledStart).getTime(),
    (proPlan.sessions - 1) * 7 * DAY,
    "the final session sits a full weekly cadence beyond the first",
  );
});

test("the seeded UAT roster reaches the last session the catalogue can sell, without passing the horizon", async () => {
  // The root cause stated as a property rather than as a number: whatever buildOccurrences will accept,
  // the roster the same request seeds must already cover - and it must still stop inside the governed
  // 180-day advance-booking horizon that assertBookingWindow measures the last occurrence against.
  const { sqlite, db } = await reserveWorld();
  const cookie = await customerCookie(db);
  const body = reserveBody({ occurrences: proPlan.sessions });

  assert.equal((await reserve(cookie, body)).status, 200);

  const span = sqlite.prepare("SELECT MIN(date) lo, MAX(date) hi, COUNT(DISTINCT date) n FROM scheduling_availability WHERE source='uat_roster'").get();
  const lastSession = buildOccurrences(trainingRequest({ ...futureWindow(), occurrences: proPlan.sessions })).at(-1);
  assert.ok(span.hi >= istDate(lastSession.start),
    `the seeded roster stops at ${span.hi}, before the final session on ${istDate(lastSession.start)} - ` +
    "which is exactly how a validated 16-session request became an unsatisfiable one");
  const seededDays = (Date.parse(`${span.hi}T00:00:00.000Z`) - Date.parse(`${span.lo}T00:00:00.000Z`)) / DAY;
  assert.ok(seededDays >= (proPlan.sessions - 1) * 7,
    `${seededDays} days of roster cannot cover a ${(proPlan.sessions - 1) * 7}-day programme`);
  assert.ok(seededDays < APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays,
    `the roster was seeded ${seededDays} days ahead, past the ${APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays}-day ` +
    "advance-booking horizon - seeding availability nobody is allowed to book is not a fix");
  assert.ok(span.n <= APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays, `${span.n} seeded dates exceeds the horizon`);
});

test("a smaller Training plan still reserves exactly its own session count", async () => {
  // Non-vacuity for the two cases above: seeding a wider roster must not turn every request into the
  // largest one, and the shorter plans the catalogue sells must keep working.
  for (const plan of TRAINING_PACKAGE_DEFAULTS) {
    const { sqlite, db } = await reserveWorld();
    const cookie = await customerCookie(db);
    const body = reserveBody({ occurrences: plan.sessions });
    const result = await reserve(cookie, body);
    assert.equal(result.status, 200, `${plan.code} must reserve: ${JSON.stringify(result.body).slice(0, 400)}`);
    assert.equal(reservationRows(sqlite, body.clientRequestId).length, plan.sessions,
      `${plan.code} sells ${plan.sessions} sessions and must reserve exactly that many`);
  }
});

// -------------------------------------------------------------------------------------------------
test("a malformed scheduledStart is refused as bad input, not reported as a server fault", async () => {
  // resolveAssignmentPolicy(..., new Date(input.scheduledStart)) runs BEFORE assertBookingWindow and
  // calls at.toISOString(); an Invalid Date threw a RangeError there, landed in the outer catch and
  // authError answered 500 {"error":"Scheduling failed"} - bad client input reported as a server fault.
  const { sqlite, db } = await reserveWorld();
  const cookie = await customerCookie(db);

  for (const bad of ["not-a-date", "2026-13-45T10:00:00+05:30", "tomorrow", "10:00 on the 4th"]) {
    const result = await reserve(cookie, reserveBody({ occurrences: 1, scheduledStart: bad }));
    assert.equal(result.status, 400,
      `scheduledStart ${JSON.stringify(bad)} answered ${result.status}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body?.error, "A valid scheduling window is required");
    assert.equal(result.body?.code, "invalid_window");
  }

  // The END was already guarded this way. Both halves of one window must answer identically.
  const endResult = await reserve(cookie, reserveBody({ occurrences: 1, scheduledEnd: "not-a-date" }));
  assert.equal(endResult.status, 400);
  assert.equal(endResult.body?.code, "invalid_window");

  // An empty start is a MISSING field, and keeps its own long-standing answer.
  const emptyResult = await reserve(cookie, reserveBody({ occurrences: 1, scheduledStart: "" }));
  assert.equal(emptyResult.status, 400);
  assert.equal(emptyResult.body?.error, "Missing scheduling fields");

  assert.equal(reservationCount(sqlite), 0, "nothing may be reserved on a refused request");
});

test("a non-integer occurrence count is refused with a real reason instead of being accepted", async () => {
  // buildOccurrences compares `occurrences` with < and > and then spreads it, so a non-number passes
  // every comparison. Measured before the fix: occurrences:null returned 200 having silently booked ONE
  // session of a sixteen-session programme, and occurrences:"many" returned 200 with zero occurrences.
  const { sqlite, db } = await reserveWorld();
  const cookie = await customerCookie(db);

  // Non-vacuity first, which also creates the scheduling tables these refusals never reach: a whole
  // number is still accepted and still writes its rows.
  const accepted = reserveBody({ occurrences: 4 });
  assert.equal((await reserve(cookie, accepted)).status, 200);
  assert.equal(reservationRows(sqlite, accepted.clientRequestId).length, 4);

  for (const occurrences of [null, "many", "16", 1.5, true, [16]]) {
    const body = reserveBody({ occurrences });
    const result = await reserve(cookie, body);
    assert.ok(result.status >= 400 && result.status < 500,
      `occurrences ${JSON.stringify(occurrences)} answered ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
    assert.equal(result.body?.error, "Occurrences must be a whole number of sessions",
      `occurrences ${JSON.stringify(occurrences)} must be refused with a reason a caller can act on`);
    assert.equal(result.body?.code, "invalid_occurrences");
    assert.equal(reservationRows(sqlite, body.clientRequestId).length, 0,
      `occurrences ${JSON.stringify(occurrences)} must reserve nothing`);
  }

  // The same shape check covers the other two recurrence inputs, which threw RangeError from addDays.
  const cadence = await reserve(cookie, reserveBody({ occurrences: 2, cadenceDays: "x" }));
  assert.equal(cadence.status, 400, `cadenceDays "x" answered ${cadence.status}: ${JSON.stringify(cadence.body)}`);
  assert.equal(cadence.body?.code, "invalid_cadence");
  const weekdays = await reserve(cookie, reserveBody({ occurrences: 2, weekdays: "monday" }));
  assert.equal(weekdays.status, 400, `weekdays "monday" answered ${weekdays.status}: ${JSON.stringify(weekdays.body)}`);
  assert.equal(weekdays.body?.code, "invalid_weekdays");

  // The RANGE refusal still belongs to the scheduler, not to this shape check.
  const outOfRange = await reserve(cookie, reserveBody({ occurrences: proPlan.sessions + 1 }));
  assert.equal(outOfRange.status, 422, `an out-of-range count stays the scheduler's 422: ${JSON.stringify(outOfRange.body)}`);
  assert.match(String(outOfRange.body?.error), /Occurrences must be between 1 and 16/);
});

test("a governed policy refusal keeps its reason through the route's real authError", async () => {
  // The refusal is raised at lib/service-policy-governance.ts resolveServicePolicy: no assignment policy
  // is in force for a date before the seeded effective_from. It was thrown as a plain Response, so
  // authError - which trusts a 4xx only by WeakSet identity - replaced the body with the route's
  // fallback and the customer was told "Scheduling failed" with no reason and no code.
  const { sqlite, db } = await reserveWorld();
  const cookie = await customerCookie(db);

  for (const day of ["2020-01-01", "2024-01-01", "2025-01-01", "2026-01-01"]) {
    const result = await reserve(cookie, reserveBody({
      occurrences: 1, scheduledStart: `${day}T04:30:00.000Z`, scheduledEnd: `${day}T05:30:00.000Z`,
    }));
    assert.equal(result.status, 409, `${day} answered ${result.status}`);
    assert.notEqual(result.body?.error, "Scheduling failed",
      `${day} came back as the route's fallback - the governed refusal was erased on the way out`);
    assert.match(String(result.body?.error), /is not configured for this service and city/);
    assert.equal(result.body?.code, "service_policy_configuration_required");
    assert.equal(result.body?.domain, "provider_assignment_policy");
    assert.equal(result.body?.serviceCode, "dog_training");
  }
  assert.equal(reservationCount(sqlite), 0);
});

test("the policy refusal is governed by object identity in the same module the library throws from", async () => {
  // The route case above proves the body survives; this proves WHY, at the library boundary, and would
  // fail if someone re-marked the response by copying its headers or its status instead of registering
  // the object. Every module here is loaded through the one loader workspace, so the WeakSet that
  // isGovernedHttpError() consults is the same instance governedJsonError() wrote into.
  const { db } = freshCountingD1();
  const { resolveAssignmentPolicy } = await importLibModule("provider-assignment-policy");
  const { isGovernedHttpError, governedJsonError } = await importLibModule("governed-http-error");
  const { authError } = await importLibModule("server-auth");

  let thrown = null;
  try {
    await resolveAssignmentPolicy(db, "dog_training", "blr", new Date("2020-01-01T00:00:00.000Z"));
  } catch (error) { thrown = error; }

  assert.ok(thrown instanceof Response, "resolveServicePolicy refuses with a Response");
  assert.equal(thrown.status, 409);
  assert.ok(isGovernedHttpError(thrown),
    "the refusal must be registered as a governed 4xx; an unmarked one has its body replaced by authError");

  const answered = authError(thrown, "Scheduling failed");
  assert.equal(answered.status, 409);
  const body = await answered.json();
  assert.notEqual(body.error, "Scheduling failed", "the real reason must survive the real authError");
  assert.match(String(body.error), /is not configured for this service and city/);
  assert.equal(body.code, "service_policy_configuration_required");

  // Non-vacuity: authError must STILL redact a 4xx nobody governed, or the assertion above proves nothing.
  const ungoverned = Response.json({ error: "internal detail nobody approved" }, { status: 409 });
  assert.equal(isGovernedHttpError(ungoverned), false);
  const redacted = await authError(ungoverned, "Scheduling failed").json();
  assert.equal(redacted.error, "Scheduling failed");
  // And a governed 4xx built here is honoured, which is what makes the WeakSet the single mechanism.
  assert.equal(isGovernedHttpError(governedJsonError({ error: "approved" }, 409)), true);
});
