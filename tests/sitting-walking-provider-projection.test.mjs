import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
import { makeD1, seedSittingBooking, seedWalkingBooking } from "./helpers/stay-harness.mjs";

installWorkersHooks("__SWPROJ_DB__", "__SWPROJ_ENV__");
globalThis.__SWPROJ_ENV__ = {};

const { projectSittingProviderBooking } = await import("../lib/sitting-provider-projection.ts");
const { projectWalkingProviderBooking } = await import("../lib/walking-provider-projection.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const sittingRoute = await import("../app/api/sitting-lifecycle/route.ts");
const walkingRoute = await import("../app/api/walking-lifecycle/route.ts");

async function providerWorld(email, providerId) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA journal_mode=MEMORY");
  const db = makeD1(sqlite);
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users(id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'service_provider','active',?,?)")
    .run(`U-${providerId}`, email, "Provider", now, now);
  sqlite.prepare("INSERT INTO provider_identity_links(email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)")
    .run(email, providerId, now, now);
  return { sqlite, db };
}

const providerRequest = (path, email) => new Request(`https://ops.pawspace.example${path}`, { headers: { "oai-authenticated-user-email": email } });

test("sitting projection preserves the wire contract while redacting provider-sensitive care/event data", () => {
  const out = projectSittingProviderBooking({ id:"B1",status:"in_progress",service_code:"pet_sitting",package_code:"visit",package_name:"Visit",schedule_group_id:"G1",city_id:"blr",zone_id:"blr-east",scheduled_start:"2026-09-10T10:00:00Z",scheduled_end:"2026-09-10T11:00:00Z",provider_id:"sit_1",customer_id:"cust_1",work_order_id:"wo_1",work_order_status:"in_progress",total_amount:499,currency:"INR",carePlan:{status:"ready",plan:{feeding:"Morning kibble",medication:"None",emergencyContact:"+91 98765 43210 Mom",vet:"Dr Rao 9988776655",homeAccess:"Gate code 4455, key under mat",specialInstructions:"Dog is friendly",internalStaffNote:"Never expose this"},updatedAt:1},events:[{id:"e1",event_type:"checked_in",actor_id:"ops@pawspace.in",detail:{distanceMeters:12,staffNote:"called customer 9876543210"},created_at:2}],recovery:null });
  assert.equal(out.provider_id,"sit_1");
  assert.equal(out.scheduled_start,"2026-09-10T10:00:00Z");
  assert.equal(out.events[0].event_type,"checked_in");
  assert.equal(out.events[0].actor_id,"provider_or_system");
  assert.equal(out.carePlan.plan.feeding,"Morning kibble");
  assert.equal(out.carePlan.plan.emergencyContact,"+91 98765 43210 Mom");
  assert.equal(out.carePlan.plan.vet,"Dr Rao 9988776655");
  assert.equal(out.carePlan.plan.homeAccess,"Gate code 4455, key under mat");
  assert.equal(out.providerId,undefined);
  const serialized=JSON.stringify(out);
  for(const secret of["ops@pawspace.in","staffNote","Never expose this","internalStaffNote"])assert.ok(!serialized.includes(secret));
});

test("walking projection keeps snake_case UI fields, safe owner care and only safe payment fields", () => {
  const out = projectWalkingProviderBooking({ id:"W1",status:"assigned",service_code:"dog_walking",package_code:"walk-30",package_name:"30 min",schedule_group_id:"G1",city_id:"blr",zone_id:"blr-east",scheduled_start:"2026-09-10T07:00:00Z",scheduled_end:"2026-09-10T07:30:00Z",provider_id:"walk_1",customer_id:"cust_2",work_order_status:"accepted",payment_status:"captured",total_amount:299,currency:"INR",pets:[{id:"p1",name:"Bruno",species:"dog",breed:"Indie"}],ownerCare:{instructions:"Avoid the busy main road; use the harness",handoverPreference:"owner"},sessions:[{id:"s1",occurrence_number:1,provider_id:"walk_1",scheduled_start:"2026-09-10T07:00:00Z",scheduled_end:"2026-09-10T07:30:00Z",status:"scheduled",handover_status:"pending",completion_status:"pending",updated_at:1}],events:[{id:"e1",session_id:"s1",event_type:"walker_accepted",actor_id:"staff@pawspace.in",detail:{walkCount:5,note:"customer phone 9123456789"},created_at:3}],sessionPayments:[{id:"pay1",session_id:"s1",amount:299,currency:"INR",status:"due",gateway:"private",reference:"secret",detail_json:'{"phone":"9123456789"}'}],recovery:null });
  assert.equal(out.provider_id,"walk_1");
  assert.equal(out.sessions[0].scheduled_start,"2026-09-10T07:00:00Z");
  assert.equal(out.sessions[0].completion_status,"pending");
  assert.equal(out.events[0].event_type,"walker_accepted");
  assert.equal(out.ownerCare.instructions,"Avoid the busy main road; use the harness");
  assert.equal(out.sessionPayments[0].amount,299);
  assert.equal(out.sessionPayments[0].gateway,undefined);
  assert.equal(out.providerId,undefined);
  const serialized=JSON.stringify(out);
  for(const secret of["staff@pawspace.in","9123456789","detail_json","private-ref"])assert.ok(!serialized.includes(secret));
});

