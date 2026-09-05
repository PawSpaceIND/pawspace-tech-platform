/**
 * Pet Taxi Gate 5 — Operations exception queue and driver recovery. EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Eight tests that read `lib/taxi-ops-governance.ts`,
 * `lib/taxi-recovery-governance.ts`, two routes, a client module and two React pages as strings. The
 * first looped over twelve exception flags asserting each NAME appeared somewhere in the module:
 *
 *   for (const flag of ["driver_recovery", "driver_acceptance_due", ...])
 *     assert.match(source, new RegExp(flag));
 *
 * Every one of those names is a string literal the module already contains. Not one assertion built a
 * booking in the state the flag describes. Another pinned three UPDATE statements character for
 * character, which fails on a reformat and passes on a query bound to the wrong parameter.
 *
 * Now eight EXECUTED tests driving `getTaxiOpsSnapshot`, `mutateTaxiOps`, `acceptTaxiReplacement` and
 * the real `POST /api/taxi-ops` and `POST /api/taxi-recovery` against a real SQLite-backed D1.
 *
 * Requests go to https://ops.pawspace.example. The central claims here are that Operations alone may
 * offer a replacement and the REPLACEMENT DRIVER alone may accept it — two distinct identities. On
 * localhost `npm test` resolves one preview superuser holding ["*"] for every request, so both would
 * pass vacuously.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, nextKey, refusal, seedCanonicalTrip, seedVehicle, taxiUrl } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_G5_DB__", "__TAXI_G5_ENV__");

const ops = await import("../lib/taxi-ops-governance.ts");
const recovery = await import("../lib/taxi-recovery-governance.ts");
const opsRoute = await import("../app/api/taxi-ops/route.ts");
const recoveryRoute = await import("../app/api/taxi-recovery/route.ts");

const OPS_STAFF = "ops.staff@pawspace.test";
const SUPPORT = "support.agent@pawspace.test";
const FAILED_DRIVER = "taxi_rahul";
const REPLACEMENT = "taxi_meena";
const REPLACEMENT_PRINCIPAL = "+919700000051";
const OTHER_PRINCIPAL = "+919700000099";

/**
 * A canonical Pet Taxi world with the Operations tables, one staff identity that manages bookings and
 * one that only views them.
 *
 * Every Operations table comes from ensureTaxiOpsTables, which also pulls in the finance, proof and
 * capacity schemas — so this fixture is the production schema rather than a hand-copied one.
 */
async function opsWorld({ tripStatus = "scheduled", bookingStatus = "confirmed" } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__TAXI_G5_DB__ = db;
  globalThis.__TAXI_G5_ENV__ = {};

  const seeded = seedCanonicalTrip(sqlite, { tripStatus, workOrderStatus: "accepted", offerStatus: "accepted", vehicleId: "VEH-RAHUL" });
  sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id=?").run(bookingStatus, seeded.bookingId);
  await ops.ensureTaxiOpsTables(db);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  // `admin` holds bookings.manage; `associate` only holds bookings.view — the contrast that makes the
  // Operations gate a gate rather than "any signed-in staff member".
  staff.run("U-G5-OPS", OPS_STAFF, "Ops Staff", "admin", now, now);
  staff.run("U-G5-SUPPORT", SUPPORT, "Support Agent", "associate", now, now);

  seedVehicle(sqlite, { vehicleId: "VEH-RAHUL", providerId: FAILED_DRIVER });
  // getTaxiOpsSnapshot LEFT JOINs canonical_customers for the display name. The module reads this
  // table but does not own it, so the DDL is copied verbatim from the owning source.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(seeded.customerId, "blr", "Taxi Customer", "+919800000051", now, now);
  return { sqlite, db, ...seeded };
}

/** A provider capacity profile that can serve this trip, plus its UAT-verified vehicle. */
function seedDriver(sqlite, {
  providerId, name = "Meena R.", cityId = "blr", zones = ["blr-east"], services = ["pet_taxi"],
  live = 1, status = "active", travelBufferMinutes = 20, quality = 90, rating = 4.8,
  vehicleActive = 1, vehicleInspection = "uat_verified", withVehicle = true,
} = {}) {
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,'full_time',?,?,?,?,?,1,?,6,3,?,1,'2026-01-01',NULL,'harness',?)")
    .run(providerId, cityId, name, JSON.stringify(services), JSON.stringify(zones), live, rating, quality, travelBufferMinutes, status, now);
  if (withVehicle) seedVehicle(sqlite, { vehicleId: `VEH-${providerId}`, providerId, active: vehicleActive, inspection: vehicleInspection });
  return providerId;
}

/** Put a booking into pre-trip driver recovery with an open recovery case. */
function openRecovery(sqlite, { bookingId, tripId, failedProviderId = FAILED_DRIVER, reasonCode = "driver_no_show" }) {
  const now = Date.now();
  sqlite.prepare("UPDATE canonical_bookings SET status='reassignment_needed' WHERE id=?").run(bookingId);
  sqlite.prepare("UPDATE taxi_trips SET status='recovery_pending' WHERE booking_id=?").run(bookingId);
  sqlite.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=(SELECT schedule_group_id FROM canonical_bookings WHERE id=?)").run(bookingId);
  sqlite.prepare("INSERT INTO taxi_recovery_cases (id,booking_id,trip_id,failed_provider_id,reason_code,status,detail_json,opened_at,updated_at) VALUES (?,?,?,?,?,'ops_escalation','{}',?,?)")
    .run(`REC-${bookingId}`, bookingId, tripId, failedProviderId, reasonCode, now, now);
  return `REC-${bookingId}`;
}

