import assert from "node:assert/strict";
import test from "node:test";
import { freshWorld, seedBooking, seedRoster, seedEvidence, seedProviderIdentity, seedCustomerIdentity, callAs, expectRefusal, REPORT, DOORSTEP, TRAINER, OTHER_TRAINER, CUSTOMER, sessionDate } from "./helpers/training-programme-harness.mjs";

/*
 * Work Order 02: Gate 2 used to be a regex over lib/training-session-lifecycle.ts. Every invariant the
 * old test grepped for is now exercised: the real mutate engine against node:sqlite, the real
 * /api/training-sessions route through the real ownership path, and the trainer projection as it
 * leaves the server.
 */
const { materializeTrainingProgramme } = await import("../lib/training-programme.ts");
const { mutateTrainingSession, getTrainingSession, TRAINING_ARRIVAL_GEOFENCE_METERS } = await import("../lib/training-session-lifecycle.ts");
const route = await import("../app/api/training-sessions/route.ts");

const count = (sqlite, sql, ...args) => sqlite.prepare(sql).get(...args).n;
const act = (db, session, action, key, extra = {}) => mutateTrainingSession(db, { sessionId: session.id, action, actorId: `trainer:${TRAINER}`, idempotencyKey: key, ...extra });

async function programme(t, id = "B1", sessions = 3) {
  const world = await freshWorld(t);
  seedBooking(world.sqlite, { id, group: `G-${id}`, sessions });
  for (let i = 0; i < sessions + 1; i++) seedRoster(world.sqlite, TRAINER, sessionDate(i));
  const made = await materializeTrainingProgramme(world.db, { bookingId: id, actorId: "uat" });
  return { ...world, sessions: made.sessions, programmeId: made.programme.id };
}

/** Walk a session to the point where completion is possible: accepted, travelled, arrived, started, handed over. */
async function readyToComplete(db, sqlite, session, key) {
  await act(db, session, "accept", `${key}-accept`);
  await act(db, session, "on_the_way", `${key}-otw`);
  await act(db, session, "arrive", `${key}-arrive`, DOORSTEP);
  await act(db, session, "start", `${key}-start`);
  const evidenceRefs = seedEvidence(sqlite, `MA-${key}`, session);
  await act(db, session, "owner_handover", `${key}-handover`, { ownerHandoverMinutes: 15 });
  return evidenceRefs;
}

