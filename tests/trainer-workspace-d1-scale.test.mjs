/*
 * Staging E2E 36243387701 (commit 7dd8f5c): /trainer sat on "Loading trainer workspace…" and the partner app
 * home read "No assigned jobs · 0 · 0" for a paid, assigned Training booking. Staging served a D1 round trip in
 * ~0.3 s, and both reads grew with the trainer's work:
 *
 *   GET /api/training-sessions  one events query per listed session       (9 + S calls)
 *   GET /api/partner-jobs       the same, plus 3 queries per booking      (~23 + S + 3B calls)
 *
 * These tests drive the real routes against a real SQLite engine through ONE persistent counting D1 binding
 * (the ensure* helpers memoise per binding, so a fresh wrapper per request would bury the per-row cost in DDL)
 * and hold three properties: the call count does not move when the trainer's sessions and bookings grow, the
 * batched reads return exactly what the per-session and per-booking reads returned, and one booking's
 * projection is unchanged by the others sharing its batch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshWorld, seedBooking, sessionCookie, routeCall, TRAINER, DB_GLOBAL } from "./helpers/training-lifecycle-harness.mjs";
import { enterWorkersDbScope } from "./helpers/module-hooks.mjs";

const { materializeTrainingBooking } = await import("../lib/training-programme.ts");
const { ensureTrainingSessionLifecycleTables, listTrainerSessions } = await import("../lib/training-session-lifecycle.ts");
const { projectTrainingSessionEvent } = await import("../lib/training-provider-projection.ts");
const { trainingBookingPaymentState, trainingBookingPaymentStates } = await import("../lib/training-payment-eligibility.ts");
const { ensureProviderCapacityTables } = await import("../lib/provider-capacity-governance.ts");
const sessionsRoute = await import("../app/api/training-sessions/route.ts");
const jobsRoute = await import("../app/api/partner-jobs/route.ts");

/** Counts D1 subrequests the way Workers bills them: every first/run/all/raw, and a batch as one. */
function countingBinding(world) {
  let calls = 0;
  const wrap = (statement) => ({
    sql: statement.sql, inner: statement,
    bind: (...args) => wrap(statement.bind(...args)),
    first: (...args) => { calls++; return statement.first(...args); },
    run: () => { calls++; return statement.run(); },
    all: () => { calls++; return statement.all(); },
    raw: () => { calls++; return statement.raw(); },
  });
  const db = {
    prepare: (sql) => wrap(world.db.prepare(sql)),
    batch: (list) => { calls++; return world.db.batch(list.map((item) => item.inner ?? item)); },
    exec: (sql) => { calls++; return world.db.exec(sql); },
  };
  enterWorkersDbScope(db);
  globalThis[DB_GLOBAL] = db;
  return { db, calls: () => calls, reset: () => { calls = 0; } };
}

async function measured(counter, run) {
  counter.reset();
  const response = await run();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { calls: counter.calls(), body: response.body };
}

/*
 * Events on every session as it is created. Ties in created_at (three per millisecond) are what the batched
 * read's rowid tiebreak must order exactly like the per-session "ORDER BY created_at DESC LIMIT 20" did; 33 on
 * some sessions proves the 20 cap is per session, not per batch.
 */
let sessionSeq = 0;
async function seedEvents(world, bookingId) {
  await ensureTrainingSessionLifecycleTables(world.db);
  const insert = world.sqlite.prepare("INSERT INTO training_session_events (id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const session of world.sqlite.prepare("SELECT id,programme_id,booking_id FROM training_sessions WHERE booking_id=? ORDER BY sequence_no").all(bookingId)) {
    const count = [33, 5, 0, 21, 1][sessionSeq++ % 5];
    for (let i = 0; i < count; i++) {
      insert.run(`EV-${session.id}-${i}`, session.id, session.programme_id, session.booking_id, ["accept", "on_the_way", "arrive", "save_report"][i % 4], "trainer:qa", `idem-${session.id}-${i}`, JSON.stringify({ action: "accept", from: "scheduled", to: "accepted", distanceMeters: i }), 1_700_000_000_000 + Math.floor(i / 3));
    }
  }
}

let bookingSeq = 0;
async function seedProgrammes(world, count, sessions, options = {}) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `SCALE-${++bookingSeq}`;
    seedBooking(world, { id, group: `${id}-G`, sessions, total: 1000 * sessions, dueNow: 500 * sessions, dayBase: bookingSeq * sessions, ...options });
    await materializeTrainingBooking(world.db, { bookingId: id, actorId: "qa" });
    await seedEvents(world, id);
    ids.push(id);
  }
  return ids;
}

/** The read listTrainerSessions made once per session before it was batched. */
const perSessionEvents = (world, sessionId) =>
  world.sqlite.prepare("SELECT event_type,actor_id,detail_json,created_at FROM training_session_events WHERE session_id=? ORDER BY created_at DESC LIMIT 20").all(sessionId).map((row) => ({ ...row }));