const act = (db, bookingId, action, extra = {}) =>
  ops.mutateTaxiOps(db, { bookingId, action, actorId: extra.actorId ?? OPS_STAFF, idempotencyKey: extra.key ?? nextKey(action), ...extra });

const opsPost = async (actorEmail, body) => {
  const headers = { "content-type": "application/json", ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
  const response = await opsRoute.POST(new Request(taxiUrl("/api/taxi-ops"), { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

const bookingOf = async (db, bookingId) => {
  const snapshot = await ops.getTaxiOpsSnapshot(db);
  return snapshot.bookings.find((item) => String(item.id) === bookingId);
};

// ---------------------------------------------------------------------------------------------
test("Gate 5: the Operations queue derives its exception flags from real booking state", async () => {
  const world = await opsWorld();
  const { sqlite, db, bookingId, tripId } = world;

  // A CLEAR booking carries no flags — the control that makes every flag below meaningful.
  const clear = await bookingOf(db, bookingId);
  assert.deepEqual(clear.exceptionFlags, []);
  assert.equal(clear.priority, "clear");

  // A grooming booking is NOT in the Pet Taxi queue at all.
  const grooming = seedCanonicalTrip(sqlite, { bookingId: "BKG-GROOM-G5", tripId: "TRIP-GROOM-G5", reservationId: "RES-GROOM-G5", groupId: "GRP-GROOM-G5", customerId: "CUST-GROOM-G5" });
  sqlite.prepare("UPDATE canonical_bookings SET service_code='grooming' WHERE id=?").run(grooming.bookingId);
  assert.equal(await bookingOf(db, grooming.bookingId), undefined, "the queue is scoped to pet_taxi");

  // DRIVER RECOVERY, from the booking status and the open case.
  openRecovery(sqlite, { bookingId, tripId });
  const inRecovery = await bookingOf(db, bookingId);
  assert.ok(inRecovery.exceptionFlags.includes("driver_recovery"));
  assert.equal(inRecovery.priority, "high");

  // DRIVER ACCEPTANCE DUE, from an offer that has expired while still pending.
  sqlite.prepare("UPDATE provider_assignment_offers SET status='pending',expires_at=? WHERE group_id=?").run(Date.now() - 60_000, world.groupId);
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("driver_acceptance_due"));
  sqlite.prepare("UPDATE provider_assignment_offers SET status='pending',expires_at=? WHERE group_id=?").run(Date.now() + 600_000, world.groupId);
  assert.equal((await bookingOf(db, bookingId)).exceptionFlags.includes("driver_acceptance_due"), false, "an offer still in time is not overdue");

  // INCIDENT SEVERITY escalates in order, and only OPEN incidents count.
  const incident = sqlite.prepare("INSERT INTO taxi_incidents (id,booking_id,trip_id,provider_id,severity,summary,action_taken,status,ops_status,notification_status,reported_by,reported_at,updated_at) VALUES (?,?,?,?,?,?,'',?,'queued','queued','driver',?,?)");
  incident.run("INC-1", bookingId, tripId, FAILED_DRIVER, "attention", "pet whined", "open", Date.now(), Date.now());
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("care_incident"));
  incident.run("INC-2", bookingId, tripId, FAILED_DRIVER, "urgent", "pet is panting heavily", "open", Date.now(), Date.now());
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("urgent_incident"));
  incident.run("INC-3", bookingId, tripId, FAILED_DRIVER, "emergency", "the pet needs a vet now", "open", Date.now(), Date.now());
  const emergency = await bookingOf(db, bookingId);
  assert.ok(emergency.exceptionFlags.includes("emergency_incident"));
  assert.equal(emergency.exceptionFlags.includes("urgent_incident"), false, "the highest open severity wins, so the queue shows one incident state");
  assert.equal(emergency.priority, "emergency");
  sqlite.prepare("UPDATE taxi_incidents SET status='resolved' WHERE booking_id=?").run(bookingId);
  const resolved = await bookingOf(db, bookingId);
  assert.equal(resolved.exceptionFlags.some((flag) => flag.endsWith("_incident")), false, "a resolved incident is not an exception");

  // FINANCE flags: a cancellation awaiting policy review, a pending refund, a due trip payment and a
  // completed trip with no ready settlement.
  sqlite.prepare("INSERT INTO taxi_cancellation_requests (id,booking_id,requested_by,reason,status,created_at,updated_at) VALUES (?,?,?,?,'policy_review_required',?,?)")
    .run("CANC-1", bookingId, "customer:CUST-TAXI-1", "plans changed", Date.now(), Date.now());
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("cancellation_policy_review"));
  sqlite.prepare("INSERT INTO taxi_refund_ledger (id,booking_id,amount,currency,status,policy_source,created_by,created_at,updated_at) VALUES (?,?,?,'INR','sandbox_pending','explicit_finance_approval',?,?,?)")
    .run("RFND-1", bookingId, 149, OPS_STAFF, Date.now(), Date.now());
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("refund_pending"));
  sqlite.prepare("INSERT INTO taxi_trip_payment_events (id,booking_id,trip_id,amount,currency,status,gateway,created_at,updated_at) VALUES (?,?,?,?,'INR','due','uat_sandbox',?,?)")
    .run("TPAY-1", bookingId, tripId, 449, Date.now(), Date.now());
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("trip_payment_due"));

  // MEDIA BLOCKED, from an asset that is not clean, ready and active.
  sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,'taxi_update','taxi/pending/x','image/jpeg',100,?,'pending','quarantined','active',0,'driver',?,?)")
    .run("TMEDIA-1", bookingId, FAILED_DRIVER, "a".repeat(64), Date.now(), Date.now());
  sqlite.prepare("INSERT INTO taxi_media_trip_bindings (media_id,booking_id,trip_id,provider_id,created_at) VALUES (?,?,?,?,?)").run("TMEDIA-1", bookingId, tripId, FAILED_DRIVER, Date.now());
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("media_blocked"));
  sqlite.prepare("UPDATE service_media_assets SET scan_status='clean',access_status='ready' WHERE id=?").run("TMEDIA-1");
  assert.equal((await bookingOf(db, bookingId)).exceptionFlags.includes("media_blocked"), false, "clean, ready, active media is not blocked");

  // ROUTE MISSING: an in-progress trip with fewer than two canonical route samples.
  sqlite.prepare("UPDATE taxi_trips SET status='in_progress' WHERE booking_id=?").run(bookingId);
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("route_missing"));
  const sample = sqlite.prepare("INSERT INTO taxi_trip_events (id,booking_id,trip_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample','driver','{}',?)");
  sample.run("EV-1", bookingId, tripId, FAILED_DRIVER, Date.now());
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("route_missing"), "one sample is not a route");
  sample.run("EV-2", bookingId, tripId, FAILED_DRIVER, Date.now());
  assert.equal((await bookingOf(db, bookingId)).exceptionFlags.includes("route_missing"), false, "two samples clear it");

  // TRIP OVERDUE: past its scheduled end and neither completed nor cancelled.
  sqlite.prepare("UPDATE canonical_bookings SET scheduled_end=? WHERE id=?").run(new Date(Date.now() - 3_600_000).toISOString(), bookingId);
  assert.ok((await bookingOf(db, bookingId)).exceptionFlags.includes("trip_overdue"));

  // SETTLEMENT NOT READY: a completed booking whose settlement is missing or not ready.
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(bookingId);
  sqlite.prepare("UPDATE taxi_trips SET status='completed' WHERE booking_id=?").run(bookingId);
  const completed = await bookingOf(db, bookingId);
  assert.ok(completed.exceptionFlags.includes("settlement_not_ready"));
  assert.equal(completed.exceptionFlags.includes("trip_overdue"), false, "a completed trip is not overdue");

  // THE METRICS are computed from those same flags, not reported independently.
  const snapshot = await ops.getTaxiOpsSnapshot(db);
  assert.equal(snapshot.metrics.total, snapshot.bookings.length);
  assert.equal(snapshot.metrics.needsAttention + snapshot.metrics.clear, snapshot.metrics.total);
  assert.equal(snapshot.metrics.needsAttention, snapshot.bookings.filter((item) => item.exceptionFlags.length > 0).length);
  assert.equal(snapshot.metrics.financeReview, snapshot.bookings.filter((item) => item.exceptionFlags.some((flag) => ["cancellation_policy_review", "refund_pending", "trip_payment_due", "settlement_not_ready"].includes(flag))).length);
  assert.equal(snapshot.source, "canonical Pet Taxi UAT database");
});

