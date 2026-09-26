/*
 * LP-N04 and LP-N05 (Pet Taxi and Pet Sitting halves), executed against the real lifecycle modules
 * and the real route handlers.
 *
 *   LP-N04  A driver could reach "drop-off confirmed" with no route sample at all. Samples are only
 *           accepted while the trip is in_progress, so the evidence completion requires could no
 *           longer be produced: "Complete trip" never appeared and the trip was stuck in_progress
 *           with no in-app way out. Arrival is now gated on the SAME evidence, at the one moment the
 *           driver can still record it.
 *   LP-N05  Governed refusals reached providers as "Unable to update Pet Taxi proof records" /
 *           "Unable to update Sitting lifecycle" (409), because lib code threw a plain Response and
 *           authError redacts ungoverned client errors. The reason must survive the route.
 *
 * Requests go to a NON-preview origin: on localhost the preview branch resolves one superuser holding
 * ["*"], and every authority assertion here would pass vacuously.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  customerSessionCookie, freshSqlite, makeD1, nextKey, refusal, seedActiveCommercialTerm,
  seedCanonicalTrip, seedVehicle, taxiUrl,
} from "./helpers/taxi-harness.mjs";
import { seedSittingBooking, stayUrl } from "./helpers/stay-harness.mjs";
import { atPickupTime } from "./helpers/taxi-pickup-time.mjs";

installWorkersHooks("__LP_REFUSAL_DB__", "__LP_REFUSAL_ENV__");

const taxi = await import("../lib/taxi-lifecycle.ts");
const proof = await import("../lib/taxi-proof-governance.ts");
const proofRoute = await import("../app/api/taxi-proof/route.ts");
const sittingRoute = await import("../app/api/sitting-lifecycle/route.ts");

const DRIVER = "taxi_rahul";
const DRIVER_PRINCIPAL = "+919700000071";
const SITTER = "sitter_ananya";
const SITTER_PRINCIPAL = "+919700000072";

function world(env = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__LP_REFUSAL_DB__ = db;
  globalThis.__LP_REFUSAL_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", ...env };
  return { sqlite, db };
}

const drive = async (db, trip, action, extra = {}) => (action === "confirm_pickup" && await atPickupTime(db, trip.bookingId), taxi.mutateTaxiBooking(db, {
  bookingId: trip.bookingId, action, actorId: `driver:${trip.providerId}`, idempotencyKey: nextKey(action), ...extra,
}));
const sample = (db, trip, index) => proof.mutateTaxiProof(db, {
  bookingId: trip.bookingId, action: "record_location_sample", actorId: `driver:${trip.providerId}`,
  idempotencyKey: nextKey("sample"), latitude: 12.97 + index / 1000, longitude: 77.64 + index / 1000, accuracyMeters: 9,
});

const tripStatus = (sqlite, trip) => String(sqlite.prepare("SELECT status FROM taxi_trips WHERE id=?").get(trip.tripId).status);
const bookingStatus = (sqlite, trip) => String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(trip.bookingId).status);

async function runningTrip({ sqlite, db }) {
  const trip = seedCanonicalTrip(sqlite, { providerId: DRIVER });
  await taxi.ensureTaxiLifecycleTables(db);
  await seedActiveCommercialTerm(db);
  await drive(db, trip, "accept");
  await drive(db, trip, "assign_vehicle", { vehicleId: seedVehicle(sqlite, { providerId: DRIVER }) });
  await drive(db, trip, "confirm_pickup", { handoverMethod: "owner" });
  await drive(db, trip, "start_trip");
  return trip;
}

// ---------------------------------------------------------------------------------------------
test("LP-N04 a Pet Taxi trip cannot be driven past the point where its route evidence can still be recorded", async () => {
  const w = world();
  const trip = await runningTrip(w);
  const required = taxi.TAXI_REQUIRED_ROUTE_SAMPLES;
  assert.equal(required, 2, "the driver workspace tells the driver to record two; the server must want the same two");

  // ZERO samples. Arrival is refused, and the refusal names the action the driver can still take.
  const none = await refusal(drive(w.db, trip, "arrive_dropoff"));
  assert.equal(none?.status, 409);
  assert.match(String(none?.message), /route samples under Route . proof before marking arrival/i);
  assert.doesNotMatch(String(none?.message), /Unable to update Pet Taxi lifecycle/i);
  assert.equal(JSON.parse(String(none?.message)).code, "taxi_route_evidence_required");
  assert.equal(tripStatus(w.sqlite, trip), "in_progress", "and the trip stays where samples are accepted");

  // ONE sample is a point, not a route: still refused, still recoverable.
  await sample(w.db, trip, 1);
  const one = await refusal(drive(w.db, trip, "arrive_dropoff"));
  assert.equal(one?.status, 409);
  assert.equal(JSON.parse(String(one?.message)).routeSamples, 1, "the refusal counts what is already recorded");
  assert.equal(tripStatus(w.sqlite, trip), "in_progress");

  // The SECOND sample is the whole exit from the hole: nothing else is needed.
  await sample(w.db, trip, 2);
  assert.equal((await drive(w.db, trip, "arrive_dropoff")).status, "arrived_dropoff");
  assert.equal((await drive(w.db, trip, "confirm_dropoff")).status, "dropoff_confirmed");
  const completed = await drive(w.db, trip, "complete_trip");
  assert.equal(completed.status, "completed", "and the trip completes, so the gate is not a new dead end");
  assert.equal(completed.routeSamples, 2);
  assert.equal(bookingStatus(w.sqlite, trip), "completed");
});

// ---------------------------------------------------------------------------------------------
test("LP-N05 a Pet Taxi route sample refused after drop-off tells the driver why, through the route", async () => {
  const w = world();
  const trip = await runningTrip(w);
  await sample(w.db, trip, 1);
  await sample(w.db, trip, 2);
  await drive(w.db, trip, "arrive_dropoff");
  await drive(w.db, trip, "confirm_dropoff");

  const driver = await customerSessionCookie(w.db, { principalKey: DRIVER_PRINCIPAL, customerId: DRIVER, subjectType: "provider" });
  const response = await proofRoute.POST(new Request(taxiUrl("/api/taxi-proof"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: driver.cookie },
    body: JSON.stringify({ bookingId: trip.bookingId, action: "record_location_sample", idempotencyKey: nextKey("late"), latitude: 12.98, longitude: 77.65, accuracyMeters: 9 }),
  }));
  const body = await response.json();
  assert.equal(response.status, 409, "the evidence rule itself is unchanged");
  assert.match(String(body.error), /only during an active trip/i, "and the driver is told which rule stopped them");
  assert.match(String(body.error), /dropoff confirmed/i, "including the state the trip is actually in");
  assert.notEqual(String(body.error), "Unable to update Pet Taxi proof records");
  assert.equal(body.code, "taxi_sample_window_closed");
});

// ---------------------------------------------------------------------------------------------
test("LP-N05 a Sitting check-in before the care window tells the sitter why, through the route", async () => {
  const w = world();
  // A stay that starts in five days, which is the shape the launch pass tapped Check in on.
  const startMs = Date.now() + 5 * 86_400_000;
  const seeded = await seedSittingBooking(w.db, w.sqlite, {
    providerId: SITTER,
    window: { scheduledStart: new Date(startMs).toISOString(), scheduledEnd: new Date(startMs + 4 * 3_600_000).toISOString() },
  });
  const sitter = await customerSessionCookie(w.db, { principalKey: SITTER_PRINCIPAL, customerId: SITTER, subjectType: "provider" });
  const post = async (payload) => {
    const response = await sittingRoute.POST(new Request(stayUrl("/api/sitting-lifecycle"), {
      method: "POST", headers: { "content-type": "application/json", cookie: sitter.cookie }, body: JSON.stringify(payload),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  assert.equal((await post({ bookingId: seeded.bookingId, action: "accept", idempotencyKey: nextKey("accept") })).status, 200);
  const early = await post({ bookingId: seeded.bookingId, action: "check_in", idempotencyKey: nextKey("checkin"), latitude: 12.9716, longitude: 77.5946 });
  assert.equal(early.status, 409, "the care-window rule itself is unchanged");
  assert.match(String(early.body.error), /Cannot check in before the Sitting care window starts/i);
  assert.notEqual(String(early.body.error), "Unable to update Sitting lifecycle");
  assert.equal(early.body.code, "sitting_check_in_too_early");
  assert.equal(early.body.scheduledStart, String(w.sqlite.prepare("SELECT scheduled_start FROM canonical_bookings WHERE id=?").get(seeded.bookingId).scheduled_start),
    "and when the window does open");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(seeded.bookingId).status), "assigned",
    "and nothing about the booking moved");
});

// ---------------------------------------------------------------------------------------------
test("LP-N05 an expired sitter offer is refused in the sitter's own words", async () => {
  const w = world();
  const seeded = await seedSittingBooking(w.db, w.sqlite, { providerId: SITTER });
  w.sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").run(Date.now() - 60_000, seeded.groupId);
  const sitter = await customerSessionCookie(w.db, { principalKey: SITTER_PRINCIPAL, customerId: SITTER, subjectType: "provider" });
  const response = await sittingRoute.POST(new Request(stayUrl("/api/sitting-lifecycle"), {
    method: "POST", headers: { "content-type": "application/json", cookie: sitter.cookie },
    body: JSON.stringify({ bookingId: seeded.bookingId, action: "accept", idempotencyKey: nextKey("late-accept") }),
  }));
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(String(body.error), /offer expired/i);
  assert.match(String(body.error), /Operations/i, "and says who is already handling it");
  assert.notEqual(String(body.error), "Unable to update Sitting lifecycle");
  assert.equal(body.code, "sitting_offer_expired");
});

// PARTNER-03: a Pet Taxi trip could be picked up, started and completed days before the booked pickup, raising
// payment due and accruing payout early. The pickup handover now opens 30 minutes before the booked time.
test("LP-N06 a Pet Taxi pickup cannot be confirmed days before the booked pickup time", async () => {
  const { sqlite, db } = world();
  const trip = seedCanonicalTrip(sqlite, { providerId: DRIVER });
  await taxi.ensureTaxiLifecycleTables(db);
  await seedActiveCommercialTerm(db);
  await drive(db, trip, "accept");
  await drive(db, trip, "assign_vehicle", { vehicleId: seedVehicle(sqlite, { providerId: DRIVER }) });
  const pickupAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
  sqlite.prepare("UPDATE canonical_bookings SET scheduled_start=? WHERE id=?").run(pickupAt, trip.bookingId);
  const early = await taxi.mutateTaxiBooking(db, { bookingId: trip.bookingId, action: "confirm_pickup", actorId: `driver:${trip.providerId}`, idempotencyKey: nextKey("early"), handoverMethod: "owner" }).then(() => null, error => error);
  assert.ok(early instanceof Response, "an early pickup must be refused");
  assert.equal(early.status, 409);
  const body = await early.json();
  assert.equal(body.code, "taxi_pickup_too_early");
  assert.equal(body.scheduledStart, pickupAt);
  assert.equal(tripStatus(sqlite, trip), "vehicle_assigned", "nothing moved");
  sqlite.prepare("UPDATE canonical_bookings SET scheduled_start=? WHERE id=?").run(new Date(Date.now() + 20 * 60_000).toISOString(), trip.bookingId);
  await taxi.mutateTaxiBooking(db, { bookingId: trip.bookingId, action: "confirm_pickup", actorId: `driver:${trip.providerId}`, idempotencyKey: nextKey("ontime"), handoverMethod: "owner" });
  assert.equal(tripStatus(sqlite, trip), "pickup_confirmed", "within 30 minutes of pickup the handover opens");
});
