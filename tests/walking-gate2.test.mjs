/**
 * Dog Walking Gate 2 — EXECUTED. Walker acceptance, governed handover, the start geofence, the
 * bounded event vocabulary, payment-due completion and walker recovery.
 *
 * WHAT THIS FILE USED TO BE. Seven tests, every assertion a regex over the source of
 * `lib/walking-lifecycle.ts`, the route and the walker page. "requires governed handover and active
 * sandbox GPS before start" asserted that the string `WALKING_START_GEOFENCE_METERS` appeared in the
 * file. It appears whether the constant is 250 metres, 250 kilometres or never compared against
 * anything.
 *
 * Each test below drives the real `mutateWalkingBooking` against a real SQLite-backed D1 and asserts
 * on the rows it wrote. Requests are built on a NON-PREVIEW origin, because `npm test` runs with
 * PAWSPACE_LOCAL_PREVIEW=on and anything posted to localhost resolves to a superuser holding ["*"].
 *
 * NOTE ON THE GEOFENCE. Unlike Sitting, Walking's start geofence is NOT skipped under local preview —
 * it always runs and reports telemetryMode "deterministic_sandbox". That difference is real, and it is
 * why this file can assert the fence directly where the Sitting file has to strip the preview flag.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, metresNorth, nextKey, refusal, seedActiveCommercialTerm, seedDoorstep,
  seedWalkingBooking,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__WALK_G2_DB__", "__WALK_G2_ENV__");

const lifecycle = await import("../lib/walking-lifecycle.ts");

const DOORSTEP = { latitude: 12.9611, longitude: 77.6387 };

async function walkingWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALK_G2_DB__ = db;
  globalThis.__WALK_G2_ENV__ = {};
  // The last walk of a booking resolves service-completion finance, which refuses outright without an
  // active commercial term for the service.
  await seedActiveCommercialTerm(db, { serviceCode: "dog_walking" });
  const booking = await seedWalkingBooking(db, sqlite, options);
  seedDoorstep(sqlite, {
    bookingId: booking.bookingId, customerId: booking.customerId, providerId: booking.providerId, ...DOORSTEP,
  });
  return { sqlite, db, booking };
}

const act = (db, booking, action, extra = {}) => lifecycle.mutateWalkingBooking(db, {
  bookingId: booking.bookingId, action, actorId: booking.providerId, idempotencyKey: nextKey(), ...extra,
});

/** Drive a session all the way to in_progress, standing on the doorstep. */
async function startWalk(db, booking, sessionId = booking.sessionId) {
  await act(db, booking, "accept");
  await act(db, booking, "confirm_handover", { sessionId, handoverMethod: "owner" });
  return act(db, booking, "start_walk", { sessionId, ...DOORSTEP });
}

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 2 owns walker acceptance and idempotency", async () => {
  const { db, booking } = await walkingWorld();

  const key = nextKey();
  const accepted = await lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action: "accept", actorId: booking.providerId, idempotencyKey: key,
  });
  assert.equal(accepted.status, "assigned");
  assert.equal(accepted.duplicatePrevented, undefined, "the first acceptance is not a replay");

  // The canonical rows move together, and the offer is answered rather than left pending.
  const bookingRow = await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first();
  const workOrder = await db.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").bind(booking.bookingId).first();
  const offer = await db.prepare("SELECT status,response_reason FROM provider_assignment_offers WHERE group_id=?").bind(booking.groupId).first();
  assert.equal(bookingRow.status, "assigned");
  assert.equal(workOrder.status, "accepted");
  assert.equal(offer.status, "accepted");

  // Replaying the SAME key returns the remembered result and writes nothing new.
  const replay = await lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action: "accept", actorId: booking.providerId, idempotencyKey: key,
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.status, "assigned");
  const events = await db.prepare("SELECT COUNT(*) AS n FROM walking_session_events WHERE booking_id=? AND event_type='walker_accepted'").bind(booking.bookingId).first();
  assert.equal(Number(events.n), 1, "a replayed acceptance does not log a second acceptance");

  // A FRESH key on an already-assigned booking is a real second attempt, and is refused on state.
  const second = await refusal(act(db, booking, "accept"));
  assert.equal(second?.status, 409);
  assert.match(second.message, /not awaiting walker acceptance/);

  // The same key pointed at a different action is a caller bug, not a replay.
  const crossed = await refusal(lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action: "decline", actorId: booking.providerId,
    idempotencyKey: key, reason: "cannot make it",
  }));
  assert.equal(crossed?.status, 409);
  assert.match(crossed.message, /this key was already used for a different one/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking acceptance refuses an expired or mismatched walker offer", async () => {
  const expired = await walkingWorld({ bookingId: "BKG-WALK-EXP" });
  await expired.db.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?")
    .bind(Date.now() - 60_000, expired.booking.groupId).run();
  const late = await refusal(act(expired.db, expired.booking, "accept"));
  assert.equal(late?.status, 409);
  assert.match(late.message, /offer expired; Operations recovery is required/);
  assert.equal(
    (await expired.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(expired.booking.bookingId).first()).status,
    "confirmed",
    "a refused acceptance leaves the booking unassigned",
  );

  // An offer that belongs to somebody else cannot be accepted by this walker either.
  const stolen = await walkingWorld({ bookingId: "BKG-WALK-STOLEN" });
  await stolen.db.prepare("UPDATE provider_assignment_offers SET provider_id='walker_other' WHERE group_id=?")
    .bind(stolen.booking.groupId).run();
  const notMine = await refusal(act(stolen.db, stolen.booking, "accept"));
  assert.equal(notMine?.status, 409);
  assert.match(notMine.message, /No pending walker offer is available/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 2 requires governed handover and an on-doorstep start", async () => {
  const { db, booking } = await walkingWorld();

  // A walk cannot start before the booking is assigned.
  const early = await refusal(act(db, booking, "start_walk", { sessionId: booking.sessionId, ...DOORSTEP }));
  assert.equal(early?.status, 409);
  assert.match(early.message, /Canonical booking must be assigned before a walk starts/);

  await act(db, booking, "accept");

  // Handover is a governed vocabulary, not free text.
  const madeUp = await refusal(act(db, booking, "confirm_handover", { sessionId: booking.sessionId, handoverMethod: "left_at_gate" }));
  assert.equal(madeUp?.status, 400);
  assert.match(madeUp.message, /A governed Dog Walking handover method is required/);

  const noHandover = await refusal(act(db, booking, "start_walk", { sessionId: booking.sessionId, ...DOORSTEP }));
  assert.equal(noHandover?.status, 409);
  assert.match(noHandover.message, /Confirmed handover is required before a walk starts/);

  const handover = await act(db, booking, "confirm_handover", { sessionId: booking.sessionId, handoverMethod: "owner" });
  assert.equal(handover.status, "ready_to_start");
  assert.equal(handover.otpConnected, false, "the handover attestation never claims a live OTP");
  const handoverRow = await db.prepare("SELECT method,status,detail_json FROM walking_handover_events WHERE session_id=?").bind(booking.sessionId).first();
  assert.equal(handoverRow.method, "owner");
  assert.equal(handoverRow.status, "confirmed");
  assert.deepEqual(JSON.parse(handoverRow.detail_json), { uatAttestation: true, otpConnected: false });

  // GPS is required, and it is compared against the real doorstep.
  const noGps = await refusal(act(db, booking, "start_walk", { sessionId: booking.sessionId }));
  assert.equal(noGps?.status, 409);
  assert.match(noGps.message, /requires walker latitude and longitude/);

  // 1200m away. Pinned to an absolute distance, NOT derived from the exported constant, so widening
  // the fence cannot quietly move the fixture with it.
  const farAway = await refusal(act(db, booking, "start_walk", { sessionId: booking.sessionId, ...metresNorth(DOORSTEP, 1200) }));
  assert.equal(farAway?.status, 409);
  assert.match(farAway.message, /from the customer doorstep; start requires <=250m/);
  assert.equal(
    (await db.prepare("SELECT status FROM walking_sessions WHERE id=?").bind(booking.sessionId).first()).status,
    "ready_to_start",
    "a refused start leaves the session unstarted",
  );

  const started = await act(db, booking, "start_walk", { sessionId: booking.sessionId, ...metresNorth(DOORSTEP, 20) });
  assert.equal(started.status, "in_progress");
  assert.equal(started.thresholdMeters, 250);
  assert.ok(started.distanceMeters <= 250);
  assert.equal(started.gpsConnected, true);
  assert.equal(started.telemetryMode, "deterministic_sandbox", "sandbox GPS is never dressed up as live telemetry");
  assert.equal(
    (await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status,
    "in_progress",
  );
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 2 restricts lifecycle events and leaves evidence to proof governance", async () => {
  const { db, booking } = await walkingWorld();

  const beforeStart = await refusal(act(db, booking, "walk_event", { sessionId: booking.sessionId, walkEventType: "pee" }));
  assert.equal(beforeStart?.status, 409);
  assert.match(beforeStart.message, /can be logged only during an active walk/);

  await startWalk(db, booking);

  for (const eventType of ["pee", "poop", "water", "general_update"]) {
    const logged = await act(db, booking, "walk_event", { sessionId: booking.sessionId, walkEventType: eventType, detail: { note: eventType } });
    assert.equal(logged.status, "logged");
    assert.equal(logged.eventType, eventType);
  }
  const rows = await db.prepare("SELECT event_type FROM walking_session_events WHERE booking_id=? AND event_type LIKE 'walk\\_%' ESCAPE '\\' ORDER BY event_type").bind(booking.bookingId).all();
  assert.deepEqual(rows.results.map((row) => row.event_type).filter((type) => type !== "walk_started"),
    ["walk_general_update", "walk_pee", "walk_poop", "walk_water"]);

  // Evidence is deliberately NOT part of this vocabulary — it belongs to the proof workflow.
  for (const eventType of ["photo", "route_location_sample", "incident"]) {
    const refused = await refusal(act(db, booking, "walk_event", { sessionId: booking.sessionId, walkEventType: eventType }));
    assert.equal(refused?.status, 409);
    assert.match(refused.message, /must use the governed Walking proof workflow/);
  }
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking completion creates a payment-due event instead of a fake capture", async () => {
  const { db, sqlite, booking } = await walkingWorld();
  await startWalk(db, booking);

  // Completion is gated on canonical route proof, not on the walker saying so.
  const noProof = await refusal(act(db, booking, "complete_walk", { sessionId: booking.sessionId }));
  assert.equal(noProof?.status, 409);
  assert.match(noProof.message, /requires at least two canonical sandbox route samples/);

  const sample = sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)");
  sample.run("RS-1", booking.bookingId, booking.sessionId, booking.providerId, booking.providerId, Date.now());
  const oneSample = await refusal(act(db, booking, "complete_walk", { sessionId: booking.sessionId }));
  assert.match(oneSample.message, /at least two canonical sandbox route samples/, "one sample is not a route");
  sample.run("RS-2", booking.bookingId, booking.sessionId, booking.providerId, booking.providerId, Date.now());

  const completed = await act(db, booking, "complete_walk", { sessionId: booking.sessionId });
  assert.equal(completed.status, "completed");
  assert.equal(completed.paymentStatus, "due", "a completed walk is money DUE, never money taken");
  assert.equal(completed.liveMoney, false);
  assert.equal(completed.amount, booking.perWalkAmount);
  assert.equal(completed.allComplete, true, "the only walk completing finishes the programme");

  const payment = await db.prepare("SELECT amount,status,gateway,reference,detail_json FROM walking_session_payment_events WHERE session_id=?").bind(booking.sessionId).first();
  assert.equal(Number(payment.amount), booking.perWalkAmount);
  assert.equal(payment.status, "due");
  assert.equal(payment.gateway, "uat_sandbox");
  assert.equal(payment.reference, null, "no gateway reference is invented at completion");
  assert.deepEqual(JSON.parse(payment.detail_json), { captureRequired: true, liveMoney: false, trigger: "canonical_walk_completion" });

  // The canonical rows follow the session, and the reservation is closed out.
  assert.equal((await db.prepare("SELECT status FROM walking_sessions WHERE id=?").bind(booking.sessionId).first()).status, "completed");
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "completed");
  assert.equal((await db.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").bind(booking.bookingId).first()).status, "completed");
  assert.equal((await db.prepare("SELECT status FROM scheduling_reservations WHERE id=?").bind(booking.sessions[0].reservationId).first()).status, "completed");

  // The customer is told, on both channels, that nothing was charged.
  const notes = await db.prepare("SELECT channel,message FROM walking_customer_notifications WHERE booking_id=? AND message LIKE '%complete%'").bind(booking.bookingId).all();
  assert.deepEqual(notes.results.map((row) => row.channel).sort(), ["push", "whatsapp"]);

  // Completing twice is refused; the walk is no longer active.
  const again = await refusal(act(db, booking, "complete_walk", { sessionId: booking.sessionId }));
  assert.equal(again?.status, 409);
  assert.match(again.message, /Only an active Dog Walking session can be completed/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking multi-walk completion holds the booking open until the last walk", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-3", walkCount: 3 });
  await act(db, booking, "accept");

  const finish = async (index) => {
    const { sessionId } = booking.sessions[index];
    await act(db, booking, "confirm_handover", { sessionId, handoverMethod: "building_staff" });
    await act(db, booking, "start_walk", { sessionId, ...DOORSTEP });
    for (const n of [1, 2]) {
      sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
        .run(`RS-${index}-${n}`, booking.bookingId, sessionId, booking.providerId, booking.providerId, Date.now());
    }
    return act(db, booking, "complete_walk", { sessionId });
  };

  const first = await finish(0);
  assert.equal(first.allComplete, false);
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status,
    "assigned", "the booking returns to assigned while walks remain");

  await finish(1);
  const last = await finish(2);
  assert.equal(last.allComplete, true);
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "completed");

  // Each walk is priced and billed on its own; the total is never charged once up front.
  const payments = await db.prepare("SELECT amount FROM walking_session_payment_events WHERE booking_id=?").bind(booking.bookingId).all();
  assert.equal(payments.results.length, 3);
  for (const row of payments.results) assert.equal(Number(row.amount), booking.perWalkAmount);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking recovery preserves the booking and completed walks", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-REC", walkCount: 2 });
  await act(db, booking, "accept");

  // Complete walk 1 so recovery has something it must NOT destroy.
  const done = booking.sessions[0].sessionId;
  await act(db, booking, "confirm_handover", { sessionId: done, handoverMethod: "owner" });
  await act(db, booking, "start_walk", { sessionId: done, ...DOORSTEP });
  for (const n of [1, 2]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RSR-${n}`, booking.bookingId, done, booking.providerId, booking.providerId, Date.now());
  }
  await act(db, booking, "complete_walk", { sessionId: done });

  const noReason = await refusal(act(db, booking, "walker_unavailable", { reason: "x" }));
  assert.equal(noReason?.status, 400);
  assert.match(noReason.message, /A Dog Walking recovery reason is required/);

  const recovered = await act(db, booking, "walker_unavailable", { reason: "Walker hospitalised overnight" });
  assert.equal(recovered.status, "ops_escalation");
  assert.equal(recovered.bookingPreserved, true);
  assert.equal(recovered.bookingId, booking.bookingId, "recovery keeps the SAME canonical booking id");

  const bookingRow = await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first();
  assert.equal(bookingRow.status, "reassignment_needed");
  assert.equal((await db.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").bind(booking.bookingId).first()).status, "recovery_pending");

  const recovery = await db.prepare("SELECT status,failed_provider_id,reason_code,replacement_provider_id,detail_json FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(recovery.status, "ops_escalation");
  assert.equal(recovery.reason_code, "walker_unavailable");
  assert.equal(recovery.failed_provider_id, booking.providerId);
  assert.equal(recovery.replacement_provider_id, null, "recovery escalates to Operations, it does not self-assign a replacement");
  assert.equal(JSON.parse(recovery.detail_json).completedSessionsPreserved, true);

  // The completed walk keeps its state, its reservation and its payment-due row.
  assert.equal((await db.prepare("SELECT status FROM walking_sessions WHERE id=?").bind(done).first()).status, "completed");
  assert.equal((await db.prepare("SELECT status FROM scheduling_reservations WHERE id=?").bind(booking.sessions[0].reservationId).first()).status, "completed");
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_session_payment_events WHERE session_id=?").bind(done).first()).n), 1);

  // The unstarted walk is the one pulled back.
  const pending = booking.sessions[1];
  assert.equal((await db.prepare("SELECT status FROM walking_sessions WHERE id=?").bind(pending.sessionId).first()).status, "recovery_pending");
  assert.equal((await db.prepare("SELECT status FROM scheduling_reservations WHERE id=?").bind(pending.reservationId).first()).status, "cancelled");

  // Recovery on an already-finished booking has nothing left to recover.
  const finished = await walkingWorld({ bookingId: "BKG-WALK-FIN" });
  await finished.db.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id=?").bind(finished.booking.bookingId).run();
  const nothingLeft = await refusal(act(finished.db, finished.booking, "decline", { reason: "changed my mind" }));
  assert.equal(nothingLeft?.status, 409);
  assert.match(nothingLeft.message, /already cancelled; there is no assignment left to recover/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking lifecycle refuses a session that is not this booking's", async () => {
  const { db, sqlite, booking } = await walkingWorld();
  await act(db, booking, "accept");

  const missing = await refusal(act(db, booking, "confirm_handover", { sessionId: "WSESS-NOPE", handoverMethod: "owner" }));
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /Dog Walking session not found/);

  const noSession = await refusal(act(db, booking, "confirm_handover", { handoverMethod: "owner" }));
  assert.equal(noSession?.status, 400);
  assert.match(noSession.message, /Dog Walking session ID is required/);

  const unsupported = await refusal(act(db, booking, "teleport", { sessionId: booking.sessionId }));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Dog Walking lifecycle action/);

  // A session row that drifted onto another walker cannot be driven by this booking's walker.
  sqlite.prepare("UPDATE walking_sessions SET provider_id='walker_other' WHERE id=?").run(booking.sessionId);
  const drifted = await refusal(act(db, booking, "confirm_handover", { sessionId: booking.sessionId, handoverMethod: "owner" }));
  assert.equal(drifted?.status, 409);
  assert.match(drifted.message, /session walker does not match the canonical booking/);
});