test("GET /api/training-sessions costs the same D1 calls for 5 and 40 sessions and returns each session's newest 20 events", async () => {
  const world = freshWorld();
  const counter = countingBinding(world);
  await seedProgrammes(world, 1, 5);
  const cookie = await sessionCookie(world.db, "provider", TRAINER);
  const read = () => measured(counter, () => routeCall(sessionsRoute.GET, "GET", `/api/training-sessions?providerId=${TRAINER}`, { cookie }));
  await read(); // first use per binding runs the memoised DDL
  const small = await read();
  assert.equal(small.body.data.length, 5);

  await seedProgrammes(world, 7, 5);
  const large = await read();
  assert.equal(large.body.data.length, 40);
  assert.equal(large.calls, small.calls, `D1 calls grew with the sessions (${small.calls} -> ${large.calls})`);
  assert.ok(large.calls <= 12, `GET /api/training-sessions used ${large.calls} D1 calls`);

  // The batched read is the per-session read, row for row, including created_at ties.
  const listed = await listTrainerSessions(world.db, TRAINER);
  assert.deepEqual(listed.map((session) => session.events), listed.map((session) => perSessionEvents(world, String(session.id))));
  for (const session of large.body.data) {
    assert.deepEqual(session.events, perSessionEvents(world, session.id).map(projectTrainingSessionEvent), session.id);
    assert.ok(session.events.length <= 20);
    assert.deepEqual(session.events.map((event) => event.createdAt), [...session.events.map((event) => event.createdAt)].sort((a, b) => b - a), "newest first");
  }
  const counts = large.body.data.map((session) => session.events.length);
  assert.ok(counts.includes(20) && counts.includes(0) && counts.includes(1) && counts.includes(5), counts.join(","));
  // The first programme's projection is untouched by the 35 sessions that joined its batch.
  assert.deepEqual(large.body.data.filter((session) => small.body.data.some((before) => before.id === session.id)), small.body.data);
});

test("GET /api/partner-jobs costs the same D1 calls for 3 and 20 bookings, returns the per-booking funding and omits unpaid Training", async () => {
  const world = freshWorld();
  const counter = countingBinding(world);
  await ensureProviderCapacityTables(world.db);
  world.sqlite.prepare("INSERT INTO provider_capacity_profiles(id,city_id,name,provider_model,services_json,zones_json,effective_from,status,live,updated_by,updated_at) VALUES (?,'blr','QA Trainer','full_time','[\"dog_training\"]','[\"blr-east\"]','2020-01-01','active',1,'qa',1)").run(TRAINER);
  const first = await seedProgrammes(world, 3, 2);
  // One of each funding shape: deposit attested (partial), fully paid, no governed quote at all (pending).
  world.sqlite.prepare("UPDATE training_quote_payment_attestations SET status='FULLY_PAID',amount=2000 WHERE quote_id=?").run(`TQ-${first[1]}`);
  world.sqlite.prepare("DELETE FROM training_booking_quote_links WHERE booking_id=?").run(first[2]);
  const cookie = await sessionCookie(world.db, "provider", TRAINER);
  const read = () => measured(counter, () => routeCall(jobsRoute.GET, "GET", `/api/partner-jobs?providerId=${TRAINER}`, { cookie }));
  await read(); // first use per binding runs the memoised DDL
  const small = await read();
  assert.deepEqual(small.body.jobs.map((job) => [job.bookingId, job.payment.status, job.payment.amountDueNow]), [
    [first[0], "partially_paid", 0], [first[0], "partially_paid", 0],
    [first[1], "captured", 0], [first[1], "captured", 0],
    [first[2], "pending", 1000], [first[2], "pending", 1000], // no quote: the booking's own due-now
  ]);

  const more = await seedProgrammes(world, 16, 2);
  const unpaid = await seedProgrammes(world, 1, 2, { status: "payment_pending" });
  const large = await read();
  assert.equal(large.calls, small.calls, `D1 calls grew with the bookings (${small.calls} -> ${large.calls})`);
  assert.ok(large.calls <= 30, `GET /api/partner-jobs used ${large.calls} D1 calls`);
  assert.equal(large.body.jobs.length, 2 * 19, "every session of the 19 funded bookings");
  assert.equal(large.body.jobs.some((job) => job.bookingId === unpaid[0]), false, "a payment_pending Training booking is not offered: its Accept is refused until paid");

  // The three original bookings project exactly as they did alone; batching mixed nothing across bookings.
  assert.deepEqual(large.body.jobs.filter((job) => first.includes(job.bookingId)), small.body.jobs);
  // The set-based funding read is the per-booking read, booking for booking (a missing booking included).
  const ids = [...first, ...more, ...unpaid, "NO-SUCH-BOOKING"];
  const batched = await trainingBookingPaymentStates(world.db, ids);
  assert.deepEqual([...batched.keys()].sort(), [...ids].sort());
  for (const id of ids) assert.deepEqual(batched.get(id), await trainingBookingPaymentState(world.db, id), id);
  assert.equal((await trainingBookingPaymentStates(world.db, [])).size, 0);
});
