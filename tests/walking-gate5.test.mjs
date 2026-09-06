/**
 * Dog Walking Gate 5 — EXECUTED. The Operations exception queue, replacement eligibility, replacement
 * acceptance and recovery closure.
 *
 * WHAT THIS FILE USED TO BE. Eight tests, every assertion a regex over the source of
 * `lib/walking-ops-governance.ts`, `lib/walking-recovery-governance.ts`, the route and the Ops page.
 * "replacement candidates must cover every remaining walk window" asserted that the sentence
 * "Selected replacement walker is not eligible for every remaining walk window" appeared in a file. It
 * appears whether eligibility is checked against every window, the first window, or nothing at all.
 *
 * Each test below drives the real `getWalkingOpsSnapshot`, `mutateWalkingOps` and
 * `acceptWalkingReplacement` against a real SQLite-backed D1, over a booking genuinely broken by a
 * walker becoming unavailable mid-programme.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, nextKey, refusal, seedActiveCommercialTerm, seedDoorstep, seedWalkingBooking,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__WALK_G5_DB__", "__WALK_G5_ENV__");

const lifecycle = await import("../lib/walking-lifecycle.ts");
const ops = await import("../lib/walking-ops-governance.ts");
const recovery = await import("../lib/walking-recovery-governance.ts");

const DOORSTEP = { latitude: 12.9611, longitude: 77.6387 };
// Real governed walkers seeded by provider-capacity-governance, all in blr/blr-east.
const ORIGINAL = "walk_nisha";
const REPLACEMENT = "walk_asha";
const OPS_STAFF = "ops.duty@pawspace.test";

async function opsWorld({ walkCount = 2, ...options } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALK_G5_DB__ = db;
  globalThis.__WALK_G5_ENV__ = {};
  await seedActiveCommercialTerm(db, { serviceCode: "dog_walking" });
  const booking = await seedWalkingBooking(db, sqlite, { providerId: ORIGINAL, walkCount, ...options });
  seedDoorstep(sqlite, {
    bookingId: booking.bookingId, customerId: booking.customerId, providerId: ORIGINAL, ...DOORSTEP,
  });
  const act = (action, extra) => lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action, actorId: ORIGINAL, idempotencyKey: nextKey(), ...extra,
  });
  await act("accept");
  return { sqlite, db, booking, act };
}

/** Complete one walk of the booking so recovery has real history it must preserve. */
async function completeWalk(db, sqlite, booking, act, index = 0) {
  const { sessionId } = booking.sessions[index];
  await act("confirm_handover", { sessionId, handoverMethod: "owner" });
  await act("start_walk", { sessionId, ...DOORSTEP });
  for (const n of [1, 2]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RS5-${index}-${n}-${crypto.randomUUID().slice(0, 6)}`, booking.bookingId, sessionId, ORIGINAL, ORIGINAL, Date.now());
  }
  await act("complete_walk", { sessionId });
  return sessionId;
}

const opsAct = (db, booking, action, extra = {}) => ops.mutateWalkingOps(db, {
  bookingId: booking.bookingId, action, actorId: OPS_STAFF, idempotencyKey: nextKey(), ...extra,
});

/** Break the booking: one walk done, the walker then unavailable for the rest. */
async function brokenBooking(options) {
  const world = await opsWorld(options);
  const done = await completeWalk(world.db, world.sqlite, world.booking, world.act);
  await world.act("walker_unavailable", { reason: "Walker injured; cannot cover remaining walks" });
  return { ...world, done };
}

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 5 builds one canonical Operations exception queue", async () => {
  const { db, booking } = await brokenBooking({ bookingId: "BKG-WALK-QUEUE" });

  const snapshot = await ops.getWalkingOpsSnapshot(db);
  assert.equal(snapshot.source, "canonical Dog Walking UAT database");
  assert.equal(snapshot.metrics.total, 1);
  assert.equal(snapshot.metrics.needsAttention, 1);
  assert.equal(snapshot.metrics.recovery, 1);

  const entry = snapshot.bookings.find((row) => row.id === booking.bookingId);
  assert.ok(entry, "the broken booking is in the queue");
  assert.ok(entry.exceptionFlags.includes("walker_recovery"), "a recovery-pending booking is flagged");
  assert.ok(entry.exceptionFlags.includes("completed_payment_due"), "the unpaid completed walk is flagged");
  assert.equal(entry.priority, "high", "walker recovery is high priority");
  assert.equal(entry.completedPaymentDue, booking.perWalkAmount);
  assert.equal(entry.recovery.status, "ops_escalation");
  assert.equal(entry.sessions.length, 2, "the queue shows every walk of the booking");

  // The readiness block is honest about every disconnected dependency.
  assert.equal(snapshot.readiness.productionReady, false);
  assert.equal(snapshot.readiness.engineeringGate, "gate_5_closed_uat_contract");
  assert.deepEqual(snapshot.readiness.externalDependencies, {
    productionGps: "disconnected", objectStorage: "disconnected", malwareScanner: "disconnected",
    whatsappPush: "queued_only", payments: "sandbox_only", refunds: "sandbox_only",
    tax: "configuration_required", walkerPayout: "rule_pending",
  });

  // A clean booking is NOT flagged: the queue is an exception queue, not a list of everything.
  const clean = await opsWorld({ bookingId: "BKG-WALK-CLEAN", walkCount: 1 });
  const second = await ops.getWalkingOpsSnapshot(clean.db);
  const cleanEntry = second.bookings.find((row) => row.id === "BKG-WALK-CLEAN");
  assert.deepEqual(cleanEntry.exceptionFlags, []);
  assert.equal(cleanEntry.priority, "clear");
  assert.equal(second.metrics.clear, 1);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking replacement candidates must cover every remaining walk window", async () => {
  const { db, booking } = await brokenBooking({ bookingId: "BKG-WALK-ELIGIBLE", walkCount: 3 });

  const before = await ops.getWalkingOpsSnapshot(db);
  const entry = before.bookings.find((row) => row.id === booking.bookingId);
  const candidateIds = entry.replacementCandidates.map((row) => row.providerId);
  assert.ok(candidateIds.includes(REPLACEMENT), "an eligible walker is offered");
  assert.ok(!candidateIds.includes(ORIGINAL), "the failed walker is never offered as their own replacement");
  for (const candidate of entry.replacementCandidates) {
    assert.equal(candidate.remainingSessions, 2, "a candidate is scored against every remaining walk");
  }

  // Block the replacement for the LAST remaining window only. Covering two of three walks is not
  // covering the booking.
  const last = booking.sessions[2];
  await db.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES ('PU-1',?,?,?,'Family commitment','active','ops',?,?)")
    .bind(REPLACEMENT, last.scheduledStart, last.scheduledEnd, Date.now(), Date.now()).run();

  const after = await ops.getWalkingOpsSnapshot(db);
  const narrowed = after.bookings.find((row) => row.id === booking.bookingId).replacementCandidates.map((row) => row.providerId);
  assert.ok(!narrowed.includes(REPLACEMENT), "a walker free for only some of the remaining walks is not a candidate");

  const refused = await refusal(opsAct(db, booking, "assign_replacement", {
    providerId: REPLACEMENT, reason: "Trying the blocked walker anyway",
  }));
  assert.equal(refused?.status, 409);
  assert.match(refused.message, /not eligible for every remaining walk window/);
  assert.equal(
    (await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status,
    "reassignment_needed",
    "a refused assignment leaves the booking in recovery",
  );

  // A walker who is not a governed profile at all is likewise refused.
  const invented = await refusal(opsAct(db, booking, "assign_replacement", {
    providerId: "walker_from_nowhere", reason: "Someone we found ourselves",
  }));
  assert.equal(invented?.status, 409);
  assert.match(invented.message, /not eligible for every remaining walk window/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking replacement assignment moves only the remaining walks", async () => {
  const { db, booking, done } = await brokenBooking({ bookingId: "BKG-WALK-ASSIGN" });

  const noReason = await refusal(opsAct(db, booking, "assign_replacement", { providerId: REPLACEMENT, reason: "x" }));
  assert.equal(noReason?.status, 400);
  assert.match(noReason.message, /Replacement walker and assignment reason are required/);

  const assigned = await opsAct(db, booking, "assign_replacement", {
    providerId: REPLACEMENT, reason: "Nearest eligible walker for the remaining walk",
  });
  assert.equal(assigned.status, "replacement_offered");
  assert.equal(assigned.replacementProviderId, REPLACEMENT);
  assert.equal(assigned.remainingSessions, 1, "only the outstanding walk is reassigned");
  assert.equal(assigned.bookingPreserved, true);
  assert.equal(assigned.completedSessionsPreserved, true);
  assert.ok(assigned.offer.expiresAt > Date.now(), "the replacement gets a time-boxed offer, not a silent assignment");

  // The booking is OFFERED, not yet assigned: the replacement has not accepted.
  const bookingRow = await db.prepare("SELECT status,provider_id FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first();
  assert.equal(bookingRow.status, "reassignment_offered");
  assert.equal(bookingRow.provider_id, REPLACEMENT);
  assert.equal((await db.prepare("SELECT status,provider_id FROM provider_work_orders WHERE booking_id=?").bind(booking.bookingId).first()).status, "reassignment_offered");
  assert.equal((await db.prepare("SELECT status FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first()).status, "replacement_offered");

  // The completed walk keeps its walker and its history; only the pending walk moves.
  const completed = await db.prepare("SELECT provider_id,status FROM walking_sessions WHERE id=?").bind(done).first();
  assert.equal(completed.provider_id, ORIGINAL, "history is not rewritten onto the replacement");
  assert.equal(completed.status, "completed");
  const moved = await db.prepare("SELECT provider_id,status,handover_status FROM walking_sessions WHERE id=?").bind(booking.sessions[1].sessionId).first();
  assert.equal(moved.provider_id, REPLACEMENT);
  assert.equal(moved.status, "scheduled");
  assert.equal(moved.handover_status, "pending", "a new walker starts the handover afresh");
  assert.equal((await db.prepare("SELECT provider_id,status FROM scheduling_reservations WHERE id=?").bind(booking.sessions[1].reservationId).first()).provider_id, REPLACEMENT);

  // The customer is told the booking survived.
  const notes = await db.prepare("SELECT message FROM walking_customer_notifications WHERE booking_id=? AND template_code='walking_recovery_update'").bind(booking.bookingId).all();
  assert.equal(notes.results.length, 2, "push and whatsapp");
  assert.match(notes.results[0].message, /Completed walks, booking ID and paid history are unchanged/);

  // Assignment only applies to a recovery-pending booking.
  const twice = await refusal(opsAct(db, booking, "assign_replacement", { providerId: REPLACEMENT, reason: "Offering all over again" }));
  assert.equal(twice?.status, 409);
  assert.match(twice.message, /requires a recovery-pending Dog Walking booking/);
});

// ---------------------------------------------------------------------------------------------
test("Replacement walker acceptance verifies booking, work order, offer, sessions and reservations", async () => {
  const { db, booking, done } = await brokenBooking({ bookingId: "BKG-WALK-ACCEPT" });
  await opsAct(db, booking, "assign_replacement", { providerId: REPLACEMENT, reason: "Eligible replacement walker" });

  const accept = (providerId, extra = {}) => recovery.acceptWalkingReplacement(db, {
    bookingId: booking.bookingId, providerId, actorId: providerId, idempotencyKey: nextKey(), ...extra,
  });

  // Nobody else can accept the offer.
  const impostor = await refusal(accept("walk_kiran"));
  assert.equal(impostor?.status, 409);
  assert.match(impostor.message, /does not match the canonical booking\/work order/);

  // An expired offer sends it back to Operations rather than quietly assigning.
  await db.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").bind(Date.now() - 1000, booking.groupId).run();
  const late = await refusal(accept(REPLACEMENT));
  assert.equal(late?.status, 409);
  assert.match(late.message, /acceptance offer expired; Operations recovery is required/);
  await db.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").bind(Date.now() + 600_000, booking.groupId).run();

  // A remaining session that drifted onto somebody else blocks acceptance outright.
  await db.prepare("UPDATE walking_sessions SET provider_id='walk_kiran' WHERE id=?").bind(booking.sessions[1].sessionId).run();
  const inconsistent = await refusal(accept(REPLACEMENT));
  assert.equal(inconsistent?.status, 409);
  assert.match(inconsistent.message, /not consistently assigned to the replacement walker/);
  await db.prepare("UPDATE walking_sessions SET provider_id=? WHERE id=?").bind(REPLACEMENT, booking.sessions[1].sessionId).run();

  // A reservation that disagrees with the sessions blocks it too.
  await db.prepare("UPDATE scheduling_reservations SET provider_id='walk_kiran' WHERE id=?").bind(booking.sessions[1].reservationId).run();
  const reservationDrift = await refusal(accept(REPLACEMENT));
  assert.equal(reservationDrift?.status, 409);
  assert.match(reservationDrift.message, /inconsistent with future scheduling reservations/);
  await db.prepare("UPDATE scheduling_reservations SET provider_id=? WHERE id=?").bind(REPLACEMENT, booking.sessions[1].reservationId).run();

  const key = nextKey();
  const accepted = await recovery.acceptWalkingReplacement(db, {
    bookingId: booking.bookingId, providerId: REPLACEMENT, actorId: REPLACEMENT, idempotencyKey: key,
  });
  assert.equal(accepted.status, "assigned");
  assert.equal(accepted.remainingSessions, 1);
  assert.equal(accepted.bookingPreserved, true);
  assert.equal(accepted.completedSessionsPreserved, true);

  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "assigned");
  assert.equal((await db.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").bind(booking.bookingId).first()).status, "accepted");
  assert.equal((await db.prepare("SELECT status FROM provider_assignment_offers WHERE group_id=?").bind(booking.groupId).first()).status, "accepted");
  assert.equal((await db.prepare("SELECT status FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first()).status, "replacement_accepted");
  assert.equal((await db.prepare("SELECT status,provider_id FROM walking_sessions WHERE id=?").bind(done).first()).provider_id, ORIGINAL);

  const replay = await recovery.acceptWalkingReplacement(db, {
    bookingId: booking.bookingId, providerId: REPLACEMENT, actorId: REPLACEMENT, idempotencyKey: key,
  });
  assert.equal(replay.duplicatePrevented, true);

  // Accepting an offer that is no longer open is refused.
  const again = await refusal(accept(REPLACEMENT));
  assert.equal(again?.status, 409);
  assert.match(again.message, /not awaiting replacement walker acceptance/);
});

// ---------------------------------------------------------------------------------------------
test("Operations cannot close recovery before replacement acceptance", async () => {
  const { db, booking, done } = await brokenBooking({ bookingId: "BKG-WALK-CLOSE" });

  const beforeOffer = await refusal(opsAct(db, booking, "close_recovery", { reason: "Calling it done early" }));
  assert.equal(beforeOffer?.status, 409);
  assert.match(beforeOffer.message, /Replacement walker must accept before Operations can close recovery/);

  await opsAct(db, booking, "assign_replacement", { providerId: REPLACEMENT, reason: "Eligible replacement walker" });
  const afterOffer = await refusal(opsAct(db, booking, "close_recovery", { reason: "Offer sent, close it" }));
  assert.equal(afterOffer?.status, 409);
  assert.match(afterOffer.message, /must accept before Operations can close recovery/);
  assert.equal(
    (await db.prepare("SELECT status FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first()).status,
    "replacement_offered",
    "a refused closure leaves the case open",
  );

  await recovery.acceptWalkingReplacement(db, {
    bookingId: booking.bookingId, providerId: REPLACEMENT, actorId: REPLACEMENT, idempotencyKey: nextKey(),
  });

  const thin = await refusal(opsAct(db, booking, "close_recovery", { reason: "ok" }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /recovery closure reason is required/);

  const closed = await opsAct(db, booking, "close_recovery", { reason: "Replacement walker confirmed for the remaining walk" });
  assert.equal(closed.status, "resolved");
  assert.equal(closed.replacementProviderId, REPLACEMENT);
  assert.equal(closed.bookingPreserved, true);

  const caseRow = await db.prepare("SELECT status,resolved_at,detail_json FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(caseRow.status, "resolved");
  assert.ok(Number(caseRow.resolved_at) > 0);
  const detail = JSON.parse(caseRow.detail_json);
  assert.equal(detail.closedBy, OPS_STAFF);
  assert.equal(detail.completedSessionsPreserved, true);

  // The completed walk and its payment survived the whole recovery.
  assert.equal((await db.prepare("SELECT status FROM walking_sessions WHERE id=?").bind(done).first()).status, "completed");
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_session_payment_events WHERE session_id=?").bind(done).first()).n), 1);

  // The queue no longer flags this booking for recovery.
  const snapshot = await ops.getWalkingOpsSnapshot(db);
  const entry = snapshot.bookings.find((row) => row.id === booking.bookingId);
  assert.ok(!entry.exceptionFlags.includes("walker_recovery"), "a resolved recovery leaves the recovery queue");

  const twice = await refusal(opsAct(db, booking, "close_recovery", { reason: "Closing it a second time" }));
  assert.equal(twice?.status, 409);
  // Once resolved, the case is no longer in 'replacement_accepted', so the consolidated close-recovery
  // guard refuses with the standard "must accept" message (the old "No accepted…" branch was removed when
  // close_recovery was reworked to also close in in_progress/completed states).
  assert.match(twice.message, /Replacement walker must accept before Operations can close recovery/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Operations notes are canonical, bounded and replay safe", async () => {
  const { db, booking } = await opsWorld({ bookingId: "BKG-WALK-NOTE", walkCount: 1 });

  const thin = await refusal(opsAct(db, booking, "add_note", { note: "hmm" }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /meaningful Operations note is required/);

  const key = nextKey();
  const noted = await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "add_note", actorId: OPS_STAFF, idempotencyKey: key,
    note: "Customer called about the gate code",
  });
  assert.equal(noted.status, "noted");

  const replay = await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "add_note", actorId: OPS_STAFF, idempotencyKey: key,
    note: "Customer called about the gate code",
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.noteId, noted.noteId);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_ops_notes WHERE booking_id=?").bind(booking.bookingId).first()).n),
    1,
    "a replayed note is written once",
  );

  const snapshot = await ops.getWalkingOpsSnapshot(db);
  const entry = snapshot.bookings.find((row) => row.id === booking.bookingId);
  assert.equal(entry.notes.length, 1);
  assert.equal(entry.notes[0].actor_id, OPS_STAFF);

  const unsupported = await refusal(opsAct(db, booking, "delete_booking", {}));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Dog Walking Operations action/);

  const missing = await refusal(ops.mutateWalkingOps(db, {
    bookingId: "BKG-NOPE", action: "add_note", actorId: OPS_STAFF, idempotencyKey: nextKey(), note: "Nothing here",
  }));
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /Canonical Dog Walking booking not found/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 5 is engineering closed but explicitly not production ready", async () => {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALK_G5_DB__ = db;
  globalThis.__WALK_G5_ENV__ = {};

  // A cold database — no booking module has ever run — reports an honestly empty queue rather than
  // a 500, and still tells the truth about readiness.
  const cold = await ops.getWalkingOpsSnapshot(db);
  assert.deepEqual(cold.bookings, []);
  assert.equal(cold.metrics.total, 0);
  assert.equal(cold.readiness.productionReady, false);
  assert.equal(cold.readiness.routeEvidence, "sandbox_unverified");
  assert.equal(cold.readiness.finance, "sandbox_governed");
  assert.equal(cold.readiness.proof, "private_scan_gated_contract");
  for (const value of Object.values(cold.readiness.externalDependencies)) {
    assert.notEqual(value, "connected", "no external dependency is ever reported as connected");
    assert.notEqual(value, "live");
  }
});
