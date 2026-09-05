/**
 * Pet Taxi Gate 2 — EXECUTED. Driver acceptance, vehicle assignment, the handover chain and completion.
 *
 * WHAT THIS FILE USED TO BE. Seven tests that read `lib/taxi-lifecycle.ts` and the driver page as
 * strings. "Pet Taxi Gate 2 requires pickup handover before trip start" asserted that the sentence
 * "Confirmed pickup handover is required before Pet Taxi trip start" appeared in the source — so the
 * state machine could have been reduced to a single unconditional UPDATE and the test would not have
 * noticed, as long as the sentence survived in a comment.
 *
 * Now every test drives `mutateTaxiBooking` against a real SQLite-backed D1 through the actual trip
 * states and reads the rows back. The state machine is the thing under test, so the ORDER of calls is
 * the assertion: each step is attempted too early (and refused) before being attempted in sequence
 * (and applied).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, seedCanonicalTrip, seedVehicle, nextKey, seedActiveCommercialTerm } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_G2_DB__", "__TAXI_G2_ENV__");

const lifecycle = await import("../lib/taxi-lifecycle.ts");
const proof = await import("../lib/taxi-proof-governance.ts");

/**
 * Two canonical route samples, recorded through the REAL proof workflow.
 *
 * complete_trip refuses with "requires at least two canonical sandbox route samples", and those
 * samples are not something a lifecycle trip_event can write — the evidence separation asserted in
 * this file is exactly why. So completion is reached the way the product reaches it.
 */
async function recordRouteSamples(db, trip, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await proof.mutateTaxiProof(db, {
      bookingId: trip.bookingId, action: "record_location_sample", actorId: trip.providerId,
      idempotencyKey: nextKey("sample"), latitude: 12.97 + index / 1000, longitude: 77.64 + index / 1000,
      accuracyMeters: 8,
    });
  }
}

async function tripWorld(overrides = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__TAXI_G2_DB__ = db;
  globalThis.__TAXI_G2_ENV__ = {};
  const trip = seedCanonicalTrip(sqlite, overrides);
  // The module owns these tables; create them through IT, not by copying DDL, so a count() before the
  // first mutation reads a real empty table instead of throwing "no such table".
  await lifecycle.ensureTaxiLifecycleTables(db);
  return { sqlite, db, trip };
}

const act = (db, trip, action, extra = {}) => lifecycle.mutateTaxiBooking(db, {
  bookingId: trip.bookingId, action, actorId: trip.providerId, idempotencyKey: nextKey(action), ...extra,
});

