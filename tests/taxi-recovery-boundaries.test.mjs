import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, nextKey, refusal, seedCanonicalTrip, taxiUrl } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_RECOVERY_BOUNDARY_DB__", "__TAXI_RECOVERY_BOUNDARY_ENV__");
const taxi = await import("../lib/taxi-lifecycle.ts");
const route = await import("../app/api/taxi-lifecycle/route.ts");

async function world({ bookingStatus = "confirmed", tripStatus = "scheduled", pickupStatus = "pending", sqlite = freshSqlite() } = {}) {
  const db = makeD1(sqlite);
  globalThis.__TAXI_RECOVERY_BOUNDARY_DB__ = db;
  globalThis.__TAXI_RECOVERY_BOUNDARY_ENV__ = { NODE_ENV: "test", PAWSPACE_PAYMENT_ENV: "sandbox" };
  const trip = seedCanonicalTrip(sqlite, { tripStatus, pickupStatus });
  sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id=?").run(bookingStatus, trip.bookingId);
  await taxi.ensureTaxiLifecycleTables(db);
  const fleet = await import("../lib/taxi-fleet-governance.ts");
  await fleet.ensureTaxiFleetTables(db);
  sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('FLEET-1','VEH-1',?,'QUOTE-1',?,?,?,'confirmed',?,?)")
    .run(trip.providerId, trip.bookingId, trip.scheduledStart, trip.scheduledEnd, Date.now(), Date.now());
  return { sqlite, db, trip };
}

const recover = (w, action, key = nextKey(action)) => taxi.mutateTaxiBooking(w.db, {
  bookingId: w.trip.bookingId, action, actorId: "driver:taxi_rahul", idempotencyKey: key, reason: "Driver unable to serve",
});
function snapshot(w) {
  return Object.fromEntries(["canonical_bookings", "taxi_trips", "provider_work_orders", "scheduling_reservations",
    "scheduling_assignment_decisions", "provider_assignment_offers", "taxi_fleet_reservations", "taxi_recovery_cases",
    "taxi_trip_events", "taxi_customer_notifications", "taxi_trip_action_keys"].map(table => [table, w.sqlite.prepare(`SELECT * FROM ${table}`).all()]));
}

for (const action of ["decline", "driver_unavailable", "no_show"]) {
  for (const bookingStatus of ["cancelled", "refunded", "completed"]) {
    test(`${action} cannot resurrect a ${bookingStatus} booking with a stale scheduled trip`, async () => {
      const w = await world({ bookingStatus }), before = snapshot(w);
      const rejected = await refusal(recover(w, action));
      assert.equal(rejected?.status, 409);
      assert.equal(JSON.parse(rejected.message).code, "taxi_booking_closed");
      assert.deepEqual(snapshot(w), before);
      w.sqlite.close();
    });
  }
  for (const state of [{ tripStatus: "pickup_confirmed", pickupStatus: "uat_confirmed" },
    { tripStatus: "vehicle_assigned", pickupStatus: "uat_confirmed" }, { tripStatus: "in_progress" }]) {
    test(`${action} cannot release a handed-over pet (${state.tripStatus})`, async () => {
      const w = await world({ bookingStatus: "assigned", ...state }), before = snapshot(w);
      const rejected = await refusal(recover(w, action));
      assert.equal(rejected?.status, 409);
      assert.equal(JSON.parse(rejected.message).code, "taxi_recovery_requires_incident");
      assert.deepEqual(snapshot(w), before);
      w.sqlite.close();
    });
  }
  for (const tripStatus of ["cancelled", "refunded", "completed"]) {
    test(`${action} cannot recover a ${tripStatus} trip with a stale confirmed booking`, async () => {
      const w = await world({ tripStatus }), before = snapshot(w);
      const rejected = await refusal(recover(w, action));
      assert.equal(rejected?.status, 409);
      assert.equal(JSON.parse(rejected.message).code, "taxi_booking_closed");
      assert.deepEqual(snapshot(w), before);
      w.sqlite.close();
    });
  }
}

for (const tripStatus of ["accepted", "vehicle_assigned"]) {
  test(`pre-pickup recovery releases capacity for an assigned ${tripStatus} trip`, async () => {
    const w = await world({ bookingStatus: "assigned", tripStatus });
    assert.equal((await recover(w, "driver_unavailable")).status, "ops_escalation");
    assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings").get().status, "reassignment_needed");
    assert.equal(w.sqlite.prepare("SELECT status FROM taxi_trips").get().status, "recovery_pending");
    assert.equal(w.sqlite.prepare("SELECT status FROM provider_work_orders").get().status, "recovery_pending");
    assert.equal(w.sqlite.prepare("SELECT status FROM scheduling_reservations").get().status, "cancelled");
    assert.equal(w.sqlite.prepare("SELECT status FROM taxi_fleet_reservations").get().status, "released");
    w.sqlite.close();
  });
}

test("one pre-pickup recovery survives an exact retry and refuses a fresh-key duplicate", async () => {
  const w = await world(), key = nextKey("decline");
  const result = await recover(w, "decline", key);
  assert.equal(result.status, "ops_escalation");
  const before = snapshot(w);
  const replay = await recover(w, "decline", key);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.recoveryId, result.recoveryId);
  assert.deepEqual(snapshot(w), before);
  const duplicate = await refusal(recover(w, "driver_unavailable"));
  assert.equal(duplicate?.status, 409);
  assert.equal(JSON.parse(duplicate.message).code, "taxi_recovery_not_available");
  assert.deepEqual(snapshot(w), before);
  w.sqlite.close();
});

