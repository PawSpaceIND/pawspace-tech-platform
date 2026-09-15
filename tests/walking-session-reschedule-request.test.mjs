/*
 * Dog walking was the only vertical with no way to move a booked slot.
 *
 * /walking/manage offered "Request cancellation review" and nothing else, and /api/walking-lifecycle
 * implemented exactly one staff action (no_show) - so a customer who could not make Tuesday had to
 * cancel the whole six-walk block. Boarding and sitting reschedule a stay WINDOW through a commercial
 * re-quote, which does not transfer to a block of individual walks.
 *
 * This is the shape training already uses: the request is recorded against the ONE session, no money
 * moves and no capacity is re-held, and the walk does not move until PawSpace confirms it with the
 * walker. Everything below runs the real engine and reads the rows back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__WALK_RESCHEDULE_DB__");

const CUSTOMER = "CUS-WALK-1", PROVIDER = "walk_asha", BOOKING = "PS-UAT-WALK-1";
const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

async function world() {
  const harness = freshCountingD1();
  globalThis.__WALK_RESCHEDULE_DB__ = harness.db;
  const walking = await import("../lib/walking-lifecycle.ts");
  const { ensureCanonicalBookingCoreTables } = await import("../lib/canonical-booking-core-schema.ts");
  await ensureCanonicalBookingCoreTables(harness.db);
  const { ensureWalkingOpsTables } = await import("../lib/walking-ops-governance.ts");
  await ensureWalkingOpsTables(harness.db);
  await walking.ensureWalkingLifecycleTables(harness.db);
  const now = Date.now();
  harness.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(BOOKING, "idem-walk-1", CUSTOMER, "[]", "[]", "blr", "blr-east", "dog_walking", "walk-6", "Six walks", "SG-WALK-1", PROVIDER, future(2), future(2), "confirmed", "customer_app", 2094, "INR", "{}", CUSTOMER, now, now);
  const addSession = (id, occurrence, start, status) => harness.sqlite
    .prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, BOOKING, "SG-WALK-1", `RES-${id}`, PROVIDER, occurrence, start, start, status, now, now);
  addSession("WALK-S1", 1, future(2), "scheduled");
  addSession("WALK-S3", 3, future(-1), "completed");
  return { ...harness, walking };
}

const ask = (w, over = {}) => w.walking.mutateWalkingBooking(w.db, {
  bookingId: BOOKING, action: "request_session_reschedule", actorId: CUSTOMER,
  idempotencyKey: `resched-${Math.random()}`, sessionId: "WALK-S1",
  reason: "Family travel that Tuesday morning", requestedStart: future(5), ...over,
});
const events = (w) => w.sqlite.prepare("SELECT * FROM walking_session_events WHERE event_type='reschedule_requested'").all();

/**
 * The engine refuses with governedJsonError, i.e. it throws a Response - and assert.rejects(fn, /re/)
 * matches String(thrown), which for a Response is "[object Response]" and never matches anything.
 * So read the refusal the way a caller actually would.
 */
async function refusal(run) {
  try { await run(); } catch (error) {
    if (error instanceof Response) return { status: error.status, message: String((await error.clone().json())?.error ?? "") };
    return { status: Number(error?.statusCode ?? 0), message: String(error?.message ?? error) };
  }
  throw new Error("expected a refusal, the call succeeded");
}
const refuses = async (run, pattern) => assert.match((await refusal(run)).message, pattern);

test("WALK-RESCHED-1: a customer can ask to move one walk, and the walk does not move", async () => {
  const w = await world();
  const before = w.sqlite.prepare("SELECT scheduled_start,status FROM walking_sessions WHERE id='WALK-S1'").get();
  const result = await ask(w);
  assert.equal(result.sessionId, "WALK-S1");
  assert.match(result.outcome, /NOT moved yet/, "the customer must not be told their walk has moved");

  const after = w.sqlite.prepare("SELECT scheduled_start,status FROM walking_sessions WHERE id='WALK-S1'").get();
  assert.deepEqual(after, before, "nothing about the walk changes until PawSpace confirms it");

  const rows = events(w);
  assert.equal(rows.length, 1, "the request is recorded once, against that session");
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(rows[0].session_id, "WALK-S1");
  assert.equal(detail.reason, "Family travel that Tuesday morning");
  assert.ok(detail.requestedStart, "the preferred time reaches the people who will arrange it");
});

test("WALK-RESCHED-2: only a walk that can still be moved, and only one on this booking", async () => {
  const w = await world();
  await refuses(() => ask(w, { sessionId: "WALK-S3" }), /already completed/);
  await refuses(() => ask(w, { sessionId: "WALK-NOT-OURS" }), /not part of this booking/);
  await refuses(() => ask(w, { sessionId: "" }), /Choose which walk/);
  assert.equal(events(w).length, 0, "no refused request may leave a record behind");
});

test("WALK-RESCHED-3: it asks for a reason and a sane preferred time", async () => {
  const w = await world();
  await refuses(() => ask(w, { reason: "no" }), /why you need to move/);
  await refuses(() => ask(w, { requestedStart: "not-a-date" }), /not a valid date/);
  await refuses(() => ask(w, { requestedStart: future(-3) }), /in the future/);
  assert.equal(events(w).length, 0);
  // A customer with no particular preference may still ask.
  const result = await ask(w, { requestedStart: "" });
  assert.equal(result.requestedStart, null);
  assert.equal(events(w).length, 1);
});

test("WALK-RESCHED-4: a finished booking has no walk left to move", async () => {
  const w = await world();
  w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id=?").run(BOOKING);
  await refuses(() => ask(w), /already cancelled/);
  assert.equal(events(w).length, 0);
});

test("WALK-RESCHED-5: the customer screen offers the control and posts the real action", async () => {
  // The engine work above is unreachable unless /walking/manage actually offers it - which is the
  // whole shape of this defect class: a working API nothing calls.
  const source = await import("node:fs").then((fs) => fs.readFileSync("app/walking/manage/walking-customer-management.tsx", "utf8"));
  assert.match(source, /request_session_reschedule/, "the screen must post the real action");
  assert.match(source, /Move a single walk|Ask to move this walk/, "the control must be on the screen");
  assert.match(source, /has not moved yet|NOT moved yet|does not move until/i,
    "the copy must not tell the customer their walk has already moved");
  // Only walks that can still be moved may be offered.
  assert.match(source, /\["scheduled","assigned"\]\.includes/, "a completed walk must not be offered for rescheduling");
  // And the action is registered as a CUSTOMER action, not a staff one.
  const route = await import("node:fs").then((fs) => fs.readFileSync("app/api/walking-lifecycle/route.ts", "utf8"));
  assert.match(route, /customerActions=new Set<WalkingAction>\(\["request_session_reschedule"\]\)/);
  assert.match(route, /requireCustomerOwnership/, "a customer may only move a walk on their own booking");
  const gateway = await import("node:fs").then((fs) => fs.readFileSync("lib/api-gateway.ts", "utf8"));
  assert.match(gateway, /request_session_reschedule"\)return "scheduling\.book"/,
    "the gateway must let a customer permission reach it - bookings.view is a staff permission");
});