// ---------------------------------------------------------------------------------------------
test("Gate 5: a replacement candidate needs exact-window capacity and an active UAT-verified vehicle", async () => {
  const world = await opsWorld();
  const { sqlite, db, bookingId, tripId } = world;
  openRecovery(sqlite, { bookingId, tripId });

  // NON-VACUITY: a fully eligible driver IS offered.
  seedDriver(sqlite, { providerId: REPLACEMENT });
  const eligible = (await bookingOf(db, bookingId)).replacementCandidates;
  assert.deepEqual(eligible.map((item) => item.providerId), [REPLACEMENT]);
  assert.equal(eligible[0].vehicleId, `VEH-${REPLACEMENT}`);

  // Each disqualifier on its own removes them. Every case restores eligibility afterwards, so a
  // refusal is attributable to exactly the field under test.
  const candidateIds = async () => (await bookingOf(db, bookingId)).replacementCandidates.map((item) => item.providerId);
  const cases = [
    ["no UAT-verified vehicle", () => seedDriver(sqlite, { providerId: REPLACEMENT, withVehicle: false })],
    ["an unverified vehicle", () => seedDriver(sqlite, { providerId: REPLACEMENT, vehicleInspection: "pending" })],
    ["an inactive vehicle", () => seedDriver(sqlite, { providerId: REPLACEMENT, vehicleActive: 0 })],
    ["another city", () => seedDriver(sqlite, { providerId: REPLACEMENT, cityId: "hyd" })],
    ["another zone", () => seedDriver(sqlite, { providerId: REPLACEMENT, zones: ["blr-north"] })],
    ["not offering pet taxi", () => seedDriver(sqlite, { providerId: REPLACEMENT, services: ["grooming"] })],
    ["not live", () => seedDriver(sqlite, { providerId: REPLACEMENT, live: 0 })],
    ["a suspended profile", () => seedDriver(sqlite, { providerId: REPLACEMENT, status: "suspended" })],
  ];
  for (const [label, apply] of cases) {
    sqlite.prepare("DELETE FROM taxi_vehicle_profiles WHERE provider_id=?").run(REPLACEMENT);
    apply();
    assert.deepEqual(await candidateIds(), [], `a driver with ${label} must not be offered the trip`);
  }
  sqlite.prepare("DELETE FROM taxi_vehicle_profiles WHERE provider_id=?").run(REPLACEMENT);
  seedDriver(sqlite, { providerId: REPLACEMENT });
  assert.deepEqual(await candidateIds(), [REPLACEMENT], "and the eligible driver is back");

  // AN OVERLAPPING UNAVAILABILITY removes them; one that ends before the window does not.
  const unavailability = sqlite.prepare("INSERT OR REPLACE INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'harness',?,?)");
  unavailability.run("UNAV-1", REPLACEMENT, world.scheduledStart, world.scheduledEnd, "leave", "active", Date.now(), Date.now());
  assert.deepEqual(await candidateIds(), [], "a driver on leave across the window is not eligible");
  unavailability.run("UNAV-1", REPLACEMENT, new Date(new Date(world.scheduledStart).getTime() - 86_400_000).toISOString(), new Date(new Date(world.scheduledStart).getTime() - 3_600_000).toISOString(), "leave", "active", Date.now(), Date.now());
  assert.deepEqual(await candidateIds(), [REPLACEMENT], "leave that ends before the window does not disqualify them");
  unavailability.run("UNAV-1", REPLACEMENT, world.scheduledStart, world.scheduledEnd, "leave", "cancelled", Date.now(), Date.now());
  assert.deepEqual(await candidateIds(), [REPLACEMENT], "and neither does cancelled leave");
  sqlite.prepare("DELETE FROM provider_unavailability").run();

  // A CONFLICTING RESERVATION inside the TRAVEL-BUFFERED window removes them. The buffer is what makes
  // this "exact-window capacity" rather than "no overlap": a job ending fifteen minutes before pickup
  // still conflicts for a driver with a twenty-minute buffer.
  const conflict = sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,'pet_taxi','blr','blr-east','CUST-OTHER','[]',?,?,?,?)");
  const pickup = new Date(world.scheduledStart).getTime();
  conflict.run("RES-CONFLICT", "GRP-OTHER", REPLACEMENT, new Date(pickup - 45 * 60_000).toISOString(), new Date(pickup - 15 * 60_000).toISOString(), "assigned", Date.now());
  assert.deepEqual(await candidateIds(), [], "a job ending inside the travel buffer is a conflict");
  // A job ending well before the buffer does not conflict.
  conflict.run("RES-CONFLICT", "GRP-OTHER", REPLACEMENT, new Date(pickup - 180 * 60_000).toISOString(), new Date(pickup - 150 * 60_000).toISOString(), "assigned", Date.now());
  assert.deepEqual(await candidateIds(), [REPLACEMENT]);
  // A CANCELLED reservation is not a conflict.
  conflict.run("RES-CONFLICT", "GRP-OTHER", REPLACEMENT, new Date(pickup - 45 * 60_000).toISOString(), new Date(pickup - 15 * 60_000).toISOString(), "cancelled", Date.now());
  assert.deepEqual(await candidateIds(), [REPLACEMENT]);
  sqlite.prepare("DELETE FROM scheduling_reservations WHERE id='RES-CONFLICT'").run();

  // The FAILED driver is never offered their own trip back.
  seedDriver(sqlite, { providerId: FAILED_DRIVER, name: "Rahul K." });
  assert.deepEqual(await candidateIds(), [REPLACEMENT], "the driver who failed the trip is excluded");

  // Candidates are only offered while the trip has NOT started — a moving trip is a safety matter.
  sqlite.prepare("UPDATE taxi_trips SET status='in_progress' WHERE booking_id=?").run(bookingId);
  assert.deepEqual((await bookingOf(db, bookingId)).replacementCandidates, [], "an in-progress trip offers no replacements");
});

