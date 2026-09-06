/**
 * Pet Sitting Gate 2 — EXECUTED. Sitter acceptance, the care plan, the check-in geofence, care
 * events, checkout and the escalation paths.
 *
 * WHAT THIS FILE USED TO BE. Eight tests of regexes over `lib/sitting-lifecycle.ts`, the lifecycle
 * route, its client and the sitter workspace. The geofence was "verified" by asserting the token
 * `SITTING_CHECKIN_GEOFENCE_METERS` appeared in the file. It does — in a file that never compares a
 * distance to it, too.
 *
 * THE PREVIEW TRAP, A SECOND TIME. The geofence is skipped entirely when the worker runtime reports
 * `NODE_ENV=test` AND `PAWSPACE_LOCAL_PREVIEW=on` — which is exactly what `npm test` sets. A geofence
 * test run under the default runtime therefore proves nothing. Every geofence assertion below runs
 * against a runtime with the preview flag ABSENT, and the local-UAT bypass is asserted separately and
 * deliberately so the two states cannot be confused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, refusal, nextKey, seedSittingBooking, validSittingCarePlan,
  seedDoorstep, metresNorth, stayUrl, seedActiveCommercialTerm,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__SITTING_G2_DB__", "__SITTING_G2_ENV__");

const lifecycle = await import("../lib/sitting-lifecycle.ts");

const SITTER = "sitter_ananya";
const GEOFENCE_METRES = lifecycle.SITTING_CHECKIN_GEOFENCE_METERS;
// Pinned to a LITERAL on purpose. Deriving every distance in this file from the exported constant
// makes the geofence tests self-referential: widening the fence to 25km would widen the "far away"
// fixture with it and nothing would fail. Sabotage found exactly that, so the value is asserted
// independently below and the out-of-range fixture is an absolute distance.
const EXPECTED_GEOFENCE_METRES = 250;

const liveWindow = () => ({
  scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
  scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
});

/**
 * `runtime` decides whether the geofence is enforced. `{}` is a production-shaped runtime; passing
 * the preview pair reproduces what `npm test` sets and turns the geofence off.
 */
async function sittingWorld({ runtime = {}, doorstep = true, ...options } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__SITTING_G2_DB__ = db;
  globalThis.__SITTING_G2_ENV__ = runtime;
  const seeded = await seedSittingBooking(db, sqlite, { window: liveWindow(), ...options });
  const point = doorstep ? seedDoorstep(sqlite, { bookingId: seeded.bookingId, customerId: seeded.customerId }) : null;

  const act = (action, extra = {}) => lifecycle.mutateSittingBooking(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? SITTER,
    idempotencyKey: extra.idempotencyKey ?? nextKey("SG2"), ...extra,
  });
  const bookingRow = async () => db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(seeded.bookingId).first();
  return { sqlite, db, ...seeded, doorstep: point, act, bookingRow };
}

