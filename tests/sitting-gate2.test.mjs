import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SITTING_GATE2_DB__", "__SITTING_GATE2_ENV__");

async function seedBooking() {
  const { sqlite, db } = freshCountingD1();
  const lifecycle = await import("../lib/sitting-lifecycle.ts");
  await lifecycle.ensureSittingLifecycleTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,schedule_group_id TEXT,provider_id TEXT,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-SG2','CUS-SG2','GRP-SG2','PRV-SG2','pet_sitting','assigned',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-SG2','BK-SG2','PRV-SG2','accepted',?,?)").run(now, now);
  return { sqlite, db, lifecycle };
}

async function rejectedResponse(work) {
  try { await work(); assert.fail("expected rejection"); }
  catch (error) { assert.ok(error instanceof Response); return error; }
}

test("Sitting Gate 2 executes care-plan validation and persistence", async () => {
  const { sqlite, db, lifecycle } = await seedBooking();
  const invalid = await rejectedResponse(() => lifecycle.mutateSittingBooking(db, {
    bookingId: "BK-SG2", action: "submit_care_plan", actorId: "customer@pawspace.in", idempotencyKey: "sg2-invalid",
    carePlan: { emergencyContact: "9999999999", vet: "Dr Rao" },
  }));
  assert.equal(invalid.status, 409);
  assert.match(await invalid.text(), /home access/i);

  const result = await lifecycle.mutateSittingBooking(db, {
    bookingId: "BK-SG2", action: "submit_care_plan", actorId: "customer@pawspace.in", idempotencyKey: "sg2-valid",
    carePlan: { emergencyContact: "9999999999", vet: "Dr Rao", homeAccess: "Key with security" },
  });
  assert.equal(result.status, "care_plan_ready");
  const row = sqlite.prepare("SELECT status,plan_json FROM sitting_care_plan_snapshots WHERE booking_id='BK-SG2'").get();
  assert.equal(row.status, "ready");
  assert.equal(JSON.parse(row.plan_json).homeAccess, "Key with security");
});

test("Sitting Gate 2 replays an identical idempotency key without duplicating the action", async () => {
  const { sqlite, db, lifecycle } = await seedBooking();
  const input = {
    bookingId: "BK-SG2", action: "submit_care_plan", actorId: "customer@pawspace.in", idempotencyKey: "sg2-replay",
    carePlan: { emergencyContact: "9999999999", vet: "Dr Rao", homeAccess: "Key with security" },
  };
  await lifecycle.mutateSittingBooking(db, input);
  const replay = await lifecycle.mutateSittingBooking(db, input);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sitting_action_keys WHERE idempotency_key='sg2-replay'").get().n, 1);
});