// ---------------------------------------------------------------------------------------------
test("Gate 5: offering a replacement preserves the booking, the trip and the route", async () => {
  const world = await opsWorld();
  const { sqlite, db, bookingId, tripId, groupId, reservationId } = world;
  const recoveryId = openRecovery(sqlite, { bookingId, tripId });
  seedDriver(sqlite, { providerId: REPLACEMENT });
  const tripBefore = sqlite.prepare("SELECT origin_label,destination_label,route_code,synthetic_distance_km,scheduled_start,scheduled_end,reservation_id FROM taxi_trips WHERE booking_id=?").get(bookingId);

  // A replacement can only be offered on a PRE-TRIP, recovery-pending booking. A trip already moving
  // is a safety matter for the incident path, and a booking with no recovery case has nothing to
  // recover from.
  const healthy = await opsWorld();
  seedDriver(healthy.sqlite, { providerId: REPLACEMENT });
  assert.equal((await refusal(act(healthy.db, healthy.bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "no recovery case exists here" })))?.status, 409);
  const moving = await opsWorld({ tripStatus: "in_progress", bookingStatus: "in_progress" });
  openRecovery(moving.sqlite, { bookingId: moving.bookingId, tripId: moving.tripId });
  moving.sqlite.prepare("UPDATE taxi_trips SET status='in_progress' WHERE booking_id=?").run(moving.bookingId);
  seedDriver(moving.sqlite, { providerId: REPLACEMENT });
  assert.equal((await refusal(act(moving.db, moving.bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "swapping the driver mid-trip" })))?.status, 409,
    "a moving trip cannot have its driver swapped through the Operations queue");
  assert.equal(String(moving.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").get(moving.bookingId).provider_id), FAILED_DRIVER,
    "and the booking keeps its driver");
  // A booking in recovery whose case has already been resolved cannot be re-offered either.
  const stale = await opsWorld();
  openRecovery(stale.sqlite, { bookingId: stale.bookingId, tripId: stale.tripId });
  stale.sqlite.prepare("UPDATE taxi_recovery_cases SET status='resolved' WHERE booking_id=?").run(stale.bookingId);
  seedDriver(stale.sqlite, { providerId: REPLACEMENT });
  assert.equal((await refusal(act(stale.db, stale.bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "re-offering a resolved recovery" })))?.status, 409);

  // Back to the world under test. An ineligible driver cannot be assigned, and a reason is mandatory.
  globalThis.__TAXI_G5_DB__ = db;
  assert.equal((await refusal(act(db, bookingId, "assign_replacement", { providerId: "taxi_nobody", reason: "trying an ineligible driver" })))?.status, 409);
  assert.equal((await refusal(act(db, bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "hi" })))?.status, 400);
  assert.equal((await refusal(act(db, bookingId, "assign_replacement", { reason: "no driver named at all" })))?.status, 400);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "reassignment_needed");

  const offered = await act(db, bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "original driver did not arrive" });
  assert.equal(offered.status, "replacement_offered");
  assert.equal(offered.replacementProviderId, REPLACEMENT);
  assert.equal(offered.bookingPreserved, true);
  assert.equal(offered.routePreserved, true);
  assert.equal(offered.recoveryId, recoveryId, "the same recovery case, not a new one");

  // THE SAME BOOKING and THE SAME TRIP, re-pointed at the new driver. The old test pinned three UPDATE
  // statements as text; these are the rows they were supposed to produce.
  assert.deepEqual({
    booking: String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status),
    provider: String(sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").get(bookingId).provider_id),
  }, { booking: "reassignment_offered", provider: REPLACEMENT });
  const trip = sqlite.prepare("SELECT * FROM taxi_trips WHERE booking_id=?").get(bookingId);
  assert.equal(String(trip.id), tripId, "the trip id is unchanged");
  assert.equal(String(trip.provider_id), REPLACEMENT);
  assert.equal(String(trip.status), "scheduled");
  assert.equal(trip.vehicle_id, null, "the new driver brings their own vehicle, so the old one is cleared");
  assert.deepEqual({ pickup: String(trip.pickup_verification_status), dropoff: String(trip.dropoff_verification_status) }, { pickup: "pending", dropoff: "pending" });
  // THE ROUTE IS THE SAME ROUTE: origin, destination, route class, distance and window all unchanged.
  assert.deepEqual({
    origin: String(trip.origin_label), destination: String(trip.destination_label), route: String(trip.route_code),
    distance: Number(trip.synthetic_distance_km), start: String(trip.scheduled_start), end: String(trip.scheduled_end),
    reservation: String(trip.reservation_id),
  }, {
    origin: String(tripBefore.origin_label), destination: String(tripBefore.destination_label), route: String(tripBefore.route_code),
    distance: Number(tripBefore.synthetic_distance_km), start: String(tripBefore.scheduled_start), end: String(tripBefore.scheduled_end),
    reservation: String(tripBefore.reservation_id),
  });

  // The work order, the scheduling hold and the assignment decision all follow the same driver.
  assert.deepEqual({
    workOrder: String(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(bookingId).status),
    workOrderProvider: String(sqlite.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=?").get(bookingId).provider_id),
  }, { workOrder: "reassignment_offered", workOrderProvider: REPLACEMENT });
  const reservation = sqlite.prepare("SELECT provider_id,status FROM scheduling_reservations WHERE id=?").get(reservationId);
  assert.deepEqual({ provider: String(reservation.provider_id), status: String(reservation.status) }, { provider: REPLACEMENT, status: "assigned" },
    "the cancelled hold is re-assigned rather than a new one being taken");
  const decision = sqlite.prepare("SELECT selected_provider_id,status,reason FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId);
  assert.deepEqual({ provider: String(decision.selected_provider_id), status: String(decision.status) }, { provider: REPLACEMENT, status: "reassignment_offered" });
  assert.equal(String(decision.reason), "original driver did not arrive", "and the Operations reason is on the record");

  // A pending offer exists for the new driver, and the recovery case records the preservation.
  const offer = sqlite.prepare("SELECT provider_id,status FROM provider_assignment_offers WHERE group_id=?").get(groupId);
  assert.deepEqual({ provider: String(offer.provider_id), status: String(offer.status) }, { provider: REPLACEMENT, status: "pending" });
  const caseRow = sqlite.prepare("SELECT status,replacement_provider_id,detail_json FROM taxi_recovery_cases WHERE id=?").get(recoveryId);
  assert.deepEqual({ status: String(caseRow.status), provider: String(caseRow.replacement_provider_id) }, { status: "replacement_offered", provider: REPLACEMENT });
  const detail = JSON.parse(String(caseRow.detail_json));
  assert.deepEqual({ booking: detail.bookingPreserved, route: detail.routePreserved, reason: detail.replacementReason },
    { booking: true, route: true, reason: "original driver did not arrive" });

  // The trip event and the queued customer message both say the route is unchanged.
  const event = sqlite.prepare("SELECT detail_json FROM taxi_trip_events WHERE booking_id=? AND event_type='replacement_driver_offered'").get(bookingId);
  const eventDetail = JSON.parse(String(event.detail_json));
  assert.deepEqual({ booking: eventDetail.bookingPreserved, route: eventDetail.routePreserved, replacement: eventDetail.replacementProviderId, failed: eventDetail.failedProviderId },
    { booking: true, route: true, replacement: REPLACEMENT, failed: FAILED_DRIVER });
  const notifications = sqlite.prepare("SELECT channel,status,message FROM taxi_customer_notifications WHERE booking_id=?").all(bookingId);
  assert.deepEqual([...new Set(notifications.map((row) => String(row.status)))], ["queued"], "customer messages are queued, never delivered");
  assert.match(String(notifications[0].message), /unchanged/);

  // A second offer on the same booking is refused: it is no longer recovery-pending.
  assert.equal((await refusal(act(db, bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "offering the same trip twice" })))?.status, 409);
});

