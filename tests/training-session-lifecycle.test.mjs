/*
 * Training Gate 2 (session lifecycle), EXECUTED.
 *
 * This file used to read lib/training-session-lifecycle.ts, its routes, both gateways and the
 * trainer workspace as strings and regex-match action names, table names and refusal copy. A test
 * named "consumes completion exactly once" asserted that `INSERT OR IGNORE INTO
 * training_session_consumptions` appeared in the source - which the module could satisfy in a comment
 * while double-consuming every session. Every case below drives the real mutation function or route
 * against a real SQLite-backed D1 and reads the ledger back, with the one marked exception at the end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  freshTrainingProgrammeWorld,
  seedTrainingBooking,
  seedRoster,
  seedAsset,
  uploadEvidence,
  seedEvidence,
  advanceSession,
  completeSession,
  seedActor,
  callRoute,
  bridgeClientFetch,
  platformSessionCookie,
  expectResponseRefusal,
  sessionStart,
  sessionEnd,
  sessionDate,
  REPORT,
  DOORSTEP,
  TRAINER_ID,
  OTHER_TRAINER_ID,
} from "./helpers/training-programme-harness.mjs";

const { materializeTrainingProgramme } = await import("../lib/training-programme.ts");
const { mutateTrainingSession, listTrainerSessions, ensureTrainingSessionLifecycleTables } = await import("../lib/training-session-lifecycle.ts");
const sessionsRoute = await import("../app/api/training-sessions/route.ts");
const mediaRoute = await import("../app/api/training-session-media/route.ts");

const count = (world, sql, ...args) => world.sqlite.prepare(sql).get(...args).n;
const sessionStatus = (world, id) => world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(id).status;
const trainer = (row) => `trainer:${row.provider_id}`;

async function programmeOf(world, options = {}) {
  const booking = seedTrainingBooking(world, options);
  const { sessions } = await materializeTrainingProgramme(world.db, { bookingId: booking.id, actorId: "uat" });
  return { booking, sessions };
}

test("Gate 2 owns each trainer session: every action is one idempotent event and completion consumes exactly once", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1, s2] } = await programmeOf(world, { sessions: 2 });

  await advanceSession(world.db, s1, "s1");
  const events = world.sqlite.prepare("SELECT event_type,idempotency_key FROM training_session_events WHERE session_id=? ORDER BY created_at").all(s1.id);
  assert.deepEqual(events.map((row) => row.event_type), ["accept", "on_the_way", "arrive", "start", "owner_handover"], "each action left exactly one event");
  assert.deepEqual(events.map((row) => row.idempotency_key), ["s1-accept", "s1-on_the_way", "s1-arrive", "s1-start", "s1-owner_handover"]);
  assert.equal(sessionStatus(world, s1.id), "in_session");

  const replay = await mutateTrainingSession(world.db, { sessionId: s1.id, action: "accept", actorId: trainer(s1), idempotencyKey: "s1-accept" });
  assert.equal(replay.duplicatePrevented, true, "the same key replays the recorded outcome");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_events WHERE session_id=?", s1.id), 5, "and writes no second event");
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "start", actorId: trainer(s1), idempotencyKey: "s1-accept" }),
    { status: 409, message: /An idempotency key identifies one action on one record/ },
  );
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s2.id, action: "accept", actorId: trainer(s2), idempotencyKey: "s2-early" }),
    { status: 409, message: /Training session cannot accept from locked/ },
  );
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "arrive", actorId: trainer(s1), idempotencyKey: "s1-arrive-again", ...DOORSTEP }),
    { status: 409, message: /Training session cannot arrive from in_session/ },
  );

  const evidenceRefs = seedEvidence(world, "MA-s1", s1);
  const done = await mutateTrainingSession(world.db, { sessionId: s1.id, action: "complete", actorId: trainer(s1), idempotencyKey: "s1-complete", report: { ...REPORT, evidenceRefs } });
  assert.equal(done.status, "completed");
  assert.equal(done.consumedExactlyOnce, true);
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_consumptions WHERE session_id=?", s1.id), 1);
  assert.equal(world.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id=?").get(s1.schedule_reservation_id).status, "completed");
  assert.equal(sessionStatus(world, s2.id), "scheduled", "completing session 1 unlocks session 2");
  const again = await mutateTrainingSession(world.db, { sessionId: s1.id, action: "complete", actorId: trainer(s1), idempotencyKey: "s1-complete" });
  assert.equal(again.duplicatePrevented, true);
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_consumptions"), 1, "a replayed completion never double-consumes");
  assert.deepEqual(
    { ...world.sqlite.prepare("SELECT completed_sessions,status FROM training_programmes").get() },
    { completed_sessions: 1, status: "in_progress" },
  );
});

test("completion requires attendance, homework and progress before any evidence is considered", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1] } = await programmeOf(world, { sessions: 2 });
  await advanceSession(world.db, s1, "s1");
  const evidenceRefs = seedEvidence(world, "MA-s1", s1);
  const attempt = (key, report) => mutateTrainingSession(world.db, { sessionId: s1.id, action: "complete", actorId: trainer(s1), idempotencyKey: key, report: { ...REPORT, evidenceRefs, ...report } });

  await expectResponseRefusal(() => attempt("c-mode", { attendance: { mode: "remote", safeAreaConfirmed: true } }), { status: 409, message: /Attendance mode must be parent or trainer_led/ });
  await expectResponseRefusal(() => attempt("c-area", { attendance: { mode: "trainer_led", safeAreaConfirmed: false } }), { status: 409, message: /Safe training area confirmation is required/ });
  await expectResponseRefusal(() => attempt("c-parent", { attendance: { mode: "parent", safeAreaConfirmed: true, parentOrCaretakerConfirmed: false } }), { status: 409, message: /Parent\/caretaker attendance confirmation is required/ });
  await expectResponseRefusal(() => attempt("c-homework", { homework: "ok" }), { status: 409, message: /Meaningful homework is required before completion/ });
  await expectResponseRefusal(() => attempt("c-progress-none", { progress: {} }), { status: 409, message: /At least one 1-10 progress score is required/ });
  await expectResponseRefusal(() => attempt("c-progress-range", { progress: { obedience: 11 } }), { status: 409, message: /At least one 1-10 progress score is required/ });

  assert.equal(sessionStatus(world, s1.id), "in_session", "every refused report leaves the session open");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_consumptions"), 0, "and nothing was consumed");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_events WHERE event_type='complete'"), 0);

  const done = await attempt("c-good", { attendance: { mode: "trainer_led", safeAreaConfirmed: true } });
  assert.equal(done.status, "completed");
  assert.deepEqual(JSON.parse(world.sqlite.prepare("SELECT homework_json FROM training_sessions WHERE id=?").get(s1.id).homework_json), { text: REPORT.homework });
});

test("completion accepts only clean, ready, non-synthetic proof linked to this exact session and trainer", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1, s2] } = await programmeOf(world, { sessions: 2 });
  await advanceSession(world.db, s1, "s1");
  await ensureTrainingSessionLifecycleTables(world.db);
  const attempt = (key, evidenceRefs) => mutateTrainingSession(world.db, { sessionId: s1.id, action: "complete", actorId: trainer(s1), idempotencyKey: key, report: { ...REPORT, evidenceRefs } });
  const linkedToThisSession = /not clean, ready, active, non-synthetic proof linked to this exact Training session\/trainer/;

  const good = seedAsset(world, "GOOD-B", "before_service", s1);
  const goodAfter = seedAsset(world, "GOOD-A", "after_service", s1);
  const otherSession = seedAsset(world, "OTHER-SESSION", "after_service", s1, { linkSessionId: s2.id });
  const otherTrainer = seedAsset(world, "OTHER-TRAINER", "after_service", s1, { providerId: OTHER_TRAINER_ID, linkProviderId: OTHER_TRAINER_ID });
  const unscanned = seedAsset(world, "UNSCANNED", "after_service", s1, { scan: "pending" });
  const synthetic = seedAsset(world, "SYNTHETIC", "after_service", s1, { synthetic: 1 });
  const quarantined = seedAsset(world, "QUARANTINED", "after_service", s1, { access: "quarantined" });

  await expectResponseRefusal(() => attempt("e-none", []), { status: 409, message: /At least one secure Training evidence asset is required/ });
  await expectResponseRefusal(() => attempt("e-raw", [good, "https://cdn.example/after.jpg"]), { status: 409, message: /must use a canonical media:\/\/asset reference/ });
  await expectResponseRefusal(() => attempt("e-ghost", [good, "media://asset/GHOST"]), { status: 409, message: linkedToThisSession });
  await expectResponseRefusal(() => attempt("e-session", [good, otherSession]), { status: 409, message: linkedToThisSession });
  await expectResponseRefusal(() => attempt("e-trainer", [good, otherTrainer]), { status: 409, message: linkedToThisSession });
  await expectResponseRefusal(() => attempt("e-scan", [good, unscanned]), { status: 409, message: linkedToThisSession });
  await expectResponseRefusal(() => attempt("e-synthetic", [good, synthetic]), { status: 409, message: linkedToThisSession });
  await expectResponseRefusal(() => attempt("e-access", [good, quarantined]), { status: 409, message: linkedToThisSession });
  await expectResponseRefusal(() => attempt("e-before-only", [good]), { status: 409, message: /Canonical Before Picture \+ After Picture are required/ });
  assert.equal(sessionStatus(world, s1.id), "in_session");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_consumptions"), 0);

  const done = await attempt("e-good", [good, goodAfter]);
  assert.equal(done.status, "completed");
  assert.deepEqual(JSON.parse(world.sqlite.prepare("SELECT evidence_json FROM training_sessions WHERE id=?").get(s1.id).evidence_json), [good, goodAfter]);
});

test("recovery preserves paid-session integrity: no-show and cancellation never consume, and consumption rows are never rewritten", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1, s2, s3] } = await programmeOf(world, { sessions: 3 });

  await completeSession(world, s1, "c1");
  const consumed = world.sqlite.prepare("SELECT * FROM training_session_consumptions WHERE session_id=?").get(s1.id);
  assert.ok(consumed, "session 1 is the only consumed session");

  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s2.id, action: "no_show", actorId: trainer(s2), idempotencyKey: "ns-early", reason: "customer absent at start" }),
    { status: 409, message: /Provider no-show can only be recorded after the session start grace period/ },
  );
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s2.id, action: "no_show", actorId: "ops:staff", idempotencyKey: "ns-short", reason: "absent", staffOverride: true }),
    { status: 400, message: /No-show requires a clear reason/ },
  );
  const noShow = await mutateTrainingSession(world.db, { sessionId: s2.id, action: "no_show", actorId: "ops:staff", idempotencyKey: "ns-staff", reason: "customer absent at start", staffOverride: true });
  assert.equal(noShow.status, "no_show");
  assert.equal(noShow.consumption, "pending_policy", "a no-show never auto-consumes a paid session");
  const noShowCase = world.sqlite.prepare("SELECT recovery_type,status,detail_json FROM training_session_recovery_cases WHERE session_id=?").get(s2.id);
  assert.deepEqual({ type: noShowCase.recovery_type, status: noShowCase.status, consumption: JSON.parse(noShowCase.detail_json).consumption }, { type: "no_show", status: "open", consumption: "pending_policy" });
  assert.equal(sessionStatus(world, s3.id), "scheduled", "the next session unlocks after a no-show");

  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s3.id, action: "cancel_session", actorId: trainer(s3), idempotencyKey: "cx-provider", reason: "trainer wants out of this one" }),
    { status: 403, message: /Training session cancellation requires staff booking permission/ },
  );
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s3.id, action: "cancel_session", actorId: "ops:staff", idempotencyKey: "cx-short", reason: "nope", staffOverride: true }),
    { status: 400, message: /Session cancellation requires a clear reason/ },
  );
  const cancelled = await mutateTrainingSession(world.db, { sessionId: s3.id, action: "cancel_session", actorId: "ops:staff", idempotencyKey: "cx-staff", reason: "customer relocated abroad", staffOverride: true });
  assert.equal(cancelled.status, "cancelled");
  const cancelCase = world.sqlite.prepare("SELECT recovery_type,detail_json FROM training_session_recovery_cases WHERE session_id=?").get(s3.id);
  assert.deepEqual({ type: cancelCase.recovery_type, consumption: JSON.parse(cancelCase.detail_json).consumption }, { type: "cancel", consumption: "not_consumed" });

  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_consumptions"), 1, "neither recovery path consumed anything");
  assert.deepEqual(world.sqlite.prepare("SELECT * FROM training_session_consumptions WHERE session_id=?").get(s1.id), consumed, "the existing consumption row is untouched");
  assert.deepEqual(
    { ...world.sqlite.prepare("SELECT completed_sessions,no_show_sessions,cancelled_sessions,status FROM training_programmes").get() },
    { completed_sessions: 1, no_show_sessions: 1, cancelled_sessions: 1, status: "completed_with_exceptions" },
  );
});

test("staff reschedule and trainer replacement are staff-only and re-evaluate the trainer's roster and eligibility", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1] } = await programmeOf(world, { sessions: 2 });
  const newStart = sessionStart(19), newEnd = sessionEnd(19);

  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "reschedule", actorId: trainer(s1), idempotencyKey: "rs-provider", newStart, newEnd }),
    { status: 403, message: /Rescheduling a canonical Training session requires staff booking permission/ },
  );
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "reschedule", actorId: "ops:staff", idempotencyKey: "rs-past", staffOverride: true, newStart: new Date(Date.now() - 3_600_000).toISOString(), newEnd: new Date().toISOString() }),
    { status: 400, message: /A valid future Training session window is required/ },
  );
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "reschedule", actorId: "ops:staff", idempotencyKey: "rs-noroster", staffOverride: true, newStart, newEnd }),
    { status: 409 },
  );
  assert.equal(world.sqlite.prepare("SELECT scheduled_start FROM training_sessions WHERE id=?").get(s1.id).scheduled_start, s1.scheduled_start, "no refused reschedule moved the session");

  seedRoster(world, TRAINER_ID, sessionDate(19));
  const moved = await mutateTrainingSession(world.db, { sessionId: s1.id, action: "reschedule", actorId: "ops:staff", idempotencyKey: "rs-ok", staffOverride: true, newStart, newEnd });
  assert.deepEqual({ status: moved.status, start: moved.scheduledStart }, { status: "scheduled", start: newStart });
  assert.equal(world.sqlite.prepare("SELECT scheduled_start FROM scheduling_reservations WHERE id=?").get(s1.schedule_reservation_id).scheduled_start, newStart, "the canonical reservation moved with the session");

  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "replace_provider", actorId: trainer(s1), idempotencyKey: "rp-provider", newProviderId: OTHER_TRAINER_ID, reason: "trainer is unwell this week" }),
    { status: 403, message: /Trainer replacement requires staff booking permission/ },
  );
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "replace_provider", actorId: "ops:staff", idempotencyKey: "rp-groomer", staffOverride: true, newProviderId: "groom_arun", reason: "trainer is unwell this week" }),
    { status: 409, message: /Replacement trainer is not eligible for this Training session/ },
  );
  seedRoster(world, OTHER_TRAINER_ID, sessionDate(19));
  const replaced = await mutateTrainingSession(world.db, { sessionId: s1.id, action: "replace_provider", actorId: "ops:staff", idempotencyKey: "rp-ok", staffOverride: true, newProviderId: OTHER_TRAINER_ID, reason: "trainer is unwell this week" });
  assert.equal(replaced.status, "scheduled");
  assert.equal(world.sqlite.prepare("SELECT provider_id FROM training_sessions WHERE id=?").get(s1.id).provider_id, OTHER_TRAINER_ID);
  assert.equal(world.sqlite.prepare("SELECT provider_id FROM scheduling_reservations WHERE id=?").get(s1.schedule_reservation_id).provider_id, OTHER_TRAINER_ID);
});

test("the sessions route enforces provider ownership for trainer actions and bookings.manage for staff actions", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1] } = await programmeOf(world, { sessions: 2 });
  const owner = await seedActor(world, { email: "kiran@pawspace.test", role: "service_provider", providerId: TRAINER_ID });
  const other = await seedActor(world, { email: "ramesh@pawspace.test", role: "service_provider", providerId: OTHER_TRAINER_ID });
  const manager = await seedActor(world, { email: "ops@pawspace.test", role: "manager" });

  const stolen = await callRoute(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: s1.id, action: "accept", idempotencyKey: "r-accept-other" }, email: other });
  assert.equal(stolen.status, 403, JSON.stringify(stolen.body));
  assert.match(String(stolen.body.error), /Provider ownership denied/);
  assert.equal(sessionStatus(world, s1.id), "scheduled");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_events"), 0, "a refused actor leaves no event");

  const accepted = await callRoute(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: s1.id, action: "accept", idempotencyKey: "r-accept" }, email: owner });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.status, "accepted");
  const audit = world.sqlite.prepare("SELECT detail_json FROM security_audit_events WHERE action='training.session.accept' AND actor_email=?").get(owner);
  assert.equal(JSON.parse(audit.detail_json).staffOverride, false);

  const escalated = await callRoute(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: s1.id, action: "cancel_session", idempotencyKey: "r-cancel-owner", reason: "I would rather not do this one" }, email: owner });
  assert.equal(escalated.status, 403, JSON.stringify(escalated.body));
  assert.match(String(escalated.body.error), /Permission denied/);
  assert.equal(sessionStatus(world, s1.id), "accepted");

  const cancelled = await callRoute(sessionsRoute.POST, "POST", "/api/training-sessions", { body: { sessionId: s1.id, action: "cancel_session", idempotencyKey: "r-cancel-staff", reason: "customer relocated abroad" }, email: manager });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.status, "cancelled");
  assert.equal(JSON.parse(world.sqlite.prepare("SELECT detail_json FROM security_audit_events WHERE action='training.session.cancel_session'").get().detail_json).staffOverride, true);

  const peek = await callRoute(sessionsRoute.GET, "GET", `/api/training-sessions?providerId=${TRAINER_ID}`, { email: other });
  assert.equal(peek.status, 403, "another trainer cannot list this trainer's sessions");
  const listed = await callRoute(sessionsRoute.GET, "GET", `/api/training-sessions?providerId=${TRAINER_ID}`, { email: owner });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 2);
  assert.notEqual(listed.body.data[0].customer_name, "Trisha Kumar", "the trainer never receives the customer's full name");
  assert.match(listed.body.data[0].customer_name, /^T•+ K•$/);
  assert.ok(listed.body.data[0].events.every((event) => event.actorId === "provider_or_system"), "staff actor ids are projected away");
});

test("both gateways map the sessions route to bookings.view for trainers and bookings.manage for staff actions", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1] } = await programmeOf(world, { sessions: 1 });
  const owner = await seedActor(world, { email: "kiran@pawspace.test", role: "service_provider", providerId: TRAINER_ID });
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const post = (action, headers) => new Request("https://app.pawspace.in/api/training-sessions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ sessionId: s1.id, action, idempotencyKey: `gw-${action}` }) });

  const trainerAccept = await authorizeApiRequest(post("accept", { "oai-authenticated-user-email": owner }), { DB: world.db });
  assert.equal(trainerAccept.permission, "bookings.view");
  for (const action of ["reschedule", "replace_provider", "cancel_session"]) {
    const denied = await authorizeApiRequest(post(action, { "oai-authenticated-user-email": owner }), { DB: world.db });
    assert.ok(denied instanceof Response && denied.status === 403, `${action} is a staff action a trainer cannot take`);
  }
  assert.equal(count(world, "SELECT COUNT(*) n FROM security_audit_events WHERE outcome='denied' AND actor_email=? AND resource_type='/api/training-sessions'", owner), 3);

  const cookie = await platformSessionCookie(world.db, "provider", TRAINER_ID);
  const sessionAccept = await authorizePlatformSessionRequest(post("accept", { cookie }), world.db);
  assert.equal(sessionAccept?.permission, "bookings.view");
  assert.equal(await authorizePlatformSessionRequest(post("replace_provider", { cookie }), world.db), null, "a platform session alone can never satisfy a staff action");
  const foreign = await authorizePlatformSessionRequest(new Request(`https://app.pawspace.in/api/training-sessions?providerId=${OTHER_TRAINER_ID}`, { headers: { cookie } }), world.db);
  assert.ok(foreign instanceof Response && foreign.status === 403, "a provider session is scoped to its own providerId");
});

test("evidence the media route creates is confirmed against its grant, scanned, and released by a second person; completion still demands the Before/After purposes the route cannot issue (gap pin)", async () => {
  const world = freshTrainingProgrammeWorld();
  // Two sessions so that session 1 is not the final one: the final-balance gate runs before the evidence gate.
  const { sessions: [s1] } = await programmeOf(world, { sessions: 2 });
  const trainerEmail = await seedActor(world, { email: "kiran@pawspace.test", role: "service_provider", providerId: TRAINER_ID });
  const reviewer = await seedActor(world, { email: "ops.manager@pawspace.test", role: "manager" });
  await advanceSession(world.db, s1, "s1");

  // The bytes are checked against the grant, never taken on the caller's word: a confirm whose observed
  // checksum differs from what was registered is refused and the asset stays pending_upload.
  const decoy = await callRoute(mediaRoute.POST, "POST", "/api/training-session-media", { body: { sessionId: s1.id, mimeType: "image/jpeg", sizeBytes: 2048, sha256: "d".repeat(64), fileName: "decoy.jpg" }, email: trainerEmail });
  assert.equal(decoy.status, 201, JSON.stringify(decoy.body));
  const wrong = await callRoute(mediaRoute.PATCH, "PATCH", "/api/training-session-media", { body: { id: decoy.body.data.id, action: "confirm_upload", uploadToken: decoy.body.data.upload.token, storageReference: decoy.body.data.upload.objectKey, observedSizeBytes: 2048, observedSha256: "c".repeat(64), observedMimeType: "image/jpeg" }, email: trainerEmail });
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
  assert.match(String(wrong.body.error), /checksum does not match the upload grant/);
  assert.equal(world.sqlite.prepare("SELECT access_status FROM service_media_assets WHERE id=?").get(decoy.body.data.id).access_status, "pending_upload");

  // The real path end to end: register, confirm, scanner verdict, second-person approval through the route.
  const evidence = await uploadEvidence(world, s1, { trainer: trainerEmail, reviewer, sha256: "b".repeat(64) });
  assert.deepEqual({ ...evidence.asset }, { purpose: "training_homework", scan_status: "clean", access_status: "ready", retention_status: "active", synthetic: 0, review_status: "approved", created_by: trainerEmail });
  assert.equal(evidence.confirmed.accessStatus, "quarantined", "confirmed bytes wait in quarantine for a second person");
  assert.equal(evidence.reviewed.proofReady, true);
  const own = await callRoute(mediaRoute.PATCH, "PATCH", "/api/training-session-media", { body: { id: evidence.id, action: "record_review", decision: "approved", reason: "Approving my own photo" }, email: trainerEmail });
  assert.equal(own.status, 403, "the uploader holds no review permission; approval is never self-service");
  const listed = await callRoute(mediaRoute.GET, "GET", `/api/training-session-media?sessionId=${s1.id}`, { email: trainerEmail });
  assert.deepEqual(listed.body.data.assets.filter((asset) => asset.id === evidence.id).map((asset) => asset.proofReady), [true]);

  // GAP PIN. Completion requires one before_service and one after_service asset (TRAINING_REQUIRED_PROOF),
  // but the route registers every Training photo under the single category "training_homework" and its
  // register input carries no purpose, so evidence created the product's own way can never close a session.
  // The completion tests seed Before/After rows directly until the route can issue those purposes; when it
  // can, this assertion goes red and the completion tests should switch to uploadEvidence.
  await expectResponseRefusal(
    () => mutateTrainingSession(world.db, { sessionId: s1.id, action: "complete", actorId: trainer(s1), idempotencyKey: "s1-complete-route-evidence", report: { ...REPORT, evidenceRefs: [evidence.ref] } }),
    { status: 409, message: /Canonical Before Picture \+ After Picture are required for Training completion/ },
  );
  assert.equal(sessionStatus(world, s1.id), "in_session");
});

test("the media route issues homework evidence grants only to the assigned trainer and never a raw public URL", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1] } = await programmeOf(world, { sessions: 1 });
  const owner = await seedActor(world, { email: "kiran@pawspace.test", role: "service_provider", providerId: TRAINER_ID });
  const other = await seedActor(world, { email: "ramesh@pawspace.test", role: "service_provider", providerId: OTHER_TRAINER_ID });
  const sha256 = "a".repeat(64);
  const register = { sessionId: s1.id, mimeType: "image/jpeg", sizeBytes: 2048, sha256, fileName: "homework.jpg" };

  const stolen = await callRoute(mediaRoute.POST, "POST", "/api/training-session-media", { body: register, email: other });
  assert.equal(stolen.status, 403, JSON.stringify(stolen.body));
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_media_links"), 0);

  const prepared = await callRoute(mediaRoute.POST, "POST", "/api/training-session-media", { body: register, email: owner });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  const { data } = prepared.body;
  assert.match(data.ref, /^media:\/\/asset\//);
  assert.deepEqual({ proofReady: data.proofReady, synthetic: data.synthetic, rawPublicUrl: data.upload.rawPublicUrl, singleUse: data.upload.singleUse }, { proofReady: false, synthetic: false, rawPublicUrl: false, singleUse: true });
  assert.ok(data.upload.token && data.upload.expiresAt > Date.now(), "a real single-use upload grant is issued");
  assert.doesNotMatch(JSON.stringify(prepared.body), /uat:\/\//, "no synthetic uat:// storage location is handed out");
  assert.equal(world.sqlite.prepare("SELECT category FROM media_upload_grants WHERE media_id=?").get(data.id)?.category, "training_homework");
  assert.deepEqual(
    { ...world.sqlite.prepare("SELECT session_id,provider_id FROM training_session_media_links WHERE media_id=?").get(data.id) },
    { session_id: s1.id, provider_id: TRAINER_ID },
  );

  const replay = await callRoute(mediaRoute.POST, "POST", "/api/training-session-media", { body: register, email: owner });
  assert.equal(replay.status, 200);
  assert.deepEqual({ id: replay.body.data.id, duplicatePrevented: replay.body.data.duplicatePrevented }, { id: data.id, duplicatePrevented: true });
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_session_media_links"), 1, "the same checksum is not registered twice");

  const listed = await callRoute(mediaRoute.GET, "GET", `/api/training-session-media?sessionId=${s1.id}`, { email: owner });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.assets.map((asset) => ({ id: asset.id, proofReady: asset.proofReady })), [{ id: data.id, proofReady: false }]);
  assert.equal((await callRoute(mediaRoute.GET, "GET", `/api/training-session-media?sessionId=${s1.id}`, { email: other })).status, 403);
});

test("the trainer workspace client drives canonical identity, sessions and evidence endpoints through the real routes", async () => {
  const world = freshTrainingProgrammeWorld();
  const { sessions: [s1] } = await programmeOf(world, { sessions: 1 });
  const cookie = await platformSessionCookie(world.db, "provider", TRAINER_ID);
  const bridge = bridgeClientFetch({
    "/api/identity-session": "../../app/api/identity-session/route.ts",
    "/api/training-sessions": "../../app/api/training-sessions/route.ts",
    "/api/training-session-media": "../../app/api/training-session-media/route.ts",
  }, { cookie });
  try {
    const client = await import("../lib/training-session-client.ts");
    const identity = await client.currentProviderIdentity();
    assert.deepEqual({ subjectType: identity.subjectType, subjectId: identity.subjectId }, { subjectType: "provider", subjectId: TRAINER_ID }, "the workspace identity comes from the platform session, not a fixture");

    const sessions = await client.loadTrainerSessions(identity.subjectId);
    assert.deepEqual(sessions.map((session) => ({ id: session.id, status: session.status })), [{ id: s1.id, status: "scheduled" }]);

    const accepted = await client.trainingSessionAction({ sessionId: s1.id, action: "accept" });
    assert.equal(accepted.status, "accepted");
    assert.equal(sessionStatus(world, s1.id), "accepted");
    const post = bridge.calls.find((call) => call.method === "POST" && call.path === "/api/training-sessions");
    assert.match(post.body.idempotencyKey, new RegExp(`^training:${s1.id}:accept:[0-9a-f-]{36}$`), "every trainer action carries a fresh per-action idempotency key");

    const evidence = await client.loadTrainingEvidence(s1.id);
    assert.deepEqual(evidence, { sessionId: s1.id, assets: [] });
    assert.deepEqual(bridge.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/identity-session", "GET /api/training-sessions", "POST /api/training-sessions", "GET /api/training-session-media"]);
  } finally {
    bridge.restore();
  }
  const sessionsForOther = await listTrainerSessions(world.db, OTHER_TRAINER_ID);
  assert.equal(sessionsForOther.length, 0, "a trainer's list is scoped to their own sessions");
});

/*
 * The ONE source-text assertion this file keeps. The workspace's payout panel copy is JSX rendered
 * only after its data loads; react-dom/server renders initial state, so it cannot be executed here.
 * The route it reads (/api/training-provider-earnings) is exercised for real in
 * tests/training-hardening.test.mjs and reports livePayout:false itself.
 */
test("the trainer workspace labels its payout ledger as canonical and not live", () => {
  const page = readFileSync(new URL("../app/trainer/page.tsx", import.meta.url), "utf8");
  assert.match(page, /CANONICAL TRAINING PAYOUT LEDGER/);
  assert.match(page, /Live payout is not connected/);
});
