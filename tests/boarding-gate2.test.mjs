import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_GATE2_DB__", "__BOARDING_GATE2_ENV__");

async function seedStay() {
  const { sqlite, db } = freshCountingD1();
  const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
  await lifecycle.ensureBoardingStayLifecycleTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,schedule_group_id TEXT,status TEXT,provider_id TEXT,service_code TEXT,total_amount REAL,package_name TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-G2','GRP-G2','confirmed','host_maya_rohan','boarding',699,'Luxury Stay')").run();
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("STAY-G2","BK-G2","CUS-G2","host_maya_rohan","blr","blr-east","boarding-24h",new Date(now+86_400_000).toISOString(),new Date(now+2*86_400_000).toISOString(),1,1,"confirmed","required","pending","pending","none",now,now);
  return { sqlite, db, lifecycle };
}

async function rejectedResponse(work) {
  try { await work(); assert.fail("expected rejection"); }
  catch (error) { assert.ok(error instanceof Response); return error; }
}

test("Boarding Gate 2 executes care-plan validation and persistence", async () => {
  const { sqlite, db, lifecycle } = await seedStay();
  const invalid = await rejectedResponse(() => lifecycle.mutateBoardingStay(db, {
    stayId: "STAY-G2", action: "submit_care_plan", actorId: "customer@pawspace.in", idempotencyKey: "g2-invalid", carePlan: { feeding: "twice daily" },
  }));
  assert.equal(invalid.status, 409);
  assert.match(await invalid.text(), /emergency contact and vet/i);

  const result = await lifecycle.mutateBoardingStay(db, {
    stayId: "STAY-G2", action: "submit_care_plan", actorId: "customer@pawspace.in", idempotencyKey: "g2-valid",
    carePlan: { feeding: "twice daily", emergencyContact: "9999999999", vet: "Dr Rao" },
  });
  assert.equal(result.status, "care_plan_ready");
  const row = sqlite.prepare("SELECT status,plan_json FROM boarding_care_plan_snapshots WHERE stay_id='STAY-G2'").get();
  assert.equal(row.status, "ready");
  assert.equal(JSON.parse(row.plan_json).vet, "Dr Rao");
});

test("Boarding Gate 2 idempotency keys cannot be replayed across actions", async () => {
  const { db, lifecycle } = await seedStay();
  await lifecycle.mutateBoardingStay(db, {
    stayId: "STAY-G2", action: "submit_care_plan", actorId: "customer@pawspace.in", idempotencyKey: "g2-key",
    carePlan: { emergencyContact: "9999999999", vet: "Dr Rao" },
  });
  const failure = await rejectedResponse(() => lifecycle.mutateBoardingStay(db, {
    stayId: "STAY-G2", action: "request_extension", actorId: "customer@pawspace.in", idempotencyKey: "g2-key",
    requestedEnd: new Date(Date.now()+3*86_400_000).toISOString(),
  }));
  assert.equal(failure.status, 409);
  assert.match(await failure.text(), /idempotency key identifies one action/i);
});