// ---------------------------------------------------------------------------------------------
test("Gate 5: acceptance verifies the booking, work order, trip, reservation, offer and vehicle", async () => {
  const world = await opsWorld();
  const { sqlite, db, bookingId, tripId, groupId, reservationId } = world;
  const recoveryId = openRecovery(sqlite, { bookingId, tripId });
  seedDriver(sqlite, { providerId: REPLACEMENT });
  await act(db, bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "original driver did not arrive" });

  const accept = (providerId, extra = {}) => recovery.acceptTaxiReplacement(db, { bookingId, providerId, actorId: `provider:${providerId}`, idempotencyKey: extra.key ?? nextKey("accept") });

  // A DIFFERENT driver cannot accept an offer made to someone else.
  assert.equal((await refusal(accept("taxi_someone_else")))?.status, 409);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "reassignment_offered");

  // A trip whose provider disagrees with the booking is refused rather than reconciled silently.
  sqlite.prepare("UPDATE taxi_trips SET provider_id='taxi_mismatch' WHERE booking_id=?").run(bookingId);
  assert.equal((await refusal(accept(REPLACEMENT)))?.status, 409);
  sqlite.prepare("UPDATE taxi_trips SET provider_id=? WHERE booking_id=?").run(REPLACEMENT, bookingId);
  // And so is a work order that disagrees.
  sqlite.prepare("UPDATE provider_work_orders SET provider_id='taxi_mismatch' WHERE booking_id=?").run(bookingId);
  assert.equal((await refusal(accept(REPLACEMENT)))?.status, 409);
  sqlite.prepare("UPDATE provider_work_orders SET provider_id=? WHERE booking_id=?").run(REPLACEMENT, bookingId);

  // An EXPIRED offer cannot be accepted: recovery has to go back to Operations.
  sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").run(Date.now() - 1000, groupId);
  const expired = await refusal(accept(REPLACEMENT));
  assert.equal(expired?.status, 409);
  assert.match(String(expired?.message), /expired/);
  sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").run(Date.now() + 600_000, groupId);

  // A scheduling reservation that does not match is refused — the canonical hold is authority.
  sqlite.prepare("UPDATE scheduling_reservations SET provider_id='taxi_mismatch' WHERE id=?").run(reservationId);
  assert.equal((await refusal(accept(REPLACEMENT)))?.status, 409);
  sqlite.prepare("UPDATE scheduling_reservations SET provider_id=? WHERE id=?").run(REPLACEMENT, reservationId);

  // Losing the UAT-verified vehicle between the offer and the acceptance refuses the acceptance.
  sqlite.prepare("UPDATE taxi_vehicle_profiles SET inspection_status='expired' WHERE provider_id=?").run(REPLACEMENT);
  const noVehicle = await refusal(accept(REPLACEMENT));
  assert.equal(noVehicle?.status, 409);
  assert.match(String(noVehicle?.message), /UAT-verified vehicle/);
  sqlite.prepare("UPDATE taxi_vehicle_profiles SET inspection_status='uat_verified' WHERE provider_id=?").run(REPLACEMENT);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "reassignment_offered",
    "not one refusal advanced the booking");

  // THE REAL ACCEPTANCE moves booking, work order, trip, offer, decision and recovery case together.
  const acceptKey = nextKey("accept");
  const accepted = await accept(REPLACEMENT, { key: acceptKey });
  assert.deepEqual({ status: accepted.status, provider: accepted.providerId, trip: accepted.tripId, booking: accepted.bookingPreserved, route: accepted.routePreserved },
    { status: "assigned", provider: REPLACEMENT, trip: tripId, booking: true, route: true });
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "assigned");
  assert.equal(String(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(bookingId).status), "accepted");
  assert.equal(String(sqlite.prepare("SELECT status FROM taxi_trips WHERE booking_id=?").get(bookingId).status), "accepted");
  assert.equal(String(sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id=?").get(groupId).status), "accepted");
  assert.equal(String(sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId).status), "assigned");
  const caseRow = sqlite.prepare("SELECT status,detail_json FROM taxi_recovery_cases WHERE id=?").get(recoveryId);
  assert.equal(String(caseRow.status), "replacement_accepted");
  assert.equal(JSON.parse(String(caseRow.detail_json)).routePreserved, true);
  assert.equal(String(sqlite.prepare("SELECT id FROM taxi_trips WHERE booking_id=?").get(bookingId).id), tripId, "still the same trip");

  // THE SAME KEY returns the recorded result rather than acting again — a retried driver tap is safe.
  const replay = await accept(REPLACEMENT, { key: acceptKey });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.tripId, tripId);
  // A NEW key on an already-accepted booking is refused outright: there is no offer left to accept.
  const late = await refusal(accept(REPLACEMENT));
  assert.equal(late?.status, 409);
  assert.match(String(late?.message), /not awaiting replacement driver acceptance/);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_trip_action_keys WHERE booking_id=?").get(bookingId).c), 1,
    "one acceptance, one recorded action key");
});

