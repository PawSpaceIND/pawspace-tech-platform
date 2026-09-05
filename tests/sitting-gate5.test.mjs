import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SITTING_GATE5_DB__", "__SITTING_GATE5_ENV__");

async function seedOps() {
  const { sqlite, db } = freshCountingD1();
  const ops = await import("../lib/sitting-ops-governance.ts");
  await ops.ensureSittingOpsTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,schedule_group_id TEXT,provider_id TEXT,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-SG5','CUS-SG5','GRP-SG5','PRV-SG5','pet_sitting','assigned',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-SG5','BK-SG5','PRV-SG5','accepted',?,?)").run(now, now);
  return { sqlite, db, ops };
}

async function rejectedResponse(work) {
  try { await work(); assert.fail("expected rejection"); }
  catch (error) { assert.ok(error instanceof Response); return error; }
}

test("Sitting Gate 5 executes canonical Operations note persistence", async () => {
  const { sqlite, db, ops } = await seedOps();
  const result = await ops.mutateSittingOps(db, {
    bookingId: "BK-SG5", action: "add_note", actorId: "ops@pawspace.in", idempotencyKey: "sg5-note", note: "Customer requested a callback before check-in",
  });
  assert.equal(result.status, "noted");
  const note = sqlite.prepare("SELECT note,actor_id FROM sitting_ops_notes WHERE booking_id='BK-SG5'").get();
  assert.deepEqual({ ...note }, { note: "Customer requested a callback before check-in", actor_id: "ops@pawspace.in" });
  const event = sqlite.prepare("SELECT event_type FROM sitting_care_events WHERE booking_id='BK-SG5' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(event.event_type, "ops_note_added");
});

test("Sitting Gate 5 refuses meaningless Operations notes", async () => {
  const { sqlite, db, ops } = await seedOps();
  const failure = await rejectedResponse(() => ops.mutateSittingOps(db, {
    bookingId: "BK-SG5", action: "add_note", actorId: "ops@pawspace.in", idempotencyKey: "sg5-short", note: "ok",
  }));
  assert.equal(failure.status, 400);
  assert.match(await failure.text(), /meaningful Operations note/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sitting_ops_notes WHERE booking_id='BK-SG5'").get().n, 0);
});