test("a failure after booking/trip updates rolls back every recovery output and permits retry", async () => {
  const w = await world(), key = nextKey("interrupted"), before = snapshot(w);
  w.db.onSql("UPDATE provider_work_orders SET status='recovery_pending'", () => { throw new Error("injected interruption"); });
  await assert.rejects(recover(w, "decline", key), /injected interruption/);
  assert.deepEqual(snapshot(w), before);
  assert.equal((await recover(w, "decline", key)).status, "ops_escalation");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_recovery_cases").get().n, 1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_customer_notifications").get().n, 2);
  w.sqlite.close();
});

// Two connections share a file. Pause the stale caller BEFORE BEGIN IMMEDIATE so the winner
// commits independently. This is a real durable ordering, with no nested/shared transaction.
for (const sameKey of [false, true]) {
  test(`two connections commit one recovery with ${sameKey ? "the same" : "fresh"} concurrent keys`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "taxi-recovery-")), path = join(dir, "db.sqlite");
    const first = new DatabaseSync(path), second = new DatabaseSync(path);
    try {
      const w = await world({ sqlite: first }), other = { ...w, db: makeD1(second) };
      const key = nextKey("parallel"), winnerKey = sameKey ? key : nextKey("parallel-winner");
      const originalBatch = w.db.batch;
      let release, reached;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { reached = resolve; });
      w.db.batch = async statements => {
        // Only the recovery's 12-statement commit is paused; schema setup still runs normally.
        if (statements.length === 12) { reached(); await gate; }
        return originalBatch(statements);
      };
      const stale = recover(w, "decline", key);
      await ready;
      const winner = await recover(other, "decline", winnerKey), committed = snapshot(other);
      release();
      if (sameKey) {
        const replay = await stale;
        assert.equal(replay.duplicatePrevented, true);
        assert.equal(replay.recoveryId, winner.recoveryId);
      } else {
        const rejected = await refusal(stale);
        assert.equal(rejected?.status, 409);
        assert.equal(JSON.parse(rejected.message).code, "taxi_recovery_stale");
      }
      assert.deepEqual(snapshot(w), committed);
      assert.equal(first.prepare("SELECT COUNT(*) n FROM taxi_recovery_cases").get().n, 1);
      assert.equal(first.prepare("SELECT COUNT(*) n FROM taxi_trip_action_keys").get().n, 1);
      assert.equal(first.prepare("SELECT COUNT(*) n FROM taxi_customer_notifications").get().n, 2);
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const changed of ["cancelled", "pickup", "provider", "group", "work_order_closed"]) {
  test(`transaction eligibility refuses a ${changed} change after the initial read`, async () => {
    const w = await world(), before = snapshot(w);
    w.db.onSql("INSERT INTO taxi_recovery_cases", () => {
      if (changed === "cancelled") w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled'").run();
      if (changed === "pickup") w.sqlite.prepare("UPDATE taxi_trips SET pickup_verification_status='uat_confirmed'").run();
      if (changed === "provider") w.sqlite.prepare("UPDATE provider_work_orders SET provider_id='replacement-driver'").run();
      if (changed === "group") w.sqlite.prepare("UPDATE canonical_bookings SET schedule_group_id='new-group'").run();
      if (changed === "work_order_closed") w.sqlite.prepare("UPDATE provider_work_orders SET status='completed'").run();
    });
    const rejected = await refusal(recover(w, "decline"));
    assert.equal(rejected?.status, 409);
    assert.equal(JSON.parse(rejected.message).code, "taxi_recovery_stale");
    assert.deepEqual(snapshot(w), before, "all changes in the failed batch roll back");
    w.sqlite.close();
  });
}

async function post(w, cookie, action) {
  return route.POST(new Request(taxiUrl("/api/taxi-lifecycle"), {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ bookingId: w.trip.bookingId, action, idempotencyKey: nextKey(action), reason: "Unable to serve" }),
  }));
}

for (const identity of [
  { name: "customer", subjectType: "customer", subjectId: "CUST-TAXI-1", action: "decline" },
  { name: "different driver", subjectType: "provider", subjectId: "taxi_meera", action: "decline" },
  { name: "own driver without staff authority", subjectType: "provider", subjectId: "taxi_rahul", action: "no_show" },
]) {
  test(`route refuses recovery from ${identity.name}`, async () => {
    const w = await world();
    const session = await customerSessionCookie(w.db, { principalKey: "+919700000095", customerId: identity.subjectId, subjectType: identity.subjectType });
    const before = snapshot(w), response = await post(w, session.cookie, identity.action);
    assert.equal(response.status, 403);
    assert.deepEqual(snapshot(w), before);
    w.sqlite.close();
  });
}

test("own driver sees the governed closed-booking refusal through the real route", async () => {
  const w = await world({ bookingStatus: "cancelled" });
  const session = await customerSessionCookie(w.db, { principalKey: "+919700000096", customerId: "taxi_rahul", subjectType: "provider" });
  const before = snapshot(w), response = await post(w, session.cookie, "decline");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "taxi_booking_closed");
  assert.deepEqual(snapshot(w), before);
  w.sqlite.close();
});