// ---------------------------------------------------------------------------------------------
test("Gate 5: Operations cannot close a recovery before the replacement driver accepts", async () => {
  const world = await opsWorld();
  const { sqlite, db, bookingId, tripId } = world;
  const recoveryId = openRecovery(sqlite, { bookingId, tripId });
  seedDriver(sqlite, { providerId: REPLACEMENT });

  // Before any offer at all.
  const early = await refusal(act(db, bookingId, "close_recovery", { reason: "closing before anything happened" }));
  assert.equal(early?.status, 409);
  assert.match(String(early?.message), /Replacement driver must accept before Operations can close recovery/);

  // After the OFFER but before the ACCEPTANCE — this is the case that matters, because the queue looks
  // resolved from the Operations side.
  await act(db, bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "original driver did not arrive" });
  const offered = await refusal(act(db, bookingId, "close_recovery", { reason: "the driver will surely accept" }));
  assert.equal(offered?.status, 409);
  assert.equal(String(sqlite.prepare("SELECT status FROM taxi_recovery_cases WHERE id=?").get(recoveryId).status), "replacement_offered",
    "and the case stays open");

  await recovery.acceptTaxiReplacement(db, { bookingId, providerId: REPLACEMENT, actorId: `provider:${REPLACEMENT}`, idempotencyKey: nextKey("accept") });
  // A reason is still mandatory once it IS closable.
  assert.equal((await refusal(act(db, bookingId, "close_recovery", { reason: "ok" })))?.status, 400);

  const closed = await act(db, bookingId, "close_recovery", { reason: "replacement driver accepted and is en route" });
  assert.deepEqual({ status: closed.status, provider: closed.replacementProviderId, booking: closed.bookingPreserved, route: closed.routePreserved },
    { status: "resolved", provider: REPLACEMENT, booking: true, route: true });
  const caseRow = sqlite.prepare("SELECT status,resolved_at,detail_json FROM taxi_recovery_cases WHERE id=?").get(recoveryId);
  assert.equal(String(caseRow.status), "resolved");
  assert.ok(Number(caseRow.resolved_at) > 0);
  const detail = JSON.parse(String(caseRow.detail_json));
  assert.deepEqual({ closedBy: detail.closedBy, route: detail.routePreserved, reason: detail.closureReason },
    { closedBy: OPS_STAFF, route: true, reason: "replacement driver accepted and is en route" });
  // Closing twice is refused rather than reopening and re-closing the case.
  assert.equal((await refusal(act(db, bookingId, "close_recovery", { reason: "closing an already closed recovery" })))?.status, 409);
  // And the booking has left the recovery flag behind.
  assert.equal((await bookingOf(db, bookingId)).exceptionFlags.includes("driver_recovery"), false);
});

