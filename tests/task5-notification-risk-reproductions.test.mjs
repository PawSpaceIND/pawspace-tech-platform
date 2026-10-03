// Exclusive Task5 QA file. Actual source modules, fresh disposable D1 fixtures.
// These invariants must be fixed before activation if they fail; no provider/customer transport.
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__TASK5_NOTIFICATION_RISKS_DB__","__TASK5_NOTIFICATION_RISKS_ENV__");
const DAY=86400000;
const ENV={NODE_ENV:"production",PAWSPACE_LOCAL_PREVIEW:"off",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false"};
async function riskWorld(t) {
  const f=world("__TASK5_NOTIFICATION_RISKS_DB__","__TASK5_NOTIFICATION_RISKS_ENV__",{...ENV});
  t.after(()=>f.sqlite.close());
  let attempts=0;const original=globalThis.fetch;
  globalThis.fetch=async()=>{attempts+=1;throw new Error("Notification risk fixture attempted external transport");};
  t.after(()=>{globalThis.fetch=original;assert.equal(attempts,0);});
  f.sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,city_id TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL,scheduled_start TEXT,scheduled_end TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  return f;
}
function booking(f,id,customer,endsAt,city="blr") {
  f.sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,'grooming','completed',?,?,?,?)").run(id,customer,city,new Date(endsAt-3600000).toISOString(),new Date(endsAt).toISOString(),endsAt,endsAt);
}
test("N-R04: a later completed Grooming booking starts a new cadence cycle while same-booking retries remain deduplicated",async t=>{
  const f=await riskWorld(t),now=Date.now(),customer="CUS-T5-REBOOK";
  f.sqlite.prepare("INSERT INTO canonical_customers VALUES (?,'blr','Synthetic reminder customer','synthetic-no-contact',?, ?,?)").run(customer,JSON.stringify({serviceUpdates:true,marketing:true}),now,now);
  const reminders=await import("../lib/customer-reminder-governance.ts"),comms=await import("../lib/communication-engine.ts");
  await reminders.ensureReminderGovernanceTables(f.db);await comms.ensureCommunicationTables(f.db);
  f.sqlite.prepare("INSERT INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES (?,1,1,'chat','Asia/Kolkata','fixture',?)").run(customer,now);
  booking(f,"BK-T5-OLD-COMPLETION",customer,now-16*DAY);
  await reminders.generateGroomingRebookingReminders(f.db,{actorId:"task5:test",asOf:now});
  await reminders.generateGroomingRebookingReminders(f.db,{actorId:"task5:test",asOf:now+300000});
  const count=()=>Number(f.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE customer_id=? AND template_key='grooming_rebooking_reminder'").get(customer).n);
  assert.equal(count(),1,"two attempts on the same completion/cadence must create one message");
  booking(f,"BK-T5-LATER-COMPLETION",customer,now+DAY);
  await reminders.generateGroomingRebookingReminders(f.db,{actorId:"task5:test",asOf:now+17*DAY});
  await reminders.generateGroomingRebookingReminders(f.db,{actorId:"task5:test",asOf:now+17*DAY+300000});
  assert.equal(count(),2,"a genuinely later completed booking must not collide with the earlier booking's cadence1 key");
});
test("N-R07: a provisioned Bengaluru manager cannot read Chennai staff-alert payloads",async t=>{
  const f=await riskWorld(t),now=Date.now(),manager="t5.blr.manager@example.test";
  await seedActors(f.sqlite,f.db,[{id:"USR-T5-BLR-MGR",email:manager,role:"manager"}]);
  const people=await import("../lib/people-foundation.ts"),alerts=await import("../lib/staff-alert-center.ts");
  await people.ensurePeopleTables(f.db);await alerts.ensureStaffAlertTables(f.db);
  f.sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES ('EMP-T5-BLR',?,'EMP-T5-BLR','Synthetic manager',?,'synthetic-no-contact','active',?,?,?)").run(manager,manager,now-DAY,now,now);
  f.sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES ('EEV-T5-BLR','EMP-T5-BLR',1,?,NULL,'full_time','confirmed','Operations Manager','operations',NULL,'CC-OPS','BLR','Bengaluru scope fixture','task5:test',?)").run(now-DAY,now);
  for(const city of["blr","maa"]){
    const customer=`CUS-${city}`,id=`BK-T5-${city}`;
    f.sqlite.prepare("INSERT INTO canonical_customers VALUES (?,?,?,'synthetic-no-contact','{}',?,?)").run(customer,city,`Private ${city} customer`,now,now);
    booking(f,id,customer,now-3600000,city);
    f.sqlite.prepare("INSERT INTO staff_alerts (id,idempotency_key,alert_type,severity,status,source_type,source_id,title,body,team_code,recipient_role,customer_id,booking_id,due_at,created_at,updated_at) VALUES (?,?, 'order_exception','high','open','canonical_booking',?,?,?,'operations','manager',?,?,?,?,?)").run(`ALERT-${city}`,`alert-${city}`,id,`Private ${city} alert`,`Private ${city} body`,customer,id,now,now,now);
  }
  const route=await import("../app/api/staff-alerts/route.ts");
  const response=await route.GET(asActor(manager,"/api/staff-alerts"));
  assert.equal(response.status,200,await response.clone().text());
  const body=await response.json();
  assert.ok(body.directory.alerts.some(a=>a.booking_id==="BK-T5-blr"));
  assert.ok(!JSON.stringify(body).includes("BK-T5-maa"),"cross-city booking IDs cannot be disclosed in the alert read");
  assert.ok(!JSON.stringify(body).includes("Private maa"),"cross-city titles/body/customer information cannot be disclosed");
  assert.equal(body.directory.summary.total,1,"summary must use the same city scope as alert payloads");
  for(const action of["acknowledge","resolve"]){
    const denied=await route.POST(asActor(manager,"/api/staff-alerts",{method:"POST",body:JSON.stringify({action,alertId:"ALERT-maa"})}));
    assert.equal(denied.status,403,await denied.clone().text());
    assert.equal(f.sqlite.prepare("SELECT status FROM staff_alerts WHERE id='ALERT-maa'").get().status,"open");
  }
  const allowed=await route.POST(asActor(manager,"/api/staff-alerts",{method:"POST",body:JSON.stringify({action:"acknowledge",alertId:"ALERT-blr"})}));
  assert.equal(allowed.status,200,await allowed.clone().text());
  const admin="t5.admin@example.test";await seedActors(f.sqlite,f.db,[{id:"USR-T5-ADMIN",email:admin,role:"admin"}]);
  const global=await route.GET(asActor(admin,"/api/staff-alerts"));assert.equal(global.status,200);
  assert.equal((await global.json()).directory.summary.total,2,"unscoped administrator retains existing directory");
  f.sqlite.prepare("UPDATE staff_alerts SET customer_id='CUS-blr' WHERE id='ALERT-maa'").run();
  const conflicting=await route.GET(asActor(manager,"/api/staff-alerts"));assert.equal(conflicting.status,200);
  assert.equal((await conflicting.json()).directory.summary.total,1,"booking city wins over conflicting customer city");
  f.sqlite.prepare("UPDATE employees SET employment_status='inactive' WHERE id='EMP-T5-BLR'").run();
  const revoked=await route.GET(asActor(manager,"/api/staff-alerts"));assert.equal(revoked.status,403,"inactive/unprovisioned manager scope fails closed");
});

test("N-R04 rollout: an existing legacy reminder for the same completion is retained, while a later completion has independent identity",async t=>{
  const f=await riskWorld(t),now=Date.now(),customer="CUS-T5-LEGACY";
  f.sqlite.prepare("INSERT INTO canonical_customers VALUES (?,'blr','Synthetic legacy reminder customer','synthetic-no-contact',?, ?,?)").run(customer,JSON.stringify({serviceUpdates:true,marketing:true}),now,now);
  const reminders=await import("../lib/customer-reminder-governance.ts"),comms=await import("../lib/communication-engine.ts");
  await reminders.ensureReminderGovernanceTables(f.db);await comms.ensureCommunicationTables(f.db);
  f.sqlite.prepare("INSERT INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES (?,1,1,'chat','Asia/Kolkata','fixture',?)").run(customer,now);
  booking(f,"BK-T5-LEGACY-COMPLETE",customer,now-16*DAY);
  await comms.enqueueCommunication(f.db,{customerId:customer,cityId:"blr",channel:"chat",purpose:"lifecycle",idempotencyKey:`grooming_rebooking:${customer}:1`,templateKey:"grooming_rebooking_reminder",payload:{daysSinceLastService:16,cadenceDays:15},createdBy:"task5:legacy",asOf:now});
  const count=()=>Number(f.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE customer_id=?").get(customer).n);
  await reminders.generateGroomingRebookingReminders(f.db,{actorId:"task5:test",asOf:now+300000});assert.equal(count(),1,"rollout cannot enqueue the same completion twice");
  booking(f,"BK-T5-AFTER-ROLLOUT",customer,now+DAY);
  await Promise.all([0,1,2].map(i=>reminders.generateGroomingRebookingReminders(f.db,{actorId:"task5:test",asOf:now+17*DAY+i*1000})));
  assert.equal(count(),2,"concurrent sweeps of the later completion create exactly one new reminder");
  const latest=f.sqlite.prepare("SELECT booking_id,payload_json FROM communication_messages WHERE booking_id='BK-T5-AFTER-ROLLOUT'").get();
  assert.equal(JSON.parse(latest.payload_json).completedBookingId,"BK-T5-AFTER-ROLLOUT");
});
test("N-R07 cold city boundary: an alert with no canonical city is invisible, even when canonical tables are absent",async t=>{
  const f=await riskWorld(t),alerts=await import("../lib/staff-alert-center.ts");await alerts.ensureStaffAlertTables(f.db);
  f.sqlite.exec("DROP TABLE canonical_bookings; DROP TABLE canonical_customers;");
  const now=Date.now();f.sqlite.prepare("INSERT INTO staff_alerts (id,idempotency_key,alert_type,severity,status,source_type,source_id,title,body,due_at,created_at,updated_at) VALUES ('UNSCOPED','UNSCOPED','case_manager_escalation','high','open','unified_case','UNKNOWN','Private unresolved','Private unresolved',?,?,?)").run(now,now,now);
  const scoped=await alerts.staffAlertDirectory(f.db,{cityId:"blr"});assert.equal(scoped.summary.total,0);assert.deepEqual(scoped.alerts,[]);
  assert.equal(await alerts.staffAlertVisibleInCity(f.db,"UNSCOPED","blr"),false);
  assert.equal((await alerts.staffAlertDirectory(f.db)).summary.total,1);
});
