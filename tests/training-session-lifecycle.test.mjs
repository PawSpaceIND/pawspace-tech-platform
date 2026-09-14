/*
 * Training session lifecycle (Gate 2), executed against a real database.
 *
 * This file used to grep lib/training-session-lifecycle.ts for `INSERT OR IGNORE INTO
 * training_session_consumptions`, for the action names and for refusal strings, and grep the route
 * for `requireProviderOwnership`. None of that could tell whether a session is consumed once or twice,
 * whether a stranger's trainer session is refused, or whether a completion without evidence goes
 * through. Every case below drives the REAL lifecycle module or route handler and reads the rows back.
 *
 * Sabotage-verified: dropping the `INSERT OR IGNORE` (double consumption), the evidence gate, the
 * geofence, the staff-only guard on cancel_session or the provider-ownership check in the route each
 * turns a case here red while the old regexes would have stayed green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, seedBooking, seedRoster, seedAsset, seedEvidence, completeSession, sessionCookie, routeCall,
  TRAINER, OTHER_TRAINER, CUSTOMER, DOORSTEP, FAR_AWAY, REPORT, sessionDate, trainer,
} from "./helpers/training-lifecycle-harness.mjs";

const { materializeTrainingProgramme } = await import("../lib/training-programme.ts");
const { mutateTrainingSession, getTrainingSession, listTrainerSessions, TRAINING_ARRIVAL_GEOFENCE_METERS } = await import("../lib/training-session-lifecycle.ts");
const sessionsRoute = await import("../app/api/training-sessions/route.ts");
const mediaRoute = await import("../app/api/training-session-media/route.ts");

const refusal = async (promise, status, pattern) => {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof Response, `expected a Response refusal, got ${caught?.constructor?.name ?? typeof caught}`);
  assert.equal(caught.status, status, `unexpected status for ${pattern}`);
  const text = await caught.text();
  assert.match(text, pattern);
  return text;
};

async function programme(world, opts = {}) {
  const booking = seedBooking(world, { id: "B1", group: "G1", sessions: 3, ...opts });
  const { sessions } = await materializeTrainingProgramme(world.db, { bookingId: booking.id, actorId: "uat" });
  return { booking, sessions };
}

const act = (world, session, action, key, extra = {}) =>
  mutateTrainingSession(world.db, { sessionId: session.id, action, actorId: trainer(session.provider_id), idempotencyKey: key, ...extra });

// --- state machine + exactly-once consumption --------------------------------------------------

test("Training Gate 2 owns each trainer session and consumes completion exactly once", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world);
  const s1 = sessions[0];
  const consumed = () => world.sqlite.prepare("SELECT COUNT(*) n FROM training_session_consumptions WHERE session_id=?").get(s1.id).n;

  // Out-of-order actions are refused by state, not by convention.
  await refusal(act(world, s1, "on_the_way", "k-early-otw"), 409, /Training session cannot on_the_way from scheduled/);
  await refusal(act(world, s1, "complete", "k-early-complete"), 409, /Training session cannot complete from scheduled/);
  assert.equal(await act(world, s1, "accept", "k-accept").then((r) => r.status), "accepted");
  assert.equal(await act(world, s1, "on_the_way", "k-otw").then((r) => r.status), "on_the_way");
  const arrived = await act(world, s1, "arrive", "k-arrive", DOORSTEP);
  assert.equal(arrived.status, "arrived");
  assert.equal(arrived.geofence.thresholdMeters, TRAINING_ARRIVAL_GEOFENCE_METERS);
  assert.equal(await act(world, s1, "start", "k-start").then((r) => r.status), "in_session");
  assert.equal((await getTrainingSession(world.db, s1.id)).status, "in_session");

  await refusal(act(world, s1, "owner_handover", "k-handover-short", { ownerHandoverMinutes: 10 }), 409, /at least 15 minutes/);
  await act(world, s1, "owner_handover", "k-handover", { ownerHandoverMinutes: 20 });
  const refs = seedEvidence(world, "MA-1", s1);
  const done = await act(world, s1, "complete", "k-complete", { report: { ...REPORT, evidenceRefs: refs } });
  assert.equal(done.status, "completed");
  assert.equal(done.consumedExactlyOnce, true);
  assert.equal(consumed(), 1, "completion consumes the session once");
  assert.equal(world.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id=?").get(s1.schedule_reservation_id).status, "completed");
  assert.equal(done.nextSession.sequenceNo, 2, "completing session 1 unlocks session 2");
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(sessions[1].id).status, "scheduled");

  // Idempotency: the same key replays without a second write; a reused key for another action is refused.
  const replay = await act(world, s1, "complete", "k-complete");
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(consumed(), 1, "a replayed completion never double-consumes");
  await refusal(act(world, sessions[1], "accept", "k-complete"), 409, /identifies one action on one record/);
  assert.throws(
    () => world.sqlite.prepare("INSERT INTO training_session_events (id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,created_at) VALUES ('EV-DUP',?,?,?,'accept','x','k-complete',?)").run(s1.id, s1.programme_id, s1.booking_id, Date.now()),
    /UNIQUE constraint failed: training_session_events\.idempotency_key/,
    "the ledger itself refuses a second event under one key",
  );
  // A completed session cannot be completed, started or accepted again through any path.
  await refusal(act(world, s1, "complete", "k-complete-again", { report: { ...REPORT, evidenceRefs: refs } }), 409, /cannot complete from completed/);
  await refusal(act(world, s1, "accept", "k-accept-again"), 409, /cannot accept from completed/);
  assert.equal(consumed(), 1);
  const consumption = world.sqlite.prepare("SELECT actor_id,consumed_at FROM training_session_consumptions WHERE session_id=?").get(s1.id);
  assert.equal(consumption.actor_id, trainer(TRAINER));
});

test("ARRIVE is geofenced to the customer doorstep", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world);
  const s1 = sessions[0];
  await act(world, s1, "accept", "g-accept");
  await act(world, s1, "on_the_way", "g-otw");
  await refusal(act(world, s1, "arrive", "g-arrive-blind"), 409, /ARRIVED requires provider latitude and longitude/);
  const far = await refusal(act(world, s1, "arrive", "g-arrive-far", FAR_AWAY), 409, /ARRIVED requires <=250m/);
  assert.match(far, /Trainer is \d+m from the customer doorstep/);
  assert.equal((await getTrainingSession(world.db, s1.id)).status, "on_the_way", "a refused arrival leaves the session on the way");
  const near = await act(world, s1, "arrive", "g-arrive", { latitude: DOORSTEP.latitude + 0.0005, longitude: DOORSTEP.longitude });
  assert.equal(near.status, "arrived");
  assert.ok(near.geofence.distanceMeters > 0 && near.geofence.distanceMeters <= 250, `inside the geofence: ${near.geofence.distanceMeters}m`);
});

// --- completion requirements ---------------------------------------------------------------------

test("Training completion requires attendance, homework, progress and exact-session secure media", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world);
  const s1 = sessions[0];
  const consumed = () => world.sqlite.prepare("SELECT COUNT(*) n FROM training_session_consumptions").get().n;
  for (const [action, extra] of [["accept", {}], ["on_the_way", {}], ["arrive", DOORSTEP], ["start", {}]]) await act(world, s1, action, `c-${action}`, extra);

  await refusal(act(world, s1, "complete", "c-no-handover", { report: { ...REPORT, evidenceRefs: [] } }), 409, /mandatory 15-minute Owner Handover/);
  await act(world, s1, "owner_handover", "c-handover", { ownerHandoverMinutes: 15 });
  const refs = seedEvidence(world, "MA-OK", s1);
  const attempt = (key, report) => act(world, s1, "complete", key, { report });

  await refusal(attempt("c-mode", { ...REPORT, attendance: { mode: "remote", safeAreaConfirmed: true }, evidenceRefs: refs }), 409, /Attendance mode must be parent or trainer_led/);
  await refusal(attempt("c-safe", { ...REPORT, attendance: { mode: "parent", safeAreaConfirmed: false, parentOrCaretakerConfirmed: true }, evidenceRefs: refs }), 409, /Safe training area confirmation is required/);
  await refusal(attempt("c-parent", { ...REPORT, attendance: { mode: "parent", safeAreaConfirmed: true }, evidenceRefs: refs }), 409, /Parent\/caretaker attendance confirmation is required/);
  await refusal(attempt("c-homework", { ...REPORT, homework: "sit", evidenceRefs: refs }), 409, /Meaningful homework is required before completion/);
  await refusal(attempt("c-progress", { ...REPORT, progress: { obedience: 11 }, evidenceRefs: refs }), 409, /At least one 1-10 progress score is required/);
  await refusal(attempt("c-no-evidence", { ...REPORT, evidenceRefs: [] }), 409, /At least one secure Training evidence asset is required/);
  await refusal(attempt("c-bad-ref", { ...REPORT, evidenceRefs: ["uat://asset/MA-OK-B", refs[1]] }), 409, /canonical media:\/\/asset reference/);
  await refusal(attempt("c-ghost", { ...REPORT, evidenceRefs: ["media://asset/GHOST", refs[1]] }), 409, /not clean, ready, active, non-synthetic proof linked to this exact Training session\/trainer/);

  // Evidence that is real but WRONG: another session's, unscanned, synthetic, or only half the pair.
  seedAsset(world, "MA-OTHER-B", "before_service", sessions[1]);
  await refusal(attempt("c-other-session", { ...REPORT, evidenceRefs: ["media://asset/MA-OTHER-B", refs[1]] }), 409, /this exact Training session/);
  seedAsset(world, "MA-DIRTY", "before_service", s1, { scan: "pending" });
  await refusal(attempt("c-unscanned", { ...REPORT, evidenceRefs: ["media://asset/MA-DIRTY", refs[1]] }), 409, /not clean, ready, active, non-synthetic/);
  seedAsset(world, "MA-SYNTH", "before_service", s1, { synthetic: 1 });
  await refusal(attempt("c-synthetic", { ...REPORT, evidenceRefs: ["media://asset/MA-SYNTH", refs[1]] }), 409, /non-synthetic/);
  await refusal(attempt("c-half", { ...REPORT, evidenceRefs: [refs[0]] }), 409, /Before Picture \+ After Picture are required/);
  assert.equal(consumed(), 0, "no refused completion consumed anything");
  assert.equal((await getTrainingSession(world.db, s1.id)).status, "in_session");

  const done = await attempt("c-done", { ...REPORT, evidenceRefs: refs });
  assert.equal(done.status, "completed");
  assert.equal(consumed(), 1);
  const stored = world.sqlite.prepare("SELECT attendance_json,homework_json,progress_json,evidence_json FROM training_sessions WHERE id=?").get(s1.id);
  assert.deepEqual(JSON.parse(stored.evidence_json), refs);
  assert.equal(JSON.parse(stored.homework_json).text, REPORT.homework);
  assert.equal(JSON.parse(stored.attendance_json).mode, "parent");
});

test("the final session stays blocked until the remaining balance is paid", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world, { sessions: 2, total: 8000, dueNow: 4000 });
  await completeSession(world, sessions[0], "f1");
  const last = sessions[1];
  for (const [action, extra] of [["accept", {}], ["on_the_way", {}], ["arrive", DOORSTEP], ["start", {}], ["owner_handover", { ownerHandoverMinutes: 15 }]]) await act(world, last, action, `f2-${action}`, extra);
  const refs = seedEvidence(world, "MA-F2", last);
  await refusal(act(world, last, "complete", "f2-complete-unpaid", { report: { ...REPORT, evidenceRefs: refs } }), 409, /blocked until the remaining balance is paid; current state PARTIALLY_PAID/);
  world.sqlite.prepare("UPDATE training_quote_payment_attestations SET status='FULLY_PAID',amount=8000 WHERE quote_id='TQ-B1'").run();
  const done = await act(world, last, "complete", "f2-complete", { report: { ...REPORT, evidenceRefs: refs } });
  assert.equal(done.status, "completed");
  assert.equal(done.programme.status, "completed");
  assert.ok(done.closure.certificateNumber.startsWith("PS-TRN-"), "a fully delivered programme issues its certificate");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_customer_notifications WHERE booking_id='B1'").get().n, 2);
});

// --- recovery ------------------------------------------------------------------------------------

test("Training recovery preserves paid-session integrity", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world, { sessions: 4 });
  const [s1, s2, s3, s4] = sessions;
  const cases = (sessionId) => world.sqlite.prepare("SELECT recovery_type,status,detail_json FROM training_session_recovery_cases WHERE session_id=? ORDER BY created_at, rowid").all(sessionId);
  const consumed = () => world.sqlite.prepare("SELECT COUNT(*) n FROM training_session_consumptions").get().n;

  await completeSession(world, s1, "r1");
  assert.equal(consumed(), 1);

  // Provider-side reschedule request opens a case and leaves consumption alone.
  await refusal(act(world, s2, "request_reschedule", "r2-short", { reason: "busy" }), 400, /clear reason/);
  const requested = await act(world, s2, "request_reschedule", "r2-req", { reason: "Trainer has a medical appointment" });
  assert.equal(requested.status, "reschedule_requested");
  assert.deepEqual(cases(s2.id).map((c) => [c.recovery_type, c.status]), [["reschedule", "open"]]);

  // Staff-only actions are refused without staff permission, and refused with an explicit reason.
  await refusal(act(world, s2, "reschedule", "r2-provider-resched", { newStart: s2.scheduled_start, newEnd: s2.scheduled_end }), 403, /requires staff booking permission/);
  await refusal(act(world, s2, "replace_provider", "r2-provider-replace", { newProviderId: OTHER_TRAINER, reason: "Trainer asked to swap" }), 403, /requires staff booking permission/);
  await refusal(act(world, s3, "cancel_session", "r3-provider-cancel", { reason: "Trainer wants this gone" }), 403, /requires staff booking permission/);

  // A replacement must be a live dog_training provider covering the zone.
  await refusal(act(world, s2, "replace_provider", "r2-groomer", { staffOverride: true, newProviderId: "groom_arun", reason: "Original trainer unavailable" }), 409, /Replacement trainer is not eligible for this Training session/);
  await refusal(act(world, s2, "replace_provider", "r2-ghost", { staffOverride: true, newProviderId: "train_nobody", reason: "Original trainer unavailable" }), 409, /Replacement trainer is not eligible/);
  // Eligible but unrostered: the roster is authoritative for whether the replacement works this window.
  await refusal(act(world, s2, "replace_provider", "r2-unrostered", { staffOverride: true, newProviderId: OTHER_TRAINER, reason: "Original trainer unavailable" }), 409, /no roster availability/);
  seedRoster(world, OTHER_TRAINER, sessionDate(1));
  const replaced = await act(world, s2, "replace_provider", "r2-replace", { staffOverride: true, newProviderId: OTHER_TRAINER, reason: "Original trainer unavailable" });
  assert.equal(replaced.providerId, OTHER_TRAINER);
  assert.equal(world.sqlite.prepare("SELECT provider_id,status FROM training_sessions WHERE id=?").get(s2.id).provider_id, OTHER_TRAINER);
  assert.equal(world.sqlite.prepare("SELECT provider_id FROM scheduling_reservations WHERE id=?").get(s2.schedule_reservation_id).provider_id, OTHER_TRAINER);
  assert.deepEqual(cases(s2.id).map((c) => [c.recovery_type, c.status]), [["reschedule", "open"], ["replacement", "resolved"]]);

  // No-show: a session still locked behind its predecessor cannot be written off at all; providers must
  // wait out the grace period on a live one; staff record it now, and it never auto-consumes.
  await refusal(act(world, s3, "no_show", "r3-locked", { reason: "Customer absent at start" }), 409, /cannot no_show from locked/);
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(s3.id).status, "locked", "session 3 is still gated behind session 2");
  await refusal(act(world, s2, "no_show", "r2-early", { reason: "Customer absent at start" }), 409, /after the session start grace period/);
  const noShow = await mutateTrainingSession(world.db, { sessionId: s2.id, action: "no_show", actorId: "ops:staff", idempotencyKey: "r2-noshow", reason: "Customer absent at start", staffOverride: true });
  assert.equal(noShow.status, "no_show");
  assert.equal(noShow.consumption, "pending_policy");
  assert.equal(noShow.nextSession.sessionId, s3.id, "writing off session 2 unlocks session 3");
  const s2Cases = cases(s2.id);
  assert.deepEqual(s2Cases.map((c) => [c.recovery_type, c.status]), [["reschedule", "open"], ["replacement", "resolved"], ["no_show", "open"]]);
  assert.equal(JSON.parse(s2Cases[2].detail_json).consumption, "pending_policy");
  assert.equal(world.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id=?").get(s2.schedule_reservation_id).status, "no_show");
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(s3.id).status, "scheduled");

  // Staff cancellation of a still-locked session releases capacity and records not_consumed.
  const cancelled = await mutateTrainingSession(world.db, { sessionId: s4.id, action: "cancel_session", actorId: "ops:staff", idempotencyKey: "r4-cancel", reason: "Programme shortened by agreement", staffOverride: true });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(JSON.parse(cases(s4.id)[0].detail_json).consumption, "not_consumed");
  assert.equal(world.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id=?").get(s4.schedule_reservation_id).status, "cancelled");

  // Through all of it the one paid, completed session stays consumed exactly once and untouched.
  assert.equal(consumed(), 1);
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(s1.id).status, "completed");
  const programmeRow = world.sqlite.prepare("SELECT status,completed_sessions,no_show_sessions,cancelled_sessions FROM training_programmes").get();
  assert.deepEqual({ ...programmeRow }, { status: "in_progress", completed_sessions: 1, no_show_sessions: 1, cancelled_sessions: 1 });
});

// --- routes: ownership and staff actions ---------------------------------------------------------

test("the trainer session route is provider-owned and reserves staff actions for bookings.manage", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world);
  const s1 = sessions[0];
  const owner = await sessionCookie(world.db, "provider", TRAINER);
  const stranger = await sessionCookie(world.db, "provider", OTHER_TRAINER);
  const customer = await sessionCookie(world.db, "customer", CUSTOMER);

  const list = await routeCall(sessionsRoute.GET, "GET", `/api/training-sessions?providerId=${TRAINER}`, { cookie: owner });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.length, 3);
  const serialized = JSON.stringify(list.body);
  for (const secret of ["+91-9000000001", "cus_t1@example.test", "customer_phone", "customer_email", "Trisha Kumar"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not reach the trainer`);
  }
  assert.equal((await routeCall(sessionsRoute.GET, "GET", `/api/training-sessions?providerId=${TRAINER}`, { cookie: stranger })).status, 403, "another trainer cannot read this roster");
  assert.equal((await routeCall(sessionsRoute.GET, "GET", `/api/training-sessions?providerId=${TRAINER}`, { cookie: customer })).status, 403, "a customer session is not a provider");
  assert.equal((await routeCall(sessionsRoute.GET, "GET", "/api/training-sessions", { cookie: owner })).status, 400);

  const foreign = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: s1.id, action: "accept", idempotencyKey: "rt-foreign" }, cookie: stranger });
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(s1.id).status, "scheduled", "a refused stranger changed nothing");
  const accepted = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: s1.id, action: "accept", idempotencyKey: "rt-accept" }, cookie: owner });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.status, "accepted");
  const replay = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: s1.id, action: "accept", idempotencyKey: "rt-accept" }, cookie: owner });
  assert.equal(replay.body.data.duplicatePrevented, true);

  // Staff actions: refused for the provider that owns the session, honoured for Ops.
  const providerCancel = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: sessions[2].id, action: "cancel_session", idempotencyKey: "rt-cancel-provider", reason: "Trainer wants this gone" }, cookie: owner });
  assert.equal(providerCancel.status, 403, JSON.stringify(providerCancel.body));
  const staffCancel = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: sessions[2].id, action: "cancel_session", idempotencyKey: "rt-cancel-staff", reason: "Programme shortened by agreement" }, preview: true });
  assert.equal(staffCancel.status, 200, JSON.stringify(staffCancel.body));
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(sessions[2].id).status, "cancelled");
  const missing = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: "TS-NOPE", action: "accept", idempotencyKey: "rt-missing" }, cookie: owner });
  assert.equal(missing.status, 404);
  const audits = world.sqlite.prepare("SELECT action,outcome FROM security_audit_events WHERE resource_id=? ORDER BY id").all(s1.id);
  assert.deepEqual(audits.map((row) => row.action), ["training.session.accept", "training.session.accept"], "the accept and its replay are audited under the session");
});

test("Training session media is provider-owned, deduplicated by checksum and never a raw uat:// reference", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world);
  const s1 = sessions[0];
  const owner = await sessionCookie(world.db, "provider", TRAINER);
  const stranger = await sessionCookie(world.db, "provider", OTHER_TRAINER);
  const sha256 = "a".repeat(64);
  const register = { sessionId: s1.id, mimeType: "image/jpeg", sizeBytes: 2048, sha256, fileName: "before.jpg" };

  assert.equal((await routeCall(mediaRoute.POST, "POST", "/api/training-session-media", { body: register, cookie: stranger })).status, 403, "another trainer cannot attach evidence to this session");
  const prepared = await routeCall(mediaRoute.POST, "POST", "/api/training-session-media", { body: register, cookie: owner });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  const { id, ref, upload } = prepared.body.data;
  assert.equal(ref, `media://asset/${id}`);
  assert.equal(prepared.body.data.proofReady, false);
  assert.equal(prepared.body.data.synthetic, false);
  assert.ok(upload.token && upload.objectKey, "a signed single-use upload grant is issued");
  assert.equal(upload.rawPublicUrl, false);
  const duplicate = await routeCall(mediaRoute.POST, "POST", "/api/training-session-media", { body: register, cookie: owner });
  assert.equal(duplicate.status, 200);
  assert.deepEqual({ id: duplicate.body.data.id, duplicatePrevented: duplicate.body.data.duplicatePrevented }, { id, duplicatePrevented: true });
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_session_media_links WHERE session_id=?").get(s1.id).n, 1);
  const link = world.sqlite.prepare("SELECT provider_id,booking_id,programme_id FROM training_session_media_links WHERE media_id=?").get(id);
  assert.deepEqual({ ...link }, { provider_id: TRAINER, booking_id: s1.booking_id, programme_id: s1.programme_id });

  const listed = await routeCall(mediaRoute.GET, "GET", `/api/training-session-media?sessionId=${s1.id}`, { cookie: owner });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.assets.length, 1);
  assert.equal(listed.body.data.assets[0].proofReady, false, "an asset is not proof until it is uploaded, reviewed and released");
  assert.doesNotMatch(JSON.stringify(listed.body), /uat:\/\//);
  assert.equal((await routeCall(mediaRoute.GET, "GET", `/api/training-session-media?sessionId=${s1.id}`, { cookie: stranger })).status, 403);

  // Confirmation is bound to the grant: the wrong checksum is refused, the right one quarantines for review.
  const wrong = await routeCall(mediaRoute.PATCH, "PATCH", "/api/training-session-media", { body: { id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey, observedSizeBytes: 2048, observedSha256: "b".repeat(64), observedMimeType: "image/jpeg" }, cookie: owner });
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
  const confirmed = await routeCall(mediaRoute.PATCH, "PATCH", "/api/training-session-media", { body: { id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey, observedSizeBytes: 2048, observedSha256: sha256, observedMimeType: "image/jpeg" }, cookie: owner });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.accessStatus, "quarantined");
  assert.equal(confirmed.body.data.proofReady, false);
  const reused = await routeCall(mediaRoute.PATCH, "PATCH", "/api/training-session-media", { body: { id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey, observedSizeBytes: 2048, observedSha256: sha256, observedMimeType: "image/jpeg" }, cookie: owner });
  assert.equal(reused.status, 409, "an upload token is single-use");
  // Review is a staff decision by a second person; the uploader cannot approve their own evidence.
  const selfReview = await routeCall(mediaRoute.PATCH, "PATCH", "/api/training-session-media", { body: { id, action: "record_review", decision: "approved", reason: "Looks fine to me" }, cookie: owner });
  assert.equal(selfReview.status, 403, JSON.stringify(selfReview.body));
  const reviewed = await routeCall(mediaRoute.PATCH, "PATCH", "/api/training-session-media", { body: { id, action: "record_review", decision: "approved", reason: "Clear before picture of the dog" }, preview: true });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.data.reviewStatus, "approved");
  const asset = world.sqlite.prepare("SELECT review_status,access_status,synthetic FROM service_media_assets WHERE id=?").get(id);
  assert.equal(asset.review_status, "approved");
  assert.equal(asset.synthetic, 0);

  // Evidence cannot be added once the session has closed.
  world.sqlite.prepare("UPDATE training_sessions SET status='completed' WHERE id=?").run(s1.id);
  const late = await routeCall(mediaRoute.POST, "POST", "/api/training-session-media", { body: { ...register, sha256: "c".repeat(64) }, cookie: owner });
  assert.equal(late.status, 409);
});

// --- trainer workspace client --------------------------------------------------------------------

test("the trainer workspace is driven by the canonical session, media and identity routes with per-action idempotency", async () => {
  const client = await import("../lib/training-session-client.ts");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", credentials: init.credentials, body: init.body ? JSON.parse(String(init.body)) : null });
    const path = String(url);
    if (path.startsWith("/api/identity-session")) return Response.json({ data: { subjectType: "provider", subjectId: TRAINER, roleCode: "service_provider", expiresAt: Date.now() + 60_000 } });
    if (path.startsWith("/api/training-sessions?")) return Response.json({ data: [{ id: "TS-1", status: "scheduled" }] });
    if (path === "/api/training-sessions") return Response.json({ data: { status: "accepted" } });
    if (path.startsWith("/api/training-session-media?")) return Response.json({ data: { sessionId: "TS-1", assets: [] } });
    return Response.json({ error: "Unable to update Training session" }, { status: 409 });
  };
  try {
    const identity = await client.currentProviderIdentity();
    assert.equal(identity.subjectId, TRAINER);
    assert.equal(calls[0].url, "/api/identity-session");
    assert.equal(calls[0].credentials, "include", "the identity call carries the session cookie");
    const sessions = await client.loadTrainerSessions("train kiran");
    assert.equal(sessions.length, 1);
    assert.equal(calls[1].url, "/api/training-sessions?providerId=train%20kiran");
    await client.trainingSessionAction({ sessionId: "TS-1", action: "accept" });
    await client.trainingSessionAction({ sessionId: "TS-1", action: "accept" });
    assert.equal(calls[2].method, "POST");
    assert.equal(calls[2].body.action, "accept");
    assert.match(calls[2].body.idempotencyKey, /^training:TS-1:accept:[0-9a-f-]{36}$/, "every action carries its own idempotency key");
    assert.notEqual(calls[2].body.idempotencyKey, calls[3].body.idempotencyKey, "two taps are two keys, so the server decides what is a replay");
    await client.loadTrainingEvidence("TS-1");
    assert.equal(calls[4].url, "/api/training-session-media?sessionId=TS-1");
    globalThis.fetch = async () => Response.json({ error: "Training session cannot complete from scheduled" }, { status: 409 });
    await assert.rejects(client.trainingSessionAction({ sessionId: "TS-1", action: "complete" }), /Training session cannot complete from scheduled/, "the server's refusal reaches the trainer verbatim");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trainer earnings are canonical and never a live payout", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world, { sessions: 2 });
  await completeSession(world, sessions[0], "e1");
  const { saveTrainingCompensationRule } = await import("../lib/training-finance.ts");
  await saveTrainingCompensationRule(world.db, { cityId: "blr", rateValue: 700, effectiveFrom: "2026-08-01", reason: "trainer per-session compensation", actorId: "finance:uat" });
  const earningsRoute = await import("../app/api/training-provider-earnings/route.ts");
  const owner = await sessionCookie(world.db, "provider", TRAINER);
  const stranger = await sessionCookie(world.db, "provider", OTHER_TRAINER);
  const res = await routeCall(earningsRoute.GET, "GET", `/api/training-provider-earnings?providerId=${TRAINER}`, { cookie: owner });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.livePayout, false, "Live payout is not connected");
  assert.equal(res.body.data.earnings.length, 1, "only the completed, consumed session earns");
  assert.equal(res.body.data.earnings[0].session_id, sessions[0].id);
  assert.equal(res.body.data.earnings[0].gross_earning, 700);
  assert.equal((await routeCall(earningsRoute.GET, "GET", `/api/training-provider-earnings?providerId=${TRAINER}`, { cookie: stranger })).status, 403);
});

// The listTrainerSessions read model is what the route projects; it must never leak the raw contact
// columns even before projection strips them, so the projection is defence in depth, not the only wall.
test("listTrainerSessions joins programme facts and parses ledgers without inventing state", async () => {
  const world = freshWorld();
  const { sessions } = await programme(world, { sessions: 2 });
  await act(world, sessions[0], "accept", "l-accept");
  const rows = await listTrainerSessions(world.db, TRAINER);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.status), ["accepted", "locked"]);
  assert.deepEqual(rows[0].requirements, ["Use hand signals"]);
  assert.deepEqual(rows[0].evidenceRefs, []);
  assert.equal(rows[0].events[0].event_type, "accept");
  assert.equal(Number(rows[0].total_sessions), 2);
  assert.equal(await listTrainerSessions(world.db, OTHER_TRAINER).then((r) => r.length), 0);
});
