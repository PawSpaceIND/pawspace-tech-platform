import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_GATE5_DB__", "__BOARDING_GATE5_ENV__");

async function seedOps() {
  const { sqlite, db } = freshCountingD1();
  const ops = await import("../lib/boarding-ops-governance.ts");
  await ops.ensureBoardingOpsTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,schedule_group_id TEXT,status TEXT,provider_id TEXT,service_code TEXT,pet_ids_json TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-BG5','GRP-BG5','assigned','host_maya_rohan','boarding','[]')").run();
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("STAY-BG5","BK-BG5","CUS-BG5","host_maya_rohan","blr","blr-east","boarding-24h",new Date(now+86_400_000).toISOString(),new Date(now+2*86_400_000).toISOString(),1,1,"confirmed","ready","pending","pending","none",now,now);
  return { sqlite, db, ops };
}

async function rejectedResponse(work) {
  try { await work(); assert.fail("expected rejection"); }
  catch (error) { assert.ok(error instanceof Response); return error; }
}

test("Boarding Gate 5 executes canonical Operations note persistence", async () => {
  const { sqlite, db, ops } = await seedOps();
  const result = await ops.mutateBoardingOps(db, {
    stayId: "STAY-BG5", action: "add_note", actorId: "ops@pawspace.in", idempotencyKey: "bg5-note", note: "Customer requested a callback before check-in",
  });
  assert.equal(result.status, "noted");
  const note = sqlite.prepare("SELECT booking_id,note,actor_id FROM boarding_ops_notes WHERE stay_id='STAY-BG5'").get();
  assert.deepEqual(note, { booking_id: "BK-BG5", note: "Customer requested a callback before check-in", actor_id: "ops@pawspace.in" });
  const event = sqlite.prepare("SELECT event_type FROM boarding_stay_events WHERE stay_id='STAY-BG5' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(event.event_type, "ops_note_added");
});

test("Boarding Gate 5 refuses meaningless Operations notes", async () => {
  const { sqlite, db, ops } = await seedOps();
  const failure = await rejectedResponse(() => ops.mutateBoardingOps(db, {
    stayId: "STAY-BG5", action: "add_note", actorId: "ops@pawspace.in", idempotencyKey: "bg5-short", note: "ok",
  }));
  assert.equal(failure.status, 400);
  assert.match(await failure.text(), /meaningful Operations note/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM boarding_ops_notes WHERE stay_id='STAY-BG5'").get().n, 0);
});
