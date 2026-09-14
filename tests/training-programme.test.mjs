/*
 * Training programme materialization, executed against a real database.
 *
 * This file used to read lib/training-programme.ts and the route as text and assert that strings
 * like `booking_id TEXT NOT NULL UNIQUE` and `requireCustomerOwnership(` appeared in them. A string
 * being present proves nothing about what the module does when it runs: the UNIQUE constraint could
 * be on the wrong table, the ownership check could sit after the write, and every regex still passes.
 *
 * Each case below drives the REAL module or route handler against SQLite through the D1 adapter and
 * reads the persisted rows back. Sabotage-verified: removing the occurrence-uniqueness guard, the
 * provider-match guard or the ownership check in the route turns the corresponding case red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  freshWorld, seedBooking, seedReservation, sessionCookie, routeCall,
  TRAINER, OTHER_TRAINER, CUSTOMER, OTHER_CUSTOMER, sessionStart, sessionEnd, ORIGIN,
} from "./helpers/training-lifecycle-harness.mjs";

const { materializeTrainingProgramme, readTrainingProgramme, ensureTrainingProgrammeTables } = await import("../lib/training-programme.ts");
const programmesRoute = await import("../app/api/training-programmes/route.ts");

const refusal = async (promise, status, pattern) => {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof Response, `expected a Response refusal, got ${caught?.constructor?.name ?? typeof caught}`);
  assert.equal(caught.status, status);
  assert.match(await caught.text(), pattern);
};

// --- lib/training-programme.ts -------------------------------------------------------------------

test("Training materializes one programme and one canonical row per reserved session, and replay adds nothing", async () => {
  const world = freshWorld();
  seedBooking(world, { id: "B1", group: "G1", sessions: 4 });
  const first = await materializeTrainingProgramme(world.db, { bookingId: "B1", actorId: "customer:cus_t1" });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_programmes WHERE booking_id='B1'").get().n, 1);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_sessions WHERE booking_id='B1'").get().n, 4, "exactly one session row per reservation");
  assert.deepEqual(first.sessions.map((s) => Number(s.sequence_no)), [1, 2, 3, 4]);
  assert.deepEqual(first.sessions.map((s) => s.schedule_reservation_id), ["R-B1-1", "R-B1-2", "R-B1-3", "R-B1-4"], "each session is bound to its own reservation");
  assert.deepEqual(first.sessions.map((s) => s.status), ["scheduled", "locked", "locked", "locked"], "only the first session is runnable");
  assert.ok(first.sessions.every((s) => s.provider_id === TRAINER));
  assert.equal(Number(first.programme.total_sessions), 4);
  assert.deepEqual(JSON.parse(first.programme.requirements_json), ["Use hand signals"], "canonical requirements are carried onto the programme");
  const event = world.sqlite.prepare("SELECT event_type,actor_id,detail_json FROM training_programme_events WHERE booking_id='B1'").get();
  assert.equal(event.event_type, "programme_materialized");
  assert.equal(event.actor_id, "customer:cus_t1");
  assert.equal(JSON.parse(event.detail_json).sessionCount, 4);

  const replay = await materializeTrainingProgramme(world.db, { bookingId: "B1", actorId: "customer:cus_t1" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_sessions").get().n, 4, "replay must not duplicate sessions");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_programme_events").get().n, 1, "replay must not log a second materialization");
  const read = await readTrainingProgramme(world.db, "B1");
  assert.equal(read.sessions.length, 4);
});

test("the real schema refuses a second programme per booking, a reused reservation and a duplicate sequence number", async () => {
  const world = freshWorld();
  seedBooking(world, { id: "B1", group: "G1", sessions: 2 });
  const { programme, sessions } = await materializeTrainingProgramme(world.db, { bookingId: "B1", actorId: "uat" });
  const now = Date.now();
  assert.throws(
    () => world.sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,total_sessions,created_at,updated_at) VALUES ('TP-DUP','B1',?,?,'blr','blr-east','x','x','[]',2,?,?)").run(CUSTOMER, TRAINER, now, now),
    /UNIQUE constraint failed: training_programmes\.booking_id/,
  );
  assert.throws(
    () => world.sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('TS-DUP',?,'B1',?,9,?,?,?,?,?)").run(programme.id, sessions[0].schedule_reservation_id, TRAINER, sessionStart(5), sessionEnd(5), now, now),
    /UNIQUE constraint failed: training_sessions\.schedule_reservation_id/,
  );
  assert.throws(
    () => world.sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('TS-DUP',?,'B1','R-FRESH',1,?,?,?,?,?)").run(programme.id, TRAINER, sessionStart(5), sessionEnd(5), now, now),
    /UNIQUE constraint failed: training_sessions\.programme_id, training_sessions\.sequence_no/,
  );
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_sessions").get().n, 2);
});

test("only a dog_training booking with consistent reservations can become a programme", async () => {
  const world = freshWorld();
  seedBooking(world, { id: "GROOM", group: "G-GROOM", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic", sessions: 1 });
  await refusal(materializeTrainingProgramme(world.db, { bookingId: "GROOM", actorId: "uat" }), 404, /Canonical Training booking not found/);

  seedBooking(world, { id: "MEET", group: "G-MEET", packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet", sessions: 1 });
  await refusal(materializeTrainingProgramme(world.db, { bookingId: "MEET", actorId: "uat" }), 409, /assessment booking, not a Training programme/);

  seedBooking(world, { id: "NORES", group: "G-NORES", sessions: 2, reservations: false });
  await refusal(materializeTrainingProgramme(world.db, { bookingId: "NORES", actorId: "uat" }), 409, /requires scheduled session reservations/);

  seedBooking(world, { id: "SWAP", group: "G-SWAP", sessions: 2, reservations: false });
  seedReservation(world, { id: "R-SWAP-1", group: "G-SWAP", occurrence: 1, start: sessionStart(0), end: sessionEnd(0) });
  seedReservation(world, { id: "R-SWAP-2", group: "G-SWAP", provider: OTHER_TRAINER, occurrence: 2, start: sessionStart(1), end: sessionEnd(1) });
  await refusal(materializeTrainingProgramme(world.db, { bookingId: "SWAP", actorId: "uat" }), 409, /provider does not match the canonical booking/);

  seedBooking(world, { id: "DUPOCC", group: "G-DUPOCC", sessions: 2, reservations: false });
  seedReservation(world, { id: "R-DUPOCC-1", group: "G-DUPOCC", occurrence: 1, start: sessionStart(0), end: sessionEnd(0) });
  seedReservation(world, { id: "R-DUPOCC-2", group: "G-DUPOCC", occurrence: 1, start: sessionStart(1), end: sessionEnd(1) });
  await refusal(materializeTrainingProgramme(world.db, { bookingId: "DUPOCC", actorId: "uat" }), 409, /occurrence numbers must be unique/);

  // A cancelled reservation is not a session: the programme is sized by what is actually held.
  seedBooking(world, { id: "PARTIAL", group: "G-PARTIAL", sessions: 3, reservations: false });
  seedReservation(world, { id: "R-PARTIAL-1", group: "G-PARTIAL", occurrence: 1, start: sessionStart(0), end: sessionEnd(0) });
  seedReservation(world, { id: "R-PARTIAL-2", group: "G-PARTIAL", occurrence: 2, start: sessionStart(1), end: sessionEnd(1), status: "cancelled" });
  seedReservation(world, { id: "R-PARTIAL-3", group: "G-PARTIAL", occurrence: 3, start: sessionStart(2), end: sessionEnd(2) });
  const partial = await materializeTrainingProgramme(world.db, { bookingId: "PARTIAL", actorId: "uat" });
  assert.deepEqual(partial.sessions.map((s) => Number(s.sequence_no)), [1, 3]);
  assert.equal(Number(partial.programme.total_sessions), 2);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_programmes").get().n, 1, "every refused booking left no programme behind");
});

test("a Meet & Greet links to a programme only when it belongs to the same customer and is a live assessment", async () => {
  const world = freshWorld();
  seedBooking(world, { id: "PROG", group: "G-PROG", sessions: 2 });
  seedBooking(world, { id: "MEET-OTHER", group: "G-MEET-OTHER", customer: OTHER_CUSTOMER, packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet", sessions: 1 });
  seedBooking(world, { id: "MEET-CANCELLED", group: "G-MEET-CANCELLED", packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet", sessions: 1, status: "cancelled" });
  seedBooking(world, { id: "NOT-MEET", group: "G-NOT-MEET", sessions: 1 });
  seedBooking(world, { id: "MEET-OK", group: "G-MEET-OK", packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet", sessions: 1 });
  for (const meetBookingId of ["MEET-OTHER", "MEET-CANCELLED", "NOT-MEET", "MEET-MISSING"]) {
    await refusal(materializeTrainingProgramme(world.db, { bookingId: "PROG", meetBookingId, actorId: "uat" }), 409, /Meet & Greet does not belong to this Training customer\/programme/);
  }
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_programmes").get().n, 0, "a refused link writes nothing");
  const linked = await materializeTrainingProgramme(world.db, { bookingId: "PROG", meetBookingId: "MEET-OK", actorId: "uat" });
  assert.equal(linked.programme.meet_booking_id, "MEET-OK");
  assert.equal(JSON.parse(world.sqlite.prepare("SELECT detail_json FROM training_programme_events WHERE booking_id='PROG'").get().detail_json).meetBookingId, "MEET-OK");
});

// --- app/api/training-programmes/route.ts ---------------------------------------------------------

test("the programme route is customer-owned: the booking's customer materializes and reads, nobody else does", async () => {
  const world = freshWorld();
  seedBooking(world, { id: "B1", group: "G1", sessions: 3 });
  seedBooking(world, { id: "GROOM", group: "G-GROOM", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic", sessions: 1 });
  await ensureTrainingProgrammeTables(world.db); // so "nothing was written" can be read back after refusals that never reach the module
  const owner = await sessionCookie(world.db, "customer", CUSTOMER);
  const stranger = await sessionCookie(world.db, "customer", OTHER_CUSTOMER);
  const provider = await sessionCookie(world.db, "provider", TRAINER);

  const missing = await routeCall(programmesRoute.POST, "POST", "/api/training-programmes", { body: {}, cookie: owner });
  assert.equal(missing.status, 400);

  const foreign = await routeCall(programmesRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: "B1" }, cookie: stranger });
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  const asProvider = await routeCall(programmesRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: "B1" }, cookie: provider });
  assert.equal(asProvider.status, 403, "a provider session holds no scheduling.book permission");
  const anonymous = await routeCall(programmesRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: "B1" } });
  assert.ok([401, 403].includes(anonymous.status), `anonymous callers are refused: ${anonymous.status}`);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_programmes").get().n, 0, "no refused caller materialized anything");

  const notTraining = await routeCall(programmesRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: "GROOM" }, cookie: owner });
  assert.equal(notTraining.status, 409, JSON.stringify(notTraining.body));

  const created = await routeCall(programmesRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: "B1" }, cookie: owner });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.sessions.length, 3);
  assert.equal(created.body.data.duplicatePrevented, false);
  const replay = await routeCall(programmesRoute.POST, "POST", "/api/training-programmes", { body: { bookingId: "B1" }, cookie: owner });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);

  const read = await routeCall(programmesRoute.GET, "GET", "/api/training-programmes?bookingId=B1", { cookie: owner });
  assert.equal(read.status, 200);
  assert.equal(read.body.data.programme.booking_id, "B1");
  const readForeign = await routeCall(programmesRoute.GET, "GET", "/api/training-programmes?bookingId=B1", { cookie: stranger });
  assert.equal(readForeign.status, 403);

  // Audit ids are random, so the two rows are compared as a set rather than in insertion order.
  const audits = world.sqlite.prepare("SELECT outcome,detail_json FROM security_audit_events WHERE action='training.programme.materialize' AND resource_id='B1'").all();
  assert.equal(audits.length, 2, "both the creation and the replay are audited");
  assert.deepEqual(audits.map((row) => JSON.parse(row.detail_json).duplicatePrevented).sort(), [false, true]);
  assert.deepEqual(audits.map((row) => row.outcome), ["completed", "completed"]);
});

test("the session gateway scopes /api/training-programmes to a customer session with scheduling.book", async () => {
  const world = freshWorld();
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const customer = await sessionCookie(world.db, "customer", CUSTOMER);
  const provider = await sessionCookie(world.db, "provider", TRAINER);
  for (const method of ["GET", "POST"]) {
    const access = await authorizePlatformSessionRequest(new Request(`${ORIGIN}/api/training-programmes?bookingId=B1`, { method, headers: { cookie: customer, origin: ORIGIN } }), world.db);
    assert.ok(access && !(access instanceof Response), `${method}: a customer session is admitted`);
    assert.equal(access.permission, "scheduling.book");
    assert.equal(access.actor.roleCode, "customer");
    const refused = await authorizePlatformSessionRequest(new Request(`${ORIGIN}/api/training-programmes?bookingId=B1`, { method, headers: { cookie: provider, origin: ORIGIN } }), world.db);
    assert.ok(refused instanceof Response, `${method}: a provider session is not a customer`);
    assert.equal(refused.status, 403);
  }
  const noSession = await authorizePlatformSessionRequest(new Request(`${ORIGIN}/api/training-programmes?bookingId=B1`), world.db);
  assert.equal(noSession, null, "without a session the gateway defers to the staff path");
});

// --- lib/training-programme-client.ts -------------------------------------------------------------

test("the customer client materializes and loads the programme through the governed route", async () => {
  const { materializeTrainingProgramme: materializeClient, loadTrainingProgramme } = await import("../lib/training-programme-client.ts");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
    if (calls.length === 1) return Response.json({ data: { programme: { id: "TP-1", booking_id: "B1" }, sessions: [{ id: "TS-1" }], events: [], duplicatePrevented: false } });
    if (calls.length === 2) return Response.json({ data: { programme: { id: "TP-1", booking_id: "B1" }, sessions: [{ id: "TS-1" }], events: [] } });
    return Response.json({ error: "Training programme has not been materialized" }, { status: 404 });
  };
  try {
    const created = await materializeClient({ bookingId: "B1", meetBookingId: "MEET-1" });
    assert.equal(created.programme.id, "TP-1");
    assert.deepEqual(calls[0], { url: "/api/training-programmes", method: "POST", body: { bookingId: "B1", meetBookingId: "MEET-1" } });
    const loaded = await loadTrainingProgramme("B 1/x");
    assert.equal(loaded.sessions.length, 1);
    assert.equal(calls[1].url, "/api/training-programmes?bookingId=B%201%2Fx", "the booking id is URL-encoded");
    await assert.rejects(loadTrainingProgramme("B1"), /Training programme has not been materialized/, "the server's reason is surfaced, not swallowed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/*
 * One residual source pin. The customer confirmation screen must materialize the programme BEFORE it
 * shows success; that ordering lives in a React component and no server call can observe it. Kept
 * deliberately narrow: the behaviour behind the call is proven above by executing the route.
 */
test("the customer confirmation screen materializes the programme before it shows success", () => {
  const flow = readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");
  const materialize = flow.indexOf("materializeTrainingProgramme(");
  const confirmed = flow.indexOf("setConfirmed(true)");
  assert.ok(materialize > 0 && confirmed > 0, "both calls must exist");
  assert.ok(materialize < confirmed, "success is shown only after the programme ledger exists");
});