test("booking-only Sitting provider GET uses the redacted provider projection", async t => {
  const email="sitter.projection@pawspace.test", providerId="sitter_ananya";
  const { sqlite, db } = await providerWorld(email, providerId); t.after(()=>sqlite.close());
  await seedSittingBooking(db,sqlite,{bookingId:"SIT-BOOKING-ONLY",providerId});
  sqlite.prepare("INSERT INTO sitting_care_plan_snapshots(booking_id,customer_id,plan_json,status,updated_by,updated_at) VALUES (?,?,?,'ready','customer',1)")
    .run("SIT-BOOKING-ONLY","CUST-SIT-1",JSON.stringify({feeding:"Kibble",emergencyContact:"9876543210",vet:"9999999999",homeAccess:"PIN 4455",specialInstructions:"Quiet dog"}));
  sqlite.prepare("INSERT INTO sitting_care_events(id,booking_id,event_type,actor_id,detail_json,created_at) VALUES ('E-SIT','SIT-BOOKING-ONLY','checked_in','ops@pawspace.in',?,1)")
    .run(JSON.stringify({distanceMeters:10,staffNote:"call 9876543210"}));
  const response=await runWithWorkersDb(db,()=>sittingRoute.GET(providerRequest("/api/sitting-lifecycle?bookingId=SIT-BOOKING-ONLY",email)));
  assert.equal(response.status,200,await response.clone().text());
  const row=(await response.json()).data[0];
  assert.equal(row.provider_id,providerId); assert.equal(row.providerId,undefined); assert.equal(row.events[0].actor_id,"provider_or_system");
  assert.equal(row.carePlan.plan.emergencyContact,"9876543210"); assert.equal(row.carePlan.plan.vet,"9999999999"); assert.equal(row.carePlan.plan.homeAccess,"PIN 4455");
  assert.ok(!JSON.stringify(row).includes("ops@pawspace.in")); assert.ok(!JSON.stringify(row).includes("staffNote"));
});

test("booking-only Sitting read refuses a different provider before governed care fields are returned", async t => {
  const email="other.sitter@pawspace.test", assigned="sitter_ananya", other="sitter_neha";
  const { sqlite, db } = await providerWorld(email, other); t.after(()=>sqlite.close());
  await seedSittingBooking(db,sqlite,{bookingId:"SIT-CROSS-PROVIDER",providerId:assigned});
  const response=await runWithWorkersDb(db,()=>sittingRoute.GET(providerRequest("/api/sitting-lifecycle?bookingId=SIT-CROSS-PROVIDER",email)));
  assert.equal(response.status,403);
});

test("booking-only Walking read refuses a different provider before owner care is returned", async t => {
  const email="other.walker@pawspace.test", assigned="walker_dev", other="walker_asha";
  const { sqlite, db } = await providerWorld(email, other); t.after(()=>sqlite.close());
  await seedWalkingBooking(db,sqlite,{bookingId:"WALK-CROSS-PROVIDER",providerId:assigned});
  const response=await runWithWorkersDb(db,()=>walkingRoute.GET(providerRequest("/api/walking-lifecycle?bookingId=WALK-CROSS-PROVIDER",email)));
  assert.equal(response.status,403);
});

test("booking-only Walking provider GET is redacted without breaking walker-required fields", async t => {
  const email="walker.projection@pawspace.test", providerId="walker_dev";
  const { sqlite, db } = await providerWorld(email, providerId); t.after(()=>sqlite.close());
  const booking=await seedWalkingBooking(db,sqlite,{bookingId:"WALK-BOOKING-ONLY",providerId});
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets(id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT)");
  sqlite.prepare("INSERT INTO canonical_pets VALUES ('PET-W','CUST-WALK-1','Bruno','dog','Indie')").run();
  sqlite.prepare("UPDATE canonical_bookings SET pet_ids_json='[\"PET-W\"]' WHERE id='WALK-BOOKING-ONLY'").run();
  sqlite.prepare("UPDATE provider_work_orders SET assignment_json=? WHERE booking_id='WALK-BOOKING-ONLY'").run(JSON.stringify({ownerCare:{instructions:"Avoid the busy main road; use the harness",handoverPreference:"owner"}}));
  sqlite.prepare("INSERT INTO walking_session_events(id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES ('E-W','WALK-BOOKING-ONLY',?,?,'walker_accepted','staff@pawspace.in',?,1)")
    .run(booking.sessionId,providerId,JSON.stringify({walkCount:1,note:"phone 9123456789"}));
  sqlite.prepare("INSERT INTO walking_session_payment_events(id,booking_id,session_id,amount,currency,status,gateway,reference,detail_json,created_at,updated_at) VALUES ('P-W','WALK-BOOKING-ONLY',?,349,'INR','due','uat_sandbox','private-ref',?,1,1)")
    .run(booking.sessionId,JSON.stringify({phone:"9123456789"}));
  const response=await runWithWorkersDb(db,()=>walkingRoute.GET(providerRequest("/api/walking-lifecycle?bookingId=WALK-BOOKING-ONLY",email)));
  assert.equal(response.status,200,await response.clone().text());
  const row=(await response.json()).data[0];
  assert.equal(row.provider_id,providerId); assert.equal(row.providerId,undefined); assert.equal(row.sessions[0].scheduled_start,booking.sessions[0].scheduledStart);
  assert.equal(row.ownerCare.instructions,"Avoid the busy main road; use the harness"); assert.equal(row.events[0].actor_id,"provider_or_system");
  assert.equal(row.sessionPayments[0].amount,349); assert.equal(row.sessionPayments[0].gateway,undefined);
  assert.ok(!JSON.stringify(row).includes("9123456789"));
});