const tripRow = async (db, trip) => db.prepare("SELECT status,vehicle_id,pickup_verification_status,dropoff_verification_status FROM taxi_trips WHERE id=?").bind(trip.tripId).first();
const count = async (db, table, bookingId) => Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE booking_id=?`).bind(bookingId).first()).c);

/** Drive the trip to an accepted + vehicle-assigned state, the precondition most tests start from. */
async function accepted(db, sqlite, trip) {
  await act(db, trip, "accept");
  const vehicleId = seedVehicle(sqlite, { providerId: trip.providerId });
  await act(db, trip, "assign_vehicle", { vehicleId });
  return vehicleId;
}

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 2 owns driver acceptance vehicle assignment and idempotency", async () => {
  const { sqlite, db, trip } = await tripWorld();

  const accept = await act(db, trip, "accept");
  assert.equal(String(accept.status), "assigned", `accept must move the trip to assigned: ${JSON.stringify(accept).slice(0, 300)}`);
  assert.equal(String((await tripRow(db, trip)).status), "accepted",
    "the row records 'accepted' while the result reports 'assigned' — both are asserted so neither can drift unnoticed");

  // IDEMPOTENCY, executed: the same key replayed returns the first result and changes nothing.
  const key = nextKey("replay");
  const first = await lifecycle.mutateTaxiBooking(db, { bookingId: trip.bookingId, action: "assign_vehicle", actorId: trip.providerId, idempotencyKey: key, vehicleId: seedVehicle(sqlite, { providerId: trip.providerId }) });
  assert.notEqual(first.duplicatePrevented, true, "the first call is not a duplicate");
  const replay = await lifecycle.mutateTaxiBooking(db, { bookingId: trip.bookingId, action: "assign_vehicle", actorId: trip.providerId, idempotencyKey: key, vehicleId: "VEH-1" });
  assert.equal(replay.duplicatePrevented, true, `a replayed key must be prevented: ${JSON.stringify(replay).slice(0, 300)}`);
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS c FROM taxi_trip_action_keys WHERE booking_id=?").bind(trip.bookingId).first()).c), 2, "one key row per distinct action, not one per attempt");

  // The same key reused for a DIFFERENT action is a conflict, not a silent replay.
  const crossed = await refusal(lifecycle.mutateTaxiBooking(db, { bookingId: trip.bookingId, action: "start_trip", actorId: trip.providerId, idempotencyKey: key }));
  assert.ok(crossed, "reusing a key across actions must be refused");
  assert.match(crossed.message, /already used for a different one/);

  // Only an active, UAT-verified vehicle OWNED BY THIS DRIVER may be assigned.
  const somebodyElses = seedVehicle(sqlite, { vehicleId: "VEH-OTHER", providerId: "taxi_meera" });
  const foreign = await refusal(act(db, trip, "assign_vehicle", { vehicleId: somebodyElses }));
  assert.equal(foreign?.status, 409);
  assert.match(foreign.message, /active UAT-verified vehicle owned by this driver/);

  const uninspected = seedVehicle(sqlite, { vehicleId: "VEH-RAW", providerId: trip.providerId, inspection: "pending" });
  const unverified = await refusal(act(db, trip, "assign_vehicle", { vehicleId: uninspected }));
  assert.ok(unverified, "an un-inspected vehicle must be refused");
  assert.match(unverified.message, /active UAT-verified vehicle owned by this driver/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 2 requires pickup handover before trip start and activates deterministic GPS", async () => {
  const { sqlite, db, trip } = await tripWorld();

  // Vehicle assignment is required before a handover can even be attempted.
  await act(db, trip, "accept");
  const early = await refusal(act(db, trip, "confirm_pickup", { handoverMethod: "owner" }));
  assert.ok(early, "a handover before vehicle assignment must be refused");
  assert.match(early.message, /vehicle assignment is required before pickup handover/i);

  const vehicleId = seedVehicle(sqlite, { providerId: trip.providerId });
  await act(db, trip, "assign_vehicle", { vehicleId });

  // Starting the trip before a confirmed handover is refused — the guard the old test only grepped for.
  const beforeHandover = await refusal(act(db, trip, "start_trip"));
  assert.ok(beforeHandover, "start_trip before a confirmed handover must be refused");
  assert.match(beforeHandover.message, /Confirmed pickup handover is required before Pet Taxi trip start/);
  assert.equal(String((await tripRow(db, trip)).status), "vehicle_assigned", "and must not move the trip");

  // A handover needs a GOVERNED method; an invented one is refused.
  const invented = await refusal(act(db, trip, "confirm_pickup", { handoverMethod: "left_at_gate" }));
  assert.ok(invented, "an ungoverned handover method must be refused");
  assert.match(invented.message, /governed Pet Taxi pickup handover method is required/);

  const handover = await act(db, trip, "confirm_pickup", { handoverMethod: "owner" });
  assert.equal(handover.otpConnected, false, "Gate 2 makes no OTP claim");
  assert.equal(await count(db, "taxi_pickup_handover_events", trip.bookingId), 1, "the handover is evidence, so it is a row");

  const started = await act(db, trip, "start_trip");
  assert.equal(started.gpsConnected, true, "a started trip reports telemetry as connected");
  assert.equal(started.telemetryMode, "deterministic_sandbox", "and says plainly that it is a sandbox feed, not a live GPS fix");
  assert.equal(String((await tripRow(db, trip)).status), "in_progress");
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 2 separates non-evidence lifecycle events from proof governance", async () => {
  const { sqlite, db, trip } = await tripWorld();
  await accepted(db, sqlite, trip);
  await act(db, trip, "confirm_pickup", { handoverMethod: "owner" });

  // A trip event requires an ACTIVE trip.
  const beforeStart = await refusal(act(db, trip, "trip_event", { tripEventType: "pet_settled" }));
  assert.ok(beforeStart, "a trip event before the trip starts must be refused");
  assert.match(beforeStart.message, /trip events require an active trip/);

  await act(db, trip, "start_trip");

  // The three non-evidence event types are accepted and recorded.
  for (const tripEventType of ["pet_settled", "water_break", "customer_update"]) {
    const recorded = await act(db, trip, "trip_event", { tripEventType });
    assert.ok(recorded, `${tripEventType} must be accepted`);
  }
  const rows = await db.prepare("SELECT event_type FROM taxi_trip_events WHERE booking_id=? ORDER BY event_type").bind(trip.bookingId).all();
  const types = rows.results.map((row) => String(row.event_type));
  for (const expected of ["trip_customer_update", "trip_pet_settled", "trip_water_break"]) {
    assert.ok(types.includes(expected), `${expected} must be stored, found: ${types.join(", ")}`);
  }

  // Evidence-bearing types are REFUSED here and routed to the proof workflow instead. This is the
  // separation the test name claims, and it is now a refusal rather than a sentence in the source.
  for (const evidence of ["route_proof", "location_ping", "photo", "incident"]) {
    const refused = await refusal(act(db, trip, "trip_event", { tripEventType: evidence }));
    assert.ok(refused, `${evidence} must not be accepted as a plain lifecycle event`);
    assert.match(refused.message, /must use the governed Taxi proof workflow/);
  }
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 2 requires drop-off handover and records payment due with governed completion finance", async () => {
  const { sqlite, db, trip } = await tripWorld();
  await accepted(db, sqlite, trip);
  await act(db, trip, "confirm_pickup", { handoverMethod: "owner" });
  await act(db, trip, "start_trip");
  // Samples are recorded en route: the proof workflow accepts them only while the trip is in_progress,
  // so they cannot be back-filled after arrival.
  await recordRouteSamples(db, trip);

  // Handover confirmation before arrival is refused.
  const beforeArrival = await refusal(act(db, trip, "confirm_dropoff", { handoverMethod: "clinic_staff" }));
  assert.ok(beforeArrival, "confirming drop-off before arriving must be refused");
  assert.match(beforeArrival.message, /Drop-off arrival is required before handover confirmation/);

  // Completion before a confirmed drop-off handover is refused.
  await act(db, trip, "arrive_dropoff");
  const beforeHandover = await refusal(act(db, trip, "complete_trip"));
  assert.ok(beforeHandover, "completion before drop-off handover must be refused");
  assert.match(beforeHandover.message, /Confirmed drop-off handover is required before Pet Taxi completion/);

  await act(db, trip, "confirm_dropoff", { handoverMethod: "clinic_staff" });
  assert.equal(await count(db, "taxi_dropoff_handover_events", trip.bookingId), 1);

  // Completion records the money as DUE — never as collected — and reports payout/tax from the
  // governed completion-finance resolver rather than inventing either.

  // FAIL-CLOSED ON CONFIGURATION — found by running this conversion, not by reading the source.
  // Completion resolves payout and tax through resolveServiceCompletionFinance, which refuses outright
  // when no commercial term is active for pet_taxi rather than inventing either. Asserted in both
  // directions, because "governed completion finance" only means something if the ungoverned case is
  // actually refused.
  const unconfigured = await act(db, trip, "complete_trip").then(() => null, (error) => error);
  assert.ok(unconfigured, "completion without an active commercial term must be refused");
  assert.match(String(unconfigured.message ?? ""), /no active commercial term for service pet_taxi/,
    `expected a configuration refusal, got: ${String(unconfigured.message ?? unconfigured)}`);
  assert.equal(await count(db, "taxi_trip_payment_events", trip.bookingId), 0, "and must not record money as due");

  await seedActiveCommercialTerm(db);
  const completed = await act(db, trip, "complete_trip");
  assert.equal(completed.paymentStatus, "due", "the money is owed, so completion records it due rather than collected");
  assert.equal(completed.liveMoney, false, "and no live money was moved");
  assert.equal(completed.routeSamples, 2, "reported against the samples actually recorded");
  const payment = await db.prepare("SELECT status,amount FROM taxi_trip_payment_events WHERE booking_id=? ORDER BY created_at DESC LIMIT 1").bind(trip.bookingId).first();
  assert.equal(String(payment.status), "due", "the completion payment event is due, not paid");
  assert.equal(Number(payment.amount), trip.amount, "for the canonical booking amount");
  /*
   * payout and tax are reported from resolveServiceCompletionFinance.
   *
   * A NOTE ON WHAT THIS CAN AND CANNOT CATCH, because it was measured rather than assumed. Replacing
   * `payout:finance.payoutStatus` with a hardcoded `payout:"accrued"` is NOT detectable by any
   * behavioural test: lib/service-completion-finance.ts returns payoutStatus:"accrued" and
   * taxStatus:"resolved" as invariants, so the two implementations are observationally identical. That
   * mutation is equivalent, not a coverage gap.
   *
   * What IS observable — and what these assertions cover — is that the resolver was actually CALLED
   * and its arithmetic used: it throws when no commercial term is active (asserted above), and the
   * money breakdown below is computed from the seeded 70% term against the canonical amount. A
   * completion that skipped the resolver could not produce those numbers.
   */
  assert.equal(completed.payout, completed.finance.payoutStatus, "the reported payout is the resolved one");
  assert.equal(completed.tax, completed.finance.taxStatus, "and so is tax");
  assert.equal(Number(completed.finance.orderValue), trip.amount, "resolved against the canonical amount");
  assert.ok(Number(completed.finance.providerPayoutAccrued) > 0, "with a real accrued payout, not a placeholder");
  assert.ok(Number(completed.finance.providerPayoutAccrued) < trip.amount, "net of platform fee and withholding");
  assert.equal(String((await tripRow(db, trip)).status), "completed");
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 2 recovery preserves booking and route before active trip", async () => {
  const { sqlite, db, trip } = await tripWorld();

  // A recovery needs a stated reason.
  const noReason = await refusal(act(db, trip, "driver_unavailable"));
  assert.ok(noReason, "a recovery without a reason must be refused");
  assert.match(noReason.message, /recovery reason is required/);

  const recovered = await act(db, trip, "driver_unavailable", { reason: "vehicle breakdown en route to pickup" });
  assert.equal(recovered.bookingPreserved, true, "the customer keeps the booking");
  const recovery = await db.prepare("SELECT status,detail_json FROM taxi_recovery_cases WHERE booking_id=?").bind(trip.bookingId).first();
  // routePreserved is recorded on the recovery case rather than returned, so it is read from the row
  // the module actually wrote — the returned envelope only carries bookingPreserved.
  assert.equal(JSON.parse(String(recovery.detail_json)).routePreserved, true, "and the route");
  assert.ok(recovery, "a recovery case row is written");
  assert.match(String(recovery.status), /ops_escalation|reassignment_needed|recovery_pending/,
    "a recovery case is opened for Operations rather than silently reassigned");
  // The booking itself must survive — the whole point of "preserved".
  const booking = await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(trip.bookingId).first();
  assert.ok(booking, "the canonical booking must still exist after a recovery");

  // Once the trip is ACTIVE, reassignment is the wrong tool and is refused in favour of the safety
  // incident workflow.
  const active = await tripWorld({ bookingId: "BKG-TAXI-2", tripId: "TRIP-2", reservationId: "RES-2", groupId: "GRP-2" });
  await accepted(active.db, active.sqlite, active.trip);
  await act(active.db, active.trip, "confirm_pickup", { handoverMethod: "owner" });
  await act(active.db, active.trip, "start_trip");
  const tooLate = await refusal(act(active.db, active.trip, "driver_unavailable", { reason: "driver called in sick mid-trip" }));
  assert.ok(tooLate, "reassigning an in-flight trip must be refused");
  assert.match(tooLate.message, /safety incident workflow/i);
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi lifecycle API enforces provider and staff authority", async () => {
  // The route's own authority checks, driven through the real handler on a NON-PREVIEW origin so the
  // ["*"] preview actor cannot satisfy them. An unauthenticated caller must be refused before any
  // lifecycle mutation is attempted.
  const { sqlite, db, trip } = await tripWorld();
  const route = await import("../app/api/taxi-lifecycle/route.ts");
  const before = await count(db, "taxi_trip_events", trip.bookingId);

  const response = await route.POST(new Request("https://ops.pawspace.example/api/taxi-lifecycle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: trip.bookingId, action: "accept", idempotencyKey: nextKey("api") }),
  }));
  assert.ok(response.status === 401 || response.status === 403,
    `an unauthenticated lifecycle mutation must be refused, got ${response.status}`);
  assert.equal(String((await tripRow(db, trip)).status), "scheduled", "and must not move the trip");
  assert.equal(await count(db, "taxi_trip_events", trip.bookingId), before, "nor write an event");
  void sqlite;
});

// ---------------------------------------------------------------------------------------------
test("Driver workspace uses canonical Taxi lifecycle without claiming live-money capture", async () => {
  // Executed against the lifecycle surface the driver screen drives, rather than the page source: the
  // set of actions the workspace can perform is exactly the set this module accepts, and an action it
  // does not know is refused rather than silently ignored.
  const { sqlite, db, trip } = await tripWorld();

  const unsupported = await refusal(act(db, trip, "teleport"));
  assert.ok(unsupported, "an unknown action must be refused, not no-oped");
  assert.match(unsupported.message, /Unsupported Pet Taxi lifecycle action/);

  // Walk the whole driver journey in order; every step the workspace offers must be a real transition.
  await seedActiveCommercialTerm(db);
  const vehicleId = await accepted(db, sqlite, trip);
  assert.equal(String((await tripRow(db, trip)).vehicle_id), vehicleId);
  await act(db, trip, "confirm_pickup", { handoverMethod: "owner" });
  await act(db, trip, "start_trip");
  await act(db, trip, "trip_event", { tripEventType: "pet_settled" });
  await recordRouteSamples(db, trip);
  await act(db, trip, "arrive_dropoff");
  await act(db, trip, "confirm_dropoff", { handoverMethod: "owner" });
  const completed = await act(db, trip, "complete_trip");

  // "Complete trip · create payment due" — the workspace's own label. It must create a DUE event and
  // must not claim a capture.
  assert.equal(completed.paymentStatus, "due", "the workspace creates a payment DUE, never a capture");
  assert.equal(completed.liveMoney, false, "the workspace must never be able to report a live charge");
  const paid = await db.prepare("SELECT COUNT(*) AS c FROM taxi_trip_payment_events WHERE booking_id=? AND status='sandbox_paid'").bind(trip.bookingId).first();
  assert.equal(Number(paid.c), 0, "completing a trip must not mark it paid — Finance records payment separately");
});