// ---------------------------------------------------------------------------------------------
test("Gate 5: the Operations API is staff-permissioned, audited and idempotent", async () => {
  const world = await opsWorld();
  const { sqlite, db, bookingId, tripId } = world;
  openRecovery(sqlite, { bookingId, tripId });
  seedDriver(sqlite, { providerId: REPLACEMENT });

  // bookings.manage is required — bookings.view is NOT enough. The old test asserted the absence of the
  // string `requirePermission(actor,"bookings.view")` in the route file.
  const body = { bookingId, action: "assign_replacement", idempotencyKey: nextKey("route"), providerId: REPLACEMENT, reason: "original driver did not arrive" };
  assert.equal((await opsPost(SUPPORT, body)).status, 403, "viewing bookings is not managing them");
  assert.ok([401, 403].includes((await opsPost("", body)).status), "and an anonymous caller reaches nothing");
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "reassignment_needed");

  const offered = await opsPost(OPS_STAFF, body);
  assert.equal(offered.status, 202, `an offer is accepted for driver response, not treated as done: ${JSON.stringify(offered)}`);
  assert.equal(offered.body.data.routePreserved, true);
  assert.equal(offered.body.sandboxOnly, true);

  // A GET is gated the same way and returns the real queue.
  const read = await opsRoute.GET(new Request(taxiUrl("/api/taxi-ops"), { headers: { "oai-authenticated-user-email": OPS_STAFF } }));
  assert.equal(read.status, 200);
  const snapshot = await read.json();
  assert.equal(snapshot.data.bookings.length, 1);
  assert.equal(snapshot.data.readiness.productionReady, false);
  assert.equal((await opsRoute.GET(new Request(taxiUrl("/api/taxi-ops"), { headers: { "oai-authenticated-user-email": SUPPORT } }))).status, 403);

  // A NOTE needs to say something, and is attributed to the acting operator.
  assert.equal((await opsPost(OPS_STAFF, { bookingId, action: "add_note", idempotencyKey: nextKey("route"), note: "hi" })).status, 400);
  // The body tries to claim a different author; the route must ignore it and record the session's own.
  const noted = await opsPost(OPS_STAFF, { bookingId, action: "add_note", idempotencyKey: nextKey("route"), note: "called the customer to explain the delay", actorId: SUPPORT });
  assert.equal(noted.status, 200);
  const note = sqlite.prepare("SELECT note,actor_id FROM taxi_ops_notes WHERE booking_id=?").get(bookingId);
  assert.equal(String(note.actor_id), OPS_STAFF, "the note's author is the authenticated operator, not the body's claim");

  /*
   * An unknown action is a 400, and a missing field is too.
   *
   * SABOTAGE NOTE. Deleting the ROUTE's action allowlist does not redden this, because mutateTaxiOps
   * ends with its own "Unsupported Pet Taxi Operations action" refusal — the two are mutually
   * redundant, and the module's is the decisive one. Recorded as an equivalent mutation.
   */
  assert.equal((await opsPost(OPS_STAFF, { bookingId, action: "cancel_everything", idempotencyKey: nextKey("route") })).status, 400);
  assert.equal((await opsPost(OPS_STAFF, { bookingId, action: "add_note", note: "no key supplied" })).status, 400);

  // IDEMPOTENT per key: a retried Operations tap does not add a second note.
  const noteKey = nextKey("route");
  await opsPost(OPS_STAFF, { bookingId, action: "add_note", idempotencyKey: noteKey, note: "first attempt at the note" });
  const replay = await opsPost(OPS_STAFF, { bookingId, action: "add_note", idempotencyKey: noteKey, note: "a completely different note" });
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_ops_notes WHERE note='a completely different note'").get().c), 0,
    "a replayed key cannot smuggle different content in");

  // Every Operations action leaves a security audit row naming the actor.
  const audits = sqlite.prepare("SELECT action,actor_email,outcome FROM security_audit_events WHERE resource_id=? ORDER BY created_at").all(bookingId);
  assert.ok(audits.length >= 2, `Operations actions must be audited: ${JSON.stringify(audits)}`);
  assert.deepEqual([...new Set(audits.map((row) => String(row.actor_email)))], [OPS_STAFF]);
  assert.deepEqual([...new Set(audits.map((row) => String(row.outcome)))], ["completed"]);
  assert.ok(audits.some((row) => String(row.action) === "taxi.ops.assign_replacement"));
  assert.ok(audits.some((row) => String(row.action) === "taxi.ops.add_note"));
});