test("a trainer session is owned end-to-end and completion consumes exactly one paid session", async (t) => {
  const { sqlite, db, sessions } = await programme(t);
  const [one, two] = sessions;
  const evidenceRefs = await readyToComplete(db, sqlite, one, "k1");
  const done = await act(db, one, "complete", "k1-complete", { report: { ...REPORT, evidenceRefs } });
  assert.equal(done.status, "completed");
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_consumptions WHERE session_id=?", one.id), 1, "exactly one consumption row");
  assert.equal(sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id=?").get(one.schedule_reservation_id).status, "completed", "the reservation is released as completed");
  assert.equal(sqlite.prepare("SELECT completed_sessions FROM training_programmes WHERE id=?").get(one.programme_id).completed_sessions, 1);
  assert.equal((await getTrainingSession(db, two.id)).status, "scheduled", "completing session 1 unlocks session 2");
  assert.equal((await getTrainingSession(db, sessions[2].id)).status, "locked", "but not session 3");
  const events = sqlite.prepare("SELECT event_type FROM training_session_events WHERE session_id=? ORDER BY created_at").all(one.id).map((r) => r.event_type);
  assert.deepEqual(events, ["accept", "on_the_way", "arrive", "start", "owner_handover", "complete"]);
  // Consumption is INSERT OR IGNORE behind a state guard: a second complete cannot double-consume.
  await assert.rejects(() => act(db, one, "complete", "k1-complete-again", { report: { ...REPORT, evidenceRefs } }));
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_consumptions WHERE session_id=?", one.id), 1);
});

test("an idempotency key replays the same action once and refuses re-use for a different action", async (t) => {
  const { sqlite, db, sessions } = await programme(t);
  const [one] = sessions;
  const first = await act(db, one, "accept", "same-key");
  const replay = await act(db, one, "accept", "same-key");
  assert.equal(first.duplicatePrevented, false);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_events WHERE idempotency_key='same-key'"), 1, "idempotency_key is UNIQUE and the replay wrote nothing");
  await expectRefusal(() => act(db, one, "on_the_way", "same-key"), { message: /idempotency key identifies one action on one record/ });
  assert.throws(() => sqlite.prepare("INSERT INTO training_session_events (id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,created_at) VALUES ('E-DUP',?,?,?,'accept','x','same-key',1)").run(one.id, one.programme_id, one.booking_id), /UNIQUE constraint failed: training_session_events\.idempotency_key/);
});

test("arrival is geofenced to the customer doorstep and a locked session cannot be started early", async (t) => {
  const { db, sessions } = await programme(t);
  const [one, two] = sessions;
  await act(db, one, "accept", "g-accept");
  await act(db, one, "on_the_way", "g-otw");
  await expectRefusal(() => act(db, one, "arrive", "g-arrive-blind"), { message: /ARRIVED requires provider latitude and longitude/ });
  const far = { latitude: DOORSTEP.latitude + 0.05, longitude: DOORSTEP.longitude }; // ~5.5km north
  await expectRefusal(() => act(db, one, "arrive", "g-arrive-far", far), { status: 409, message: new RegExp(`from the customer doorstep.*${TRAINING_ARRIVAL_GEOFENCE_METERS}m`) });
  assert.equal((await getTrainingSession(db, one.id)).status, "on_the_way", "a refused arrival leaves the session travelling");
  await act(db, one, "arrive", "g-arrive", DOORSTEP);
  assert.equal((await getTrainingSession(db, one.id)).status, "arrived");
  await assert.rejects(() => act(db, two, "accept", "g-two-accept"), "session 2 is locked behind session 1");
  assert.equal((await getTrainingSession(db, two.id)).status, "locked");
});

test("completion requires the owner handover, attendance, homework, progress and exact-session secure media", async (t) => {
  const { sqlite, db, sessions } = await programme(t);
  const [one] = sessions;
  await act(db, one, "accept", "c-accept");
  await act(db, one, "on_the_way", "c-otw");
  await act(db, one, "arrive", "c-arrive", DOORSTEP);
  await act(db, one, "start", "c-start");
  const evidenceRefs = seedEvidence(sqlite, "MA-c", one);
  await expectRefusal(() => act(db, one, "complete", "c-no-handover", { report: { ...REPORT, evidenceRefs } }), { message: /Owner Handover/ });
  await expectRefusal(() => act(db, one, "owner_handover", "c-short-handover", { ownerHandoverMinutes: 5 }), { message: /at least 15 minutes/ });
  await act(db, one, "owner_handover", "c-handover", { ownerHandoverMinutes: 15 });
  await expectRefusal(() => act(db, one, "complete", "c-bad-mode", { report: { ...REPORT, attendance: { ...REPORT.attendance, mode: "remote" }, evidenceRefs } }), { message: /Attendance mode must be parent or trainer_led/ });
  await expectRefusal(() => act(db, one, "complete", "c-no-parent", { report: { ...REPORT, attendance: { ...REPORT.attendance, parentOrCaretakerConfirmed: false }, evidenceRefs } }), { message: /Parent\/caretaker attendance confirmation is required/ });
  await expectRefusal(() => act(db, one, "complete", "c-no-homework", { report: { ...REPORT, homework: "ok", evidenceRefs } }), { message: /Meaningful homework is required before completion/ });
  await expectRefusal(() => act(db, one, "complete", "c-no-progress", { report: { ...REPORT, progress: {}, evidenceRefs } }), { message: /At least one 1-10 progress score is required/ });
  await expectRefusal(() => act(db, one, "complete", "c-no-media", { report: { ...REPORT, evidenceRefs: [] } }));
  // Media linked to ANOTHER session, or not clean, is not this session's evidence.
  sqlite.prepare("UPDATE training_session_media_links SET session_id='S-ELSEWHERE' WHERE media_id='MA-c-B'").run();
  await expectRefusal(() => act(db, one, "complete", "c-wrong-session", { report: { ...REPORT, evidenceRefs } }));
  sqlite.prepare("UPDATE training_session_media_links SET session_id=? WHERE media_id='MA-c-B'").run(one.id);
  sqlite.prepare("UPDATE service_media_assets SET scan_status='infected' WHERE id='MA-c-A'").run();
  await expectRefusal(() => act(db, one, "complete", "c-infected", { report: { ...REPORT, evidenceRefs } }));
  sqlite.prepare("UPDATE service_media_assets SET scan_status='clean' WHERE id='MA-c-A'").run();
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_consumptions"), 0, "no refused completion consumed a session");
  const done = await act(db, one, "complete", "c-complete", { report: { ...REPORT, evidenceRefs } });
  assert.equal(done.status, "completed");
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_consumptions"), 1);
});

test("recovery preserves paid-session integrity: a no-show opens a case and consumes nothing", async (t) => {
  const { sqlite, db, sessions } = await programme(t);
  const [one] = sessions;
  await act(db, one, "accept", "n-accept");
  await expectRefusal(() => act(db, one, "no_show", "n-no-reason"), { message: /No-show requires a clear reason/ });
  await expectRefusal(() => act(db, one, "no_show", "n-too-early", { reason: "Customer absent at doorstep" }), { message: /after the session start grace period/ });
  // Age the session so the grace period has passed, the way it does in production.
  const past = new Date(Date.now() - 3 * 3_600_000).toISOString(), pastEnd = new Date(Date.now() - 2 * 3_600_000).toISOString();
  sqlite.prepare("UPDATE training_sessions SET scheduled_start=?,scheduled_end=? WHERE id=?").run(past, pastEnd, one.id);
  const noShow = await act(db, one, "no_show", "n-recorded", { reason: "Customer absent at doorstep" });
  assert.equal(noShow.status, "no_show");
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_recovery_cases WHERE session_id=?", one.id), 1, "a recovery case is opened");
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_consumptions"), 0, "nothing is consumed by a no-show");
  assert.equal(sqlite.prepare("SELECT no_show_sessions FROM training_programmes WHERE id=?").get(one.programme_id).no_show_sessions, 1);
  // Consumption rows are never updated in place: the engine has no UPDATE path over them.
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name='training_session_consumptions'"), 0);
});

test("/api/training-sessions: staff actions need bookings.manage, trainers only see and act on their own sessions, and the projection never leaks contact data", async (t) => {
  const { sqlite, sessions } = await programme(t);
  const [one] = sessions;
  seedProviderIdentity(sqlite, "kiran@example.in", TRAINER);
  seedProviderIdentity(sqlite, "sanjay@example.in", OTHER_TRAINER);
  seedCustomerIdentity(sqlite, "owner@example.in", CUSTOMER);

  const stranger = await callAs(route.GET, "GET", `providerId=${TRAINER}`, "sanjay@example.in");
  assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
  const customer = await callAs(route.GET, "GET", `providerId=${TRAINER}`, "owner@example.in");
  assert.equal(customer.status, 403, "a customer role has no bookings.view");

  const mine = await callAs(route.GET, "GET", `providerId=${TRAINER}`, "kiran@example.in");
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.data.length, 3);
  const serialized = JSON.stringify(mine.body.data);
  for (const secret of ["+91-9000000001", "trisha@example.in", "customer_phone", "customer_email", "Trisha Kumar"]) assert.equal(serialized.includes(secret), false, `${secret} must not reach the trainer`);
  assert.deepEqual(mine.body.data[0].requirements, ["Recall"]);

  const strangerAct = await callAs(route.POST, "POST", { sessionId: one.id, action: "accept", idempotencyKey: "r-stranger" }, "sanjay@example.in");
  assert.equal(strangerAct.status, 403);
  const staffOnly = await callAs(route.POST, "POST", { sessionId: one.id, action: "replace_provider", idempotencyKey: "r-replace", newProviderId: OTHER_TRAINER, reason: "Trainer unwell" }, "kiran@example.in");
  assert.equal(staffOnly.status, 403, "replace_provider needs bookings.manage");
  const missing = await callAs(route.POST, "POST", { sessionId: "S-NOPE", action: "accept", idempotencyKey: "r-missing" }, "kiran@example.in");
  assert.equal(missing.status, 404);
  const accepted = await callAs(route.POST, "POST", { sessionId: one.id, action: "accept", idempotencyKey: "r-accept" }, "kiran@example.in");
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.status, "accepted");
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM security_audit_events WHERE action='training.session.accept'"), 1);
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_session_events WHERE session_id=?", one.id), 1, "refused callers wrote no events");
});
