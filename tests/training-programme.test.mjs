import assert from "node:assert/strict";
import test from "node:test";
import { freshWorld, seedBooking, seedCustomerIdentity, callAs, expectRefusal, TRAINER, OTHER_TRAINER, CUSTOMER, OTHER_CUSTOMER, sessionStart, sessionEnd, NOW } from "./helpers/training-programme-harness.mjs";

/*
 * Work Order 02: this suite used to regex-match lib/training-programme.ts for table names and
 * error strings. It now executes the module - real SQL on node:sqlite through the D1 adapter - and
 * drives the real /api/training-programmes route through the real role + ownership path.
 */
const { ensureTrainingProgrammeTables, materializeTrainingProgramme, readTrainingProgramme } = await import("../lib/training-programme.ts");
const route = await import("../app/api/training-programmes/route.ts");

const count = (sqlite, sql, ...args) => sqlite.prepare(sql).get(...args).n;

test("materializes one programme and one canonical session row per reserved session, sequentially locked", async (t) => {
  const { sqlite, db } = await freshWorld(t);
  seedBooking(sqlite, { id: "B1", group: "G1", sessions: 4 });
  const first = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(Number(first.programme.total_sessions), 4);
  assert.deepEqual(first.sessions.map((s) => Number(s.sequence_no)), [1, 2, 3, 4]);
  assert.deepEqual(first.sessions.map((s) => s.status), ["scheduled", "locked", "locked", "locked"], "only the next session is runnable");
  assert.ok(first.sessions.every((s) => s.provider_id === TRAINER));
  // Each session is bound to exactly its reservation and the reservation window is copied, not invented.
  for (const [index, session] of first.sessions.entries()) {
    assert.equal(session.schedule_reservation_id, `R-B1-${index + 1}`);
    assert.equal(session.scheduled_start, sessionStart(index));
    assert.equal(session.scheduled_end, sessionEnd(index));
  }
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_programme_events WHERE booking_id='B1' AND event_type='programme_materialized'"), 1);
  assert.deepEqual(JSON.parse(first.programme.requirements_json), ["Recall"], "booking requirements are carried onto the programme");
  const read = await readTrainingProgramme(db, "B1");
  assert.equal(read.sessions.length, 4);
  assert.equal(await readTrainingProgramme(db, "NOPE"), null);
});

