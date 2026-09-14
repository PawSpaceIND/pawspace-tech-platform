/*
 * Training programme ledger, EXECUTED.
 *
 * This file used to read lib/training-programme.ts, app/api/training-programmes/route.ts, both
 * gateways and the customer flow as strings and regex-match table names, refusal messages and
 * function names. None of those assertions could detect a broken module: the UNIQUE keys could be
 * dropped from the DDL and `assert.match(engine,/UNIQUE\(programme_id,sequence_no\)/)` would still
 * pass on the comment above it. Every case below runs the real function or route against a real
 * SQLite-backed D1 and reads the rows back, with the one deliberate exception marked at the end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  freshTrainingProgrammeWorld,
  seedTrainingBooking,
  seedActor,
  callRoute,
  bridgeClientFetch,
  platformSessionCookie,
  expectResponseRefusal,
  TRAINER_ID,
  OTHER_TRAINER_ID,
  CUSTOMER_ID,
} from "./helpers/training-programme-harness.mjs";

const { materializeTrainingProgramme, readTrainingProgramme, ensureTrainingProgrammeTables } = await import("../lib/training-programme.ts");
const programmeRoute = await import("../app/api/training-programmes/route.ts");

const count = (world, sql, ...args) => world.sqlite.prepare(sql).get(...args).n;

test("Training materializes one programme and one canonical row per reserved session, once", async () => {
  const world = freshTrainingProgrammeWorld();
  const booking = seedTrainingBooking(world, { sessions: 4, pricing: { requirements: ["Leash walking", "Recall"] } });

  const first = await materializeTrainingProgramme(world.db, { bookingId: booking.id, actorId: "customer:trisha" });
  assert.equal(first.duplicatePrevented, false);
  const programme = world.sqlite.prepare("SELECT * FROM training_programmes WHERE booking_id=?").get(booking.id);
  assert.deepEqual(
    { customer: programme.customer_id, provider: programme.provider_id, plan: programme.plan_code, total: programme.total_sessions, status: programme.status, requirements: JSON.parse(programme.requirements_json) },
    { customer: CUSTOMER_ID, provider: TRAINER_ID, plan: "training-4-puppy", total: 4, status: "scheduled", requirements: ["Leash walking", "Recall"] },
  );

  const sessions = world.sqlite.prepare("SELECT * FROM training_sessions WHERE programme_id=? ORDER BY sequence_no").all(programme.id);
  assert.equal(sessions.length, 4, "one session row per reservation");
  assert.deepEqual(sessions.map((row) => row.sequence_no), [1, 2, 3, 4]);
  assert.deepEqual(sessions.map((row) => row.schedule_reservation_id), ["R-B1-1", "R-B1-2", "R-B1-3", "R-B1-4"], "each session is bound to exactly its reservation");
  assert.deepEqual(sessions.map((row) => row.status), ["scheduled", "locked", "locked", "locked"], "only the first session is runnable");
  assert.ok(sessions.every((row) => row.provider_id === TRAINER_ID));

  const events = world.sqlite.prepare("SELECT event_type,actor_id,detail_json FROM training_programme_events WHERE programme_id=?").all(programme.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "programme_materialized");
  assert.equal(events[0].actor_id, "customer:trisha");
  assert.equal(JSON.parse(events[0].detail_json).sessionCount, 4);

  const replay = await materializeTrainingProgramme(world.db, { bookingId: booking.id, actorId: "customer:trisha" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_programmes"), 1, "replay must not create a second programme");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_sessions"), 4, "replay must not duplicate sessions");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_programme_events"), 1, "replay must not re-emit the materialization event");
  assert.equal((await readTrainingProgramme(world.db, booking.id)).sessions.length, 4);
});

test("the ledger is keyed once per booking, once per reservation and once per sequence number", async () => {
  const world = freshTrainingProgrammeWorld();
  const booking = seedTrainingBooking(world, { sessions: 2 });
  const { programme } = await materializeTrainingProgramme(world.db, { bookingId: booking.id, actorId: "uat" });
  const now = Date.now();

  assert.throws(
    () => world.sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,total_sessions,created_at,updated_at) VALUES ('TP-DUP',?,?,?,'blr','blr-east','x','x','[]',2,?,?)").run(booking.id, CUSTOMER_ID, TRAINER_ID, now, now),
    /UNIQUE/, "a booking can own only one programme",
  );
  assert.throws(
    () => world.sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('TS-DUP',?,?,'R-B1-1',9,?,'x','y',?,?)").run(programme.id, booking.id, TRAINER_ID, now, now),
    /UNIQUE/, "a reservation can back only one session",
  );
  assert.throws(
    () => world.sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('TS-DUP2',?,?,'R-OTHER',1,?,'x','y',?,?)").run(programme.id, booking.id, TRAINER_ID, now, now),
    /UNIQUE/, "a programme cannot hold two sessions with the same sequence number",
  );
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_sessions"), 2);
});

test("materialization refuses bookings it cannot bind honestly and writes nothing", async () => {
  const world = freshTrainingProgrammeWorld();
  const now = Date.now();
  // A Grooming booking is invisible to the Training ledger even with a matching id.
  world.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,total_amount,created_by,created_at,updated_at) VALUES ('B-GROOM','i-groom','c','[]','[]','blr','blr-east','grooming','dog-basic','Bath & Basic','G-GROOM','groom_arun','x','y',1899,'uat',?,?)").run(now, now);
  await expectResponseRefusal(() => materializeTrainingProgramme(world.db, { bookingId: "B-GROOM", actorId: "uat" }), { status: 404, message: /Canonical Training booking not found/ });

  seedTrainingBooking(world, { id: "B-NORES", group: "G-NORES", sessions: 0 });
  await expectResponseRefusal(() => materializeTrainingProgramme(world.db, { bookingId: "B-NORES", actorId: "uat" }), { status: 409, message: /requires scheduled session reservations/ });

  seedTrainingBooking(world, { id: "B-MISMATCH", group: "G-MISMATCH", sessions: 2, reservationProvider: OTHER_TRAINER_ID });
  await expectResponseRefusal(() => materializeTrainingProgramme(world.db, { bookingId: "B-MISMATCH", actorId: "uat" }), { status: 409, message: /Training session provider does not match the canonical booking/ });

  seedTrainingBooking(world, { id: "B-DUPOCC", group: "G-DUPOCC", sessions: 2, occurrenceNumbers: [1, 1] });
  await expectResponseRefusal(() => materializeTrainingProgramme(world.db, { bookingId: "B-DUPOCC", actorId: "uat" }), { status: 409, message: /Training session occurrence numbers must be unique/ });

  seedTrainingBooking(world, { id: "B-MEET", group: "G-MEET", sessions: 1, packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet" });
  await expectResponseRefusal(() => materializeTrainingProgramme(world.db, { bookingId: "B-MEET", actorId: "uat" }), { status: 409, message: /Meet & Greet is an assessment booking, not a Training programme/ });

  assert.equal(count(world, "SELECT COUNT(*) n FROM training_programmes"), 0, "every refusal leaves the ledger empty");
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_sessions"), 0);
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_programme_events"), 0);
});

test("a linked Meet & Greet must belong to the same Training customer", async () => {
  const world = freshTrainingProgrammeWorld();
  seedTrainingBooking(world, { id: "B-PROG", group: "G-PROG", sessions: 2 });
  seedTrainingBooking(world, { id: "B-MEET-OTHER", group: "G-MEET-OTHER", sessions: 1, customer: "cus_someone_else", packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet" });
  seedTrainingBooking(world, { id: "B-MEET-OWN", group: "G-MEET-OWN", sessions: 1, packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet" });

  await expectResponseRefusal(
    () => materializeTrainingProgramme(world.db, { bookingId: "B-PROG", meetBookingId: "B-MEET-OTHER", actorId: "uat" }),
    { status: 409, message: /Meet & Greet does not belong to this Training customer\/programme/ },
  );
  await expectResponseRefusal(
    () => materializeTrainingProgramme(world.db, { bookingId: "B-PROG", meetBookingId: "B-PROG", actorId: "uat" }),
    { status: 409, message: /Meet & Greet does not belong/ },
  );
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_programmes"), 0);

  const linked = await materializeTrainingProgramme(world.db, { bookingId: "B-PROG", meetBookingId: "B-MEET-OWN", actorId: "uat" });
  assert.equal(linked.programme.meet_booking_id, "B-MEET-OWN");
  assert.equal(JSON.parse(linked.events[0].detail_json).meetBookingId, "B-MEET-OWN");
});

test("the programme route is customer-owned: another customer is refused before any ledger row is written", async () => {
  const world = freshTrainingProgrammeWorld();
  const booking = seedTrainingBooking(world, { sessions: 3 });
  const mallory = await seedActor(world, { email: "mallory@pawspace.test", role: "customer", customerId: "cus_other" });
  const trisha = await seedActor(world, { email: "trisha@pawspace.test", role: "customer", customerId: CUSTOMER_ID });

  const denied = await callRoute(programmeRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: booking.id }, email: mallory });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.match(String(denied.body.error), /Customer ownership denied/);
  await ensureTrainingProgrammeTables(world.db);
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_programmes"), 0, "the refusal happens before materialization");
  assert.equal(count(world, "SELECT COUNT(*) n FROM security_audit_events WHERE action='training.programme.materialize'"), 0);

  const created = await callRoute(programmeRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: booking.id }, email: trisha });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.sessions.length, 3);
  assert.equal(created.body.data.duplicatePrevented, false);
  const audit = world.sqlite.prepare("SELECT actor_email,resource_id,outcome,detail_json FROM security_audit_events WHERE action='training.programme.materialize'").all();
  assert.equal(audit.length, 1);
  assert.deepEqual({ actor: audit[0].actor_email, resource: audit[0].resource_id, outcome: audit[0].outcome, duplicate: JSON.parse(audit[0].detail_json).duplicatePrevented }, { actor: trisha, resource: booking.id, outcome: "completed", duplicate: false });

  const replay = await callRoute(programmeRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: booking.id }, email: trisha });
  assert.equal(replay.status, 200, "a replay is acknowledged, not re-created");
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_sessions"), 3);

  const read = await callRoute(programmeRoute.GET, "GET", `/api/training-programmes?bookingId=${booking.id}`, { email: trisha });
  assert.equal(read.status, 200);
  assert.equal(read.body.data.programme.booking_id, booking.id);
  const peek = await callRoute(programmeRoute.GET, "GET", `/api/training-programmes?bookingId=${booking.id}`, { email: mallory });
  assert.equal(peek.status, 403, "reading another customer's programme is refused the same way");
});

test("the programme route and both gateways require scheduling.book on a customer subject", async () => {
  const world = freshTrainingProgrammeWorld();
  const booking = seedTrainingBooking(world, { sessions: 2 });
  const trainer = await seedActor(world, { email: "kiran@pawspace.test", role: "service_provider", providerId: TRAINER_ID });
  const customer = await seedActor(world, { email: "trisha@pawspace.test", role: "customer", customerId: CUSTOMER_ID });

  // The route itself: a service_provider identity has bookings.view but not scheduling.book.
  const denied = await callRoute(programmeRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: booking.id }, email: trainer });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.match(String(denied.body.error), /Permission denied/);
  await ensureTrainingProgrammeTables(world.db);
  assert.equal(count(world, "SELECT COUNT(*) n FROM training_programmes"), 0);

  // The API gateway maps the path to the same permission and audits the denial.
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const post = (email) => new Request("https://app.pawspace.in/api/training-programmes", { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify({ bookingId: booking.id }) });
  const gatewayDenied = await authorizeApiRequest(post(trainer), { DB: world.db });
  assert.ok(gatewayDenied instanceof Response && gatewayDenied.status === 403, "gateway refuses a provider identity");
  assert.equal(count(world, "SELECT COUNT(*) n FROM security_audit_events WHERE outcome='denied' AND actor_email=? AND resource_type='/api/training-programmes'", trainer), 1);
  const gatewayAllowed = await authorizeApiRequest(post(customer), { DB: world.db });
  assert.equal(gatewayAllowed.permission, "scheduling.book");
  assert.equal(gatewayAllowed.actor.email, customer);

  // The platform-session gateway scopes the path to CUSTOMER sessions: a verified provider session
  // is refused on subject type before permissions are even considered.
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const withCookie = (cookie) => new Request("https://app.pawspace.in/api/training-programmes", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ bookingId: booking.id }) });
  const providerSession = await authorizePlatformSessionRequest(withCookie(await platformSessionCookie(world.db, "provider", TRAINER_ID)), world.db);
  assert.ok(providerSession instanceof Response && providerSession.status === 403, "a provider session cannot reach a customer-scoped route");
  assert.match(await providerSession.text(), /does not own this customer\/provider scope/);
  const customerSession = await authorizePlatformSessionRequest(withCookie(await platformSessionCookie(world.db, "customer", CUSTOMER_ID)), world.db);
  assert.equal(customerSession?.permission, "scheduling.book");
  assert.equal(customerSession?.actor.roleCode, "customer");
});

test("the customer client materializes and reads the programme through the real route", async () => {
  const world = freshTrainingProgrammeWorld();
  const booking = seedTrainingBooking(world, { sessions: 2 });
  const trisha = await seedActor(world, { email: "trisha@pawspace.test", role: "customer", customerId: CUSTOMER_ID });
  const bridge = bridgeClientFetch({ "/api/training-programmes": "../../app/api/training-programmes/route.ts" }, { email: trisha });
  try {
    const client = await import("../lib/training-programme-client.ts");
    const created = await client.materializeTrainingProgramme({ bookingId: booking.id });
    assert.equal(created.duplicatePrevented, false);
    assert.equal(created.sessions.length, 2);
    assert.equal(count(world, "SELECT COUNT(*) n FROM training_programmes WHERE booking_id=?", booking.id), 1, "the client call reached the ledger");

    const loaded = await client.loadTrainingProgramme(booking.id);
    assert.equal(loaded.programme.booking_id, booking.id);
    assert.deepEqual(loaded.sessions.map((session) => session.sequence_no), [1, 2]);
    assert.deepEqual(bridge.calls.map((call) => `${call.method} ${call.path}`), ["POST /api/training-programmes", "GET /api/training-programmes"]);
    assert.deepEqual(bridge.calls[1].query, { bookingId: booking.id });

    await assert.rejects(client.materializeTrainingProgramme({ bookingId: "B-NOPE" }), /Unable to materialize Training programme/, "a route refusal surfaces as the server's error, not a fabricated success");
    assert.equal(count(world, "SELECT COUNT(*) n FROM training_programmes"), 1);
  } finally {
    bridge.restore();
  }
});

/*
 * The ONE source-text assertion this file keeps. The mobile flow must call the ledger BEFORE it shows
 * the success screen; that ordering lives inside a React event handler and cannot be executed here
 * (react-dom/server renders initial state only). Everything the call does once made is proven above.
 */
test("the customer flow materializes the programme before it shows success", () => {
  const flow = readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");
  const materialize = flow.indexOf("await materializeTrainingProgramme({bookingId:canonical.bookingId");
  const confirmed = flow.indexOf("setConfirmed(true)");
  assert.ok(materialize > 0 && confirmed > 0, "both calls are present in the flow");
  assert.ok(materialize < confirmed, "the ledger is written before the confirmation screen");
});