// ---------------------------------------------------------------------------------------------
test("Gate 5: only the offered driver can accept a replacement through the recovery API", async () => {
  const world = await opsWorld();
  const { sqlite, db, bookingId, tripId } = world;
  openRecovery(sqlite, { bookingId, tripId });
  seedDriver(sqlite, { providerId: REPLACEMENT });
  await act(db, bookingId, "assign_replacement", { providerId: REPLACEMENT, reason: "original driver did not arrive" });

  const replacementSession = await customerSessionCookie(db, { principalKey: REPLACEMENT_PRINCIPAL, customerId: REPLACEMENT, subjectType: "provider" });
  const otherSession = await customerSessionCookie(db, { principalKey: OTHER_PRINCIPAL, customerId: "taxi_someone_else", subjectType: "provider" });
  const post = async (session, body) => {
    const headers = { "content-type": "application/json", ...(session.cookie ? { cookie: session.cookie } : {}), ...(session.staff ? { "oai-authenticated-user-email": session.staff } : {}) };
    const response = await recoveryRoute.POST(new Request(taxiUrl("/api/taxi-recovery"), { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // ANOTHER DRIVER, with an equally valid session, cannot accept a trip offered to someone else.
  const intruder = await post(otherSession, { bookingId, idempotencyKey: nextKey("route") });
  assert.ok([401, 403].includes(intruder.status), `a different driver must be refused: ${JSON.stringify(intruder)}`);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "reassignment_offered");
  // And neither can an anonymous caller.
  assert.ok([401, 403].includes((await post({}, { bookingId, idempotencyKey: nextKey("route") })).status));
  // A missing booking or key is a 400 before anything is looked up.
  assert.equal((await post(replacementSession, { idempotencyKey: nextKey("route") })).status, 400);
  assert.equal((await post(replacementSession, { bookingId })).status, 400);

  // THE OFFERED DRIVER can, and the booking becomes theirs.
  const accepted = await post(replacementSession, { bookingId, idempotencyKey: nextKey("route") });
  assert.equal(accepted.status, 200, `the offered driver must be able to accept: ${JSON.stringify(accepted)}`);
  assert.equal(accepted.body.data.status, "assigned");
  assert.equal(accepted.body.data.routePreserved, true);
  assert.equal(String(sqlite.prepare("SELECT provider_id,status FROM canonical_bookings WHERE id=?").get(bookingId).provider_id), REPLACEMENT);
  assert.equal(String(sqlite.prepare("SELECT id FROM taxi_trips WHERE booking_id=?").get(bookingId).id), tripId, "the same trip, not a new one");
  // The acceptance is audited against the driver's own identity.
  const audit = sqlite.prepare("SELECT action,actor_email FROM security_audit_events WHERE resource_id=? AND action='taxi.recovery.accept_replacement'").get(bookingId);
  assert.equal(String(audit.actor_email), `provider:${REPLACEMENT}`);
});

// ---------------------------------------------------------------------------------------------
test("Gate 5 declares itself sandbox-governed and explicitly not production ready", async () => {
  const world = await opsWorld();
  const { db } = world;
  const snapshot = await ops.getTaxiOpsSnapshot(db);

  // The readiness block is READ, not matched against source text. It is what the Operations screen
  // renders, so a change here is a change to what a human is told.
  assert.deepEqual(snapshot.readiness, {
    engineeringGate: "gate_5_closed_uat_contract",
    productionReady: false,
    customerJourney: "canonical",
    driverJourney: "canonical",
    opsExceptionQueue: "canonical",
    finance: "sandbox_governed",
    proof: "private_scan_gated_contract",
    routeEvidence: "deterministic_sandbox_verified",
    gpsConnected: true,
    telemetryMode: "deterministic_sandbox",
    externalDependencies: {
      productionMaps: "disconnected",
      productionGps: "sandbox_simulated",
      objectStorage: "disconnected",
      malwareScanner: "disconnected",
      whatsappPush: "queued_only",
      payments: "sandbox_only",
      refunds: "sandbox_only",
      tax: "resolved_completion_ledger",
      driverPayout: "accrued_completion_ledger",
      vehicleCompliance: "uat_only",
    },
  });
  // The two that matter most are asserted again on their own, so a partial regression is unmissable.
  assert.equal(snapshot.readiness.productionReady, false, "Gate 5 is a UAT contract, not a launch");
  assert.equal(snapshot.readiness.externalDependencies.payments, "sandbox_only");
  assert.equal(snapshot.readiness.externalDependencies.productionMaps, "disconnected");
  assert.ok(Number(snapshot.generatedAt) > 0, "and the snapshot is stamped when it was taken");
});