test("replay is idempotent and the schema itself refuses a second programme or a re-used reservation", async (t) => {
  const { sqlite, db } = await freshWorld(t);
  seedBooking(sqlite, { id: "B2", group: "G2", sessions: 3 });
  await materializeTrainingProgramme(db, { bookingId: "B2", actorId: "uat" });
  const replay = await materializeTrainingProgramme(db, { bookingId: "B2", actorId: "uat" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_sessions WHERE booking_id='B2'"), 3, "replay must not duplicate sessions");
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_programmes WHERE booking_id='B2'"), 1);
  const programmeId = sqlite.prepare("SELECT id FROM training_programmes WHERE booking_id='B2'").get().id;
  // The UNIQUE constraints the old test only grepped for, proven by the engine.
  assert.throws(() => sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,total_sessions,created_at,updated_at) VALUES ('TP-DUP','B2',?,?,'blr','blr-east','x','x','[]',3,?,?)").run(CUSTOMER, TRAINER, NOW, NOW), /UNIQUE constraint failed: training_programmes\.booking_id/);
  assert.throws(() => sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('S-DUP',?, 'B2','R-B2-1',9,?,?,?,?,?)").run(programmeId, TRAINER, sessionStart(0), sessionEnd(0), NOW, NOW), /UNIQUE constraint failed: training_sessions\.schedule_reservation_id/);
  assert.throws(() => sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('S-DUP2',?, 'B2','R-OTHER',1,?,?,?,?,?)").run(programmeId, TRAINER, sessionStart(0), sessionEnd(0), NOW, NOW), /UNIQUE constraint failed: training_sessions\.programme_id, training_sessions\.sequence_no/);
});

test("materialization fails closed: missing, wrong-service, unreserved, mismatched-provider, duplicate-occurrence and assessment bookings", async (t) => {
  const { sqlite, db } = await freshWorld(t);
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "MISSING", actorId: "uat" }), { status: 404, message: /Canonical Training booking not found/ });

  seedBooking(sqlite, { id: "B-NORES", group: "G-NORES", sessions: 2, reservations: 0 });
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B-NORES", actorId: "uat" }), { status: 409, message: /requires scheduled session reservations/ });

  seedBooking(sqlite, { id: "B-PROV", group: "G-PROV", sessions: 2, reservationProvider: OTHER_TRAINER });
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B-PROV", actorId: "uat" }), { status: 409, message: /Training session provider does not match the canonical booking/ });

  seedBooking(sqlite, { id: "B-OCC", group: "G-OCC", sessions: 2, occurrenceNumbers: [1, 1] });
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B-OCC", actorId: "uat" }), { status: 409, message: /occurrence numbers must be unique/ });

  seedBooking(sqlite, { id: "B-MEET", group: "G-MEET", sessions: 1, packageCode: "trainer-meet-greet" });
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B-MEET", actorId: "uat" }), { status: 409, message: /Meet & Greet is an assessment booking, not a Training programme/ });

  // A grooming booking with the same id shape is invisible to the Training materializer.
  sqlite.prepare("UPDATE canonical_bookings SET service_code='grooming' WHERE id='B-NORES'").run();
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B-NORES", actorId: "uat" }), { status: 404 });

  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_programmes"), 0, "every refusal leaves no partial programme");
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_sessions"), 0);
});

test("a linked Meet & Greet must belong to the same Training customer and be an uncancelled assessment", async (t) => {
  const { sqlite, db } = await freshWorld(t);
  seedBooking(sqlite, { id: "B3", group: "G3", sessions: 2 });
  seedBooking(sqlite, { id: "MEET-OTHER", group: "G-MO", sessions: 1, packageCode: "trainer-meet-greet", customer: OTHER_CUSTOMER });
  seedBooking(sqlite, { id: "MEET-MINE", group: "G-MM", sessions: 1, packageCode: "trainer-meet-greet" });
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B3", meetBookingId: "MEET-OTHER", actorId: "uat" }), { status: 409, message: /Meet & Greet does not belong to this Training customer\/programme/ });
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B3", meetBookingId: "B-NOPE", actorId: "uat" }), { status: 409 });
  sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='MEET-MINE'").run();
  await expectRefusal(() => materializeTrainingProgramme(db, { bookingId: "B3", meetBookingId: "MEET-MINE", actorId: "uat" }), { status: 409 });
  sqlite.prepare("UPDATE canonical_bookings SET status='confirmed' WHERE id='MEET-MINE'").run();
  const linked = await materializeTrainingProgramme(db, { bookingId: "B3", meetBookingId: "MEET-MINE", actorId: "uat" });
  assert.equal(linked.programme.meet_booking_id, "MEET-MINE");
});

test("/api/training-programmes is customer-owned: a stranger is refused, the owner materializes once and reads it back", async (t) => {
  const { sqlite } = await freshWorld(t);
  seedBooking(sqlite, { id: "B4", group: "G4", sessions: 2 });
  seedCustomerIdentity(sqlite, "owner@example.in", CUSTOMER);
  seedCustomerIdentity(sqlite, "stranger@example.in", OTHER_CUSTOMER);

  const missing = await callAs(route.GET, "GET", "bookingId=B4", "owner@example.in");
  assert.equal(missing.status, 404, JSON.stringify(missing.body));

  const stranger = await callAs(route.POST, "POST", { bookingId: "B4" }, "stranger@example.in");
  assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM training_programmes"), 0, "a refused caller materializes nothing");

  const anonymous = await route.POST(new Request("https://app.pawspace.in/api/training-programmes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: "B4" }) }));
  assert.ok([401, 403].includes(anonymous.status), `anonymous caller must be refused, got ${anonymous.status}`);

  const created = await callAs(route.POST, "POST", { bookingId: "B4" }, "owner@example.in");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.sessions.length, 2);
  const replay = await callAs(route.POST, "POST", { bookingId: "B4" }, "owner@example.in");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);
  const read = await callAs(route.GET, "GET", "bookingId=B4", "owner@example.in");
  assert.equal(read.status, 200);
  assert.equal(read.body.data.programme.booking_id, "B4");
  const strangerRead = await callAs(route.GET, "GET", "bookingId=B4", "stranger@example.in");
  assert.equal(strangerRead.status, 403);
  assert.equal(count(sqlite, "SELECT COUNT(*) n FROM security_audit_events WHERE action='training.programme.materialize'"), 2, "each authorized materialize call is audited");
  assert.equal(await ensureTrainingProgrammeTables(globalThis.__TRAINING_WO02_DB__), undefined, "ensure is idempotent on an already-built schema");
});
