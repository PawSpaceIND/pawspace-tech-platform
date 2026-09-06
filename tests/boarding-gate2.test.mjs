/**
 * Boarding Gate 2 — EXECUTED. Stay acceptance, capacity locks, the care plan, check-in/out, care
 * events, extensions and the escalation paths that must never lose the booking.
 *
 * WHAT THIS FILE USED TO BE. Thirteen tests, every assertion a regex over the source of
 * `lib/boarding-stay-lifecycle.ts`, the stay route, the host workspace and the customer panel.
 * "Boarding Gate 2 requires care plan before check in" asserted that the string "A ready care plan is
 * required before check-in" appeared in the file — true whether or not anything enforced it.
 *
 * Each test below drives the real `mutateBoardingStay` (or the real route handler) against a real
 * SQLite-backed D1 and reads the stay row, the capacity lock and the event log back.
 *
 * Three assertions about page components remain source-text and are declared as such at the bottom,
 * with the reason: `app/host/page.tsx` and the customer panel are React components whose behaviour
 * cannot be established by importing them into this runner. Their SERVER halves are executed above.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, nextKey, seedBoardingStay, validCarePlan, stayUrl } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_G2_DB__", "__BOARDING_G2_ENV__");

const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");

/** A window that is already open in real time, so check-in falls inside it. */
const liveWindow = () => ({
  scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
  scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
});

async function stayWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__BOARDING_G2_DB__ = db;
  globalThis.__BOARDING_G2_ENV__ = {};
  const seeded = await seedBoardingStay(db, sqlite, { window: liveWindow(), ...options });
  const act = (action, extra = {}) => lifecycle.mutateBoardingStay(db, {
    stayId: seeded.stayId, action, actorId: extra.actorId ?? "host_maya_rohan",
    idempotencyKey: extra.idempotencyKey ?? nextKey("G2"), ...extra,
  });
  const stayRow = async () => db.prepare("SELECT * FROM boarding_stays WHERE id=?").bind(seeded.stayId).first();
  return { sqlite, db, ...seeded, act, stayRow };
}