async function readyForCheckIn(world) {
  await world.act("accept");
  await world.act("submit_care_plan", { carePlan: validSittingCarePlan(), actorId: world.customerId });
  return world;
}

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 requires sitter acceptance before anything else happens", async () => {
  const world = await sittingWorld();

  const early = await refusal(world.act("check_in", { ...metresNorth(world.doorstep, 10) }));
  assert.equal(early?.status, 409);
  assert.match(early.message, /Sitter acceptance is required before check-in/);

  const accepted = await world.act("accept");
  assert.ok(accepted);

  // Acceptance consumes the assignment offer, so a second acceptance has nothing left to answer.
  const again = await refusal(world.act("accept"));
  assert.equal(again?.status, 409);
  assert.match(again.message, /No pending sitter offer is available/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 care plan needs emergency contact, vet AND home access", async () => {
  const world = await sittingWorld();
  await world.act("accept");

  // Home access is the requirement Boarding does not have: without it a sitter cannot get in, and a
  // guard that only checks the two Boarding fields would pass this.
  for (const missing of [{ emergencyContact: "" }, { vet: "" }, { homeAccess: "" }]) {
    const refused = await refusal(world.act("submit_care_plan", { carePlan: validSittingCarePlan(missing), actorId: world.customerId }));
    assert.equal(refused?.status, 409, `care plan missing ${Object.keys(missing)} must be refused`);
    assert.match(refused.message, /emergency contact, vet and home access details/);
  }

  const ready = await world.act("submit_care_plan", { carePlan: validSittingCarePlan(), actorId: world.customerId });
  assert.ok(ready);

  const snapshots = await world.db.prepare("SELECT COUNT(*) n FROM sitting_care_plan_snapshots WHERE booking_id=?").bind(world.bookingId).all();
  assert.ok(Number(snapshots.results[0].n) >= 1, "the plan is snapshotted, so what the sitter was told stays recoverable");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 enforces the check-in geofence against the customer's doorstep", async () => {
  // Production-shaped runtime: the preview flag is absent, so the geofence is live.
  const world = await readyForCheckIn(await sittingWorld({ runtime: {} }));
  assert.equal(GEOFENCE_METRES, EXPECTED_GEOFENCE_METRES, "the Sitting doorstep fence is 250m; widening it is a policy change, not a refactor");

  // An ABSOLUTE distance, not a multiple of the constant, so this stays out of range however the
  // constant moves.
  const farAway = await refusal(world.act("check_in", { ...metresNorth(world.doorstep, 1_200) }));
  assert.equal(farAway?.status, 409);
  assert.match(farAway.message, new RegExp(`check-in requires <=${GEOFENCE_METRES}m`));
  assert.match(farAway.message, /^Sitter is \d+m from the customer doorstep/);
  assert.equal((await world.bookingRow()).status, "assigned", "a refused check-in must not start the visit");

  const atTheDoor = await world.act("check_in", { ...metresNorth(world.doorstep, 20) });
  assert.equal(atTheDoor.geofence.distanceMeters, 20, "the measured distance is the real one, not a placeholder");
  assert.equal(atTheDoor.geofence.thresholdMeters, GEOFENCE_METRES);
  assert.equal(atTheDoor.geofence.simulated, false, "a real check-in is not the simulated local-UAT path");
  assert.equal(atTheDoor.geofence.telemetryMode, "client_coordinates");
  assert.equal((await world.bookingRow()).status, "in_progress");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 refuses check-in when coordinates are missing, unless it is local UAT", async () => {
  // No coordinates supplied, production-shaped runtime.
  const noCoords = await readyForCheckIn(await sittingWorld({ runtime: {} }));
  const refusedCoords = await refusal(noCoords.act("check_in"));
  assert.equal(refusedCoords?.status, 409);
  assert.match(refusedCoords.message, /requires provider latitude and longitude/);

  // Coordinates supplied, but the customer has set no doorstep at all.
  const noDoorstep = await readyForCheckIn(await sittingWorld({ runtime: {}, doorstep: false, bookingId: "BKG-SIT-NODOOR" }));
  const refusedDoorstep = await refusal(noDoorstep.act("check_in", { latitude: 12.97, longitude: 77.59 }));
  assert.equal(refusedDoorstep?.status, 409);
  assert.match(refusedDoorstep.message, /doorstep coordinates are not configured/);

  // THE DOCUMENTED BYPASS. With the local-UAT pair the module skips the geofence entirely. This is
  // asserted on purpose: it is the reason every geofence test above declares an empty runtime, and a
  // reader who does not know it would write a geofence test that silently proves nothing.
  const localUat = await readyForCheckIn(await sittingWorld({
    runtime: { NODE_ENV: "test", PAWSPACE_LOCAL_PREVIEW: "on" }, doorstep: false, bookingId: "BKG-SIT-UAT",
  }));
  const simulated = await localUat.act("check_in");
  assert.ok(simulated, "local UAT check-in succeeds with no coordinates and no doorstep");
  assert.equal(simulated.geofence.simulated, true, "and it reports itself simulated rather than measured");
  assert.equal(simulated.geofence.telemetryMode, "deterministic_local_uat");
  assert.equal((await localUat.bookingRow()).status, "in_progress");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 records only canonical care events, and only during an active booking", async () => {
  const world = await readyForCheckIn(await sittingWorld({ runtime: {} }));

  const beforeStart = await refusal(world.act("care_event", { careEventType: "meal", detail: {} }));
  assert.equal(beforeStart?.status, 409);
  assert.match(beforeStart.message, /only during an active booking/);

  await world.act("check_in", { ...metresNorth(world.doorstep, 20) });

  const invented = await refusal(world.act("care_event", { careEventType: "spa_day", detail: {} }));
  assert.equal(invented?.status, 400);
  assert.match(invented.message, /Unsupported Sitting care event/);

  for (const careEventType of ["meal", "walk", "medication", "photo_update", "general_update", "incident", "home_check"]) {
    assert.ok(await world.act("care_event", { careEventType, detail: { note: careEventType } }), `${careEventType} is canonical`);
  }
  // The lifecycle writes its own events too (check-in among them), so the assertion is that each
  // canonical type is present exactly once rather than that the table holds only these seven.
  const logged = await world.db.prepare("SELECT event_type,COUNT(*) n FROM sitting_care_events WHERE booking_id=? GROUP BY event_type").bind(world.bookingId).all();
  const byType = new Map(logged.results.map((row) => [String(row.event_type), Number(row.n)]));
  // The stored event type is namespaced (`meal` is written as `care_meal`), so the assertion follows
  // the row rather than the request field.
  for (const careEventType of ["meal", "walk", "medication", "photo_update", "general_update", "incident", "home_check"]) {
    assert.equal(byType.get(`care_${careEventType}`), 1, `${careEventType} is logged exactly once`);
  }
  assert.equal(byType.get("checked_in"), 1, "and the lifecycle's own events are in the same log");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 checks out only an active booking", async () => {
  const world = await readyForCheckIn(await sittingWorld({ runtime: {} }));

  const early = await refusal(world.act("check_out"));
  assert.equal(early?.status, 409);
  assert.match(early.message, /Only an active Sitting booking can be checked out/);

  await world.act("check_in", { ...metresNorth(world.doorstep, 20) });

  // Checkout resolves completion finance, and the platform refuses to invent a payout or a tax
  // status for a service nobody has configured. Both directions are asserted: refused without an
  // active commercial term, and completing once one exists.
  const unconfigured = await world.act("check_out").then(() => null, (error) => error);
  assert.ok(unconfigured, "checkout without a commercial term must not silently succeed");
  assert.match(String(unconfigured?.message ?? unconfigured), /no active commercial term for service pet_sitting/);
  assert.equal((await world.bookingRow()).status, "in_progress", "and must not close the booking");

  await seedActiveCommercialTerm(world.db, { serviceCode: "pet_sitting" });
  const closed = await world.act("check_out");
  assert.ok(closed);
  assert.equal((await world.bookingRow()).status, "completed");

  const again = await refusal(world.act("check_out"));
  assert.equal(again?.status, 409);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 replays one idempotency key and refuses to reuse it for another action", async () => {
  const world = await sittingWorld();
  const key = nextKey("SG2-IDEM");

  const first = await world.act("accept", { idempotencyKey: key });
  const replay = await world.act("accept", { idempotencyKey: key });
  assert.deepEqual({ ...replay, duplicatePrevented: undefined }, { ...first, duplicatePrevented: undefined });

  const reused = await refusal(world.act("decline", { idempotencyKey: key, reason: "changed my mind" }));
  assert.equal(reused?.status, 409);
  assert.match(reused.message, /this key was already used for a different one/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 escalates a decline and a sitter outage without losing the booking", async () => {
  for (const [action, needsAccept] of [["decline", false], ["sitter_unavailable", true]]) {
    const world = await sittingWorld({ bookingId: `BKG-SIT-${action}` });
    if (needsAccept) await world.act("accept");

    const escalated = await world.act(action, { reason: "family emergency came up" });
    assert.ok(escalated, `${action} is a supported escalation`);

    const booking = await world.bookingRow();
    assert.notEqual(booking.status, "cancelled", `${action} must not cancel the customer's booking`);

    const recovery = await world.db.prepare("SELECT COUNT(*) n FROM sitting_recovery_cases WHERE booking_id=?").bind(world.bookingId).all();
    assert.ok(Number(recovery.results[0].n) >= 1, `${action} opens an Operations recovery case`);
  }

  const reasonless = await sittingWorld({ bookingId: "BKG-SIT-NOREASON" });
  const refused = await refusal(reasonless.act("decline"));
  assert.equal(refused?.status, 400);
  assert.match(refused.message, /recovery reason is required/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 2 refuses an unknown booking, an unknown action and an incomplete request", async () => {
  const world = await sittingWorld();

  const unknown = await refusal(lifecycle.mutateSittingBooking(world.db, {
    bookingId: "BKG-NOT-REAL", action: "accept", actorId: SITTER, idempotencyKey: nextKey("SG2"),
  }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Sitting booking not found/);

  const unsupported = await refusal(world.act("teleport"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Sitting lifecycle action/);

  const incomplete = await refusal(lifecycle.mutateSittingBooking(world.db, {
    bookingId: world.bookingId, action: "accept", actorId: "", idempotencyKey: "",
  }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting lifecycle API is a guarded route", async () => {
  const world = await sittingWorld();
  const gateway = await import("../lib/api-gateway.ts");

  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/sitting-lifecycle"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated lifecycle action outright");
  } else {
    assert.ok(decision.permission, "a Sitting lifecycle action is never public");
  }

  const route = await import("../app/api/sitting-lifecycle/route.ts");
  const anonymous = await route.POST(new Request(stayUrl("/api/sitting-lifecycle"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: world.bookingId, action: "accept", idempotencyKey: nextKey("SG2-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous acceptance is refused: ${anonymous.status}`);
  assert.equal((await world.bookingRow()).status, "confirmed", "a refused request must not have accepted the booking");
});