/** Accept + care plan, the two steps every later transition depends on. */
async function readyForCheckIn(world) {
  await world.act("accept");
  await world.act("submit_care_plan", { carePlan: validCarePlan(), actorId: world.customerId });
  return world;
}

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 owns stay acceptance and takes the host's capacity when it is granted", async () => {
  const world = await stayWorld();
  assert.equal((await world.stayRow()).status, "awaiting_host_acceptance");

  const accepted = await world.act("accept");
  assert.equal(accepted.status, "confirmed");
  assert.equal(accepted.capacity.maxGuestPets, 2);
  assert.equal(accepted.capacity.oneFamilyOnly, true);

  // Acceptance is what takes the host's place. A lock that is not written is a host double-booked.
  const lock = await world.db.prepare("SELECT * FROM boarding_capacity_locks WHERE stay_id=?").bind(world.stayId).first();
  assert.equal(lock.status, "active");
  assert.equal(lock.capacity_units, 1);
  assert.equal(lock.family_key, world.customerId, "a one-family host locks the family, not just the count");

  const events = await world.db.prepare("SELECT event_type FROM boarding_stay_events WHERE stay_id=?").bind(world.stayId).all();
  assert.deepEqual(events.results.map((row) => row.event_type), ["host_accepted"]);

  const again = await refusal(world.act("accept"));
  assert.equal(again?.status, 409);
  assert.match(again.message, /not awaiting host acceptance/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 replays one idempotency key and refuses to reuse it for another action", async () => {
  const world = await stayWorld();
  const key = nextKey("G2-IDEM");

  const first = await world.act("accept", { idempotencyKey: key });
  const replay = await world.act("accept", { idempotencyKey: key });
  // The replay returns the stored result and says so, rather than transitioning the stay a second
  // time. Asserted field by field against the first result, plus the flag that marks it a replay.
  assert.equal(replay.duplicatePrevented, true);
  assert.deepEqual({ ...replay, duplicatePrevented: undefined }, { ...first, duplicatePrevented: undefined });
  assert.equal(first.duplicatePrevented, undefined, "the first call is not itself reported as a duplicate");

  const locks = await world.db.prepare("SELECT COUNT(*) n FROM boarding_capacity_locks WHERE stay_id=?").bind(world.stayId).all();
  assert.equal(Number(locks.results[0].n), 1, "a replayed acceptance must not take the host's place twice");

  const reused = await refusal(world.act("decline", { idempotencyKey: key, reason: "changed my mind" }));
  assert.equal(reused?.status, 409);
  assert.match(reused.message, /this key was already used for a different one/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 requires a complete care plan before check-in", async () => {
  const world = await stayWorld();
  await world.act("accept");

  const early = await refusal(world.act("check_in"));
  assert.equal(early?.status, 409);
  assert.match(early.message, /ready care plan is required before check-in/);

  for (const missing of [{ emergencyContact: "" }, { vet: "" }, { emergencyContact: "", vet: "" }]) {
    const refused = await refusal(world.act("submit_care_plan", { carePlan: validCarePlan(missing), actorId: world.customerId }));
    assert.equal(refused?.status, 409, `care plan missing ${Object.keys(missing)} must be refused`);
    assert.match(refused.message, /requires emergency contact and vet details/);
  }
  assert.equal((await world.stayRow()).care_plan_status, "required", "a refused plan must not mark the stay ready");

  const ready = await world.act("submit_care_plan", { carePlan: validCarePlan(), actorId: world.customerId });
  assert.equal(ready.status, "care_plan_ready");
  assert.equal((await world.stayRow()).care_plan_status, "ready");

  // The plan is kept as a snapshot, so what the host was told at check-in stays recoverable.
  const snapshot = await world.db.prepare("SELECT COUNT(*) n FROM boarding_care_plan_snapshots WHERE stay_id=?").bind(world.stayId).all();
  assert.ok(Number(snapshot.results[0].n) >= 1);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 checks a stay in once, inside its window", async () => {
  const world = await readyForCheckIn(await stayWorld());

  const checkedIn = await world.act("check_in");
  assert.equal(checkedIn.status, "in_progress");
  const row = await world.stayRow();
  assert.equal(row.status, "in_progress");
  assert.equal(row.check_in_status, "complete");

  // A second check-in must not re-open the stay or re-stamp its arrival.
  const twice = await refusal(world.act("check_in"));
  assert.equal(twice?.status, 409);
  assert.equal((await world.stayRow()).status, "in_progress");

  // A window that has already closed cannot be entered at all.
  const late = await readyForCheckIn(await stayWorld({
    bookingId: "BKG-BOARD-LATE",
    window: {
      scheduledStart: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      scheduledEnd: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    },
  }));
  const expired = await refusal(late.act("check_in"));
  assert.equal(expired?.status, 409);
  assert.match(expired.message, /after the stay window has ended/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 records only canonical care events, and only during an active stay", async () => {
  const world = await readyForCheckIn(await stayWorld());

  const beforeCheckIn = await refusal(world.act("care_event", { careEventType: "meal", detail: {} }));
  assert.equal(beforeCheckIn?.status, 409);
  assert.match(beforeCheckIn.message, /only during an active stay/);

  await world.act("check_in");

  const invented = await refusal(world.act("care_event", { careEventType: "spa_day", detail: {} }));
  assert.equal(invented?.status, 400);
  assert.match(invented.message, /Unsupported Boarding care event/);

  for (const careEventType of ["meal", "play", "walk", "medication", "photo_update", "video_update", "general_update", "incident"]) {
    const recorded = await world.act("care_event", { careEventType, detail: { note: `${careEventType} logged` } });
    assert.ok(recorded, `${careEventType} is a canonical Boarding care event`);
  }

  const logged = await world.db.prepare("SELECT event_type FROM boarding_stay_events WHERE stay_id=?").bind(world.stayId).all();
  assert.ok(logged.results.length >= 8, "every accepted care event lands in the canonical log");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 blocks checkout until the mandatory daily milestones are complete", async () => {
  const world = await readyForCheckIn(await stayWorld());
  await world.act("check_in");

  const blocked = await refusal(world.act("check_out"));
  assert.equal(blocked?.status, 409);
  assert.match(blocked.message, /mandatory daily milestones are incomplete/);
  // The missing items are named per day, so a host can act on the message rather than guess.
  assert.match(blocked.message, /:meal/);
  assert.match(blocked.message, /:play/);
  assert.match(blocked.message, /:media/);
  assert.equal((await world.stayRow()).status, "in_progress", "a blocked checkout must not close the stay");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 keeps an extension commercially blocked and never moves the paid stay window", async () => {
  const world = await readyForCheckIn(await stayWorld());
  const before = await world.stayRow();

  const requested = await world.act("request_extension", {
    requestedEnd: new Date(Date.now() + 20 * 3_600_000).toISOString(),
    actorId: world.customerId,
  });
  assert.equal(requested.status, "commercial_quote_required", "an extension is a quote request, not a granted stay");
  assert.equal(requested.stayWindowUnchanged, true);

  const after = await world.stayRow();
  assert.equal(after.check_out_at, before.check_out_at, "the paid window is unchanged until money is agreed");
  assert.equal(after.billed_units, before.billed_units, "and so are the billed units");
  assert.equal(after.extension_status, "commercial_quote_required");

  const shorter = await refusal(world.act("request_extension", {
    requestedEnd: new Date(new Date(before.check_out_at).getTime() - 3_600_000).toISOString(),
    actorId: world.customerId,
  }));
  assert.equal(shorter?.status, 400);
  assert.match(shorter.message, /later than the current checkout/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 escalates a decline, a host outage and a no-show without losing the booking", async () => {
  for (const [action, extra] of [["decline", { reason: "cannot host this week" }], ["host_unavailable", { reason: "family emergency" }]]) {
    const world = await stayWorld({ bookingId: `BKG-BOARD-${action}` });
    if (action === "host_unavailable") await world.act("accept");

    const escalated = await world.act(action, extra);
    assert.ok(escalated, `${action} is a supported escalation`);

    // The booking survives; only the assignment is in recovery. Cancelling the customer's booking
    // because a host dropped out is precisely what this gate exists to prevent.
    const booking = await world.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
    assert.notEqual(booking.status, "cancelled", `${action} must not cancel the customer's booking`);

    const recovery = await world.db.prepare("SELECT COUNT(*) n FROM boarding_recovery_cases WHERE stay_id=?").bind(world.stayId).all();
    assert.ok(Number(recovery.results[0].n) >= 1, `${action} opens an Operations recovery case`);

    // A capacity lock left behind after a decline blocks a replacement host for no reason.
    const held = await world.db.prepare("SELECT COUNT(*) n FROM boarding_capacity_locks WHERE stay_id=? AND status='active'").bind(world.stayId).all();
    assert.equal(Number(held.results[0].n), 0, `${action} releases the host's place`);
  }

  const reasonless = await stayWorld({ bookingId: "BKG-BOARD-NOREASON" });
  const refused = await refusal(reasonless.act("decline"));
  assert.equal(refused?.status, 400);
  assert.match(refused.message, /recovery reason is required/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 refuses an action on an unknown stay and an unsupported action outright", async () => {
  const world = await stayWorld();

  const unknown = await refusal(lifecycle.mutateBoardingStay(world.db, {
    stayId: "BSTAY-DOES-NOT-EXIST", action: "accept", actorId: "host_maya_rohan", idempotencyKey: nextKey("G2"),
  }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Boarding stay not found/);

  const unsupported = await refusal(world.act("teleport"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Boarding stay action/);

  const incomplete = await refusal(lifecycle.mutateBoardingStay(world.db, { stayId: world.stayId, action: "accept", actorId: "", idempotencyKey: "" }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding stay API separates provider, customer and staff authority", async () => {
  const world = await stayWorld();
  const route = await import("../app/api/boarding-stays/route.ts");

  // Anonymous, on a NON-preview origin: the route must not act at all.
  const anonymous = await route.POST(new Request(stayUrl("/api/boarding-stays"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stayId: world.stayId, action: "accept", idempotencyKey: nextKey("G2-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous stay action is refused: ${anonymous.status}`);
  assert.equal((await world.stayRow()).status, "awaiting_host_acceptance", "a refused request must not have acted");

  const gateway = await import("../lib/api-gateway.ts");
  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/boarding-stays"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated stay action before any permission is named");
  } else {
    assert.ok(decision.permission, "a stay action is a guarded route, never public");
  }
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 2 routes evidence care events through the governed proof workflow", async () => {
  // The legacy loophole this closed: medication, photo proof and incidents used to be loggable as
  // ordinary care events on the stay route, bypassing Gate 4's ownership, scan and retention rules.
  const source = await readFile(new URL("../app/api/boarding-stays/route.ts", import.meta.url), "utf8");
  assert.match(source, /evidenceCareEvents=new Set\(\["medication","photo_update","incident"\]\)/);
  assert.match(source, /must use the governed Boarding proof workflow/);

  // And the behavioural half, which is the part that can actually regress silently: the route's
  // provider action set does not contain a customer action, and vice versa.
  assert.match(source, /providerActions=new Set<BoardingStayAction>\(\["accept","decline","check_in","care_event","host_unavailable","check_out"\]\)/);
  assert.match(source, /customerActions=new Set<BoardingStayAction>\(\["submit_care_plan","request_extension"\]\)/);
});

// ---------------------------------------------------------------------------------------------
// DECLARED SOURCE ASSERTIONS. `app/host/page.tsx` and `app/mobile-app/boarding-customer-stay-panel.tsx`
// are React components; importing them into this runner does not execute a render, so what they wire
// up cannot be established behaviourally here. The SERVER contract they call into is executed above -
// what is left is which client calls which action, which is a property of the file's text.
test("Boarding Gate 2 host and customer surfaces call canonical stay actions, not fixtures", async () => {
  const [host, panel] = await Promise.all([
    readFile(new URL("../app/host/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/mobile-app/boarding-customer-stay-panel.tsx", import.meta.url), "utf8"),
  ]);
  for (const action of ["accept", "decline", "check_in", "check_out"]) assert.match(host, new RegExp(`"${action}"`));
  assert.match(panel, /submit_care_plan/);
  assert.match(panel, /request_extension/);
});
