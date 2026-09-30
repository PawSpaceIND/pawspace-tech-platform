import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__PROVIDER_LEAVE_RECOVERY_DB__");
const leave=await import("../lib/attendance-leave.ts");
const capacity=await import("../lib/provider-capacity-governance.ts");
const linkage=await import("../lib/workforce-person-linkage.ts");

function makeD1(sqlite){
 function statement(sql,args=[]){return{bind:(...next)=>statement(sql,next),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}}},all:async()=>({results:sqlite.prepare(sql).all(...args)})};}
 return{prepare:(sql)=>statement(sql),batch:async(list)=>{const out=[];for(const item of list)out.push(await item.run());return out;}};
}
async function world(){
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
 await leave.ensureAttendanceLeaveTables(db);await capacity.ensureProviderCapacityTables(db);await linkage.ensureWorkforcePersonLinkTables(db);
 sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT UNIQUE,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
 const now=Date.now();sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,ended_at,created_at,updated_at) VALUES ('EMP-P',NULL,'EMP-P','Provider Person','provider@test',NULL,'contract_active',?,NULL,?,?)").run(now-86400000,now,now);
 sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('PROV-P','blr','Provider P','full_time','[\"grooming\"]','[\"blr-east\"]',1,5,100,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)").run(now);
 sqlite.prepare("INSERT INTO provider_people_links (provider_id,employee_id,engagement_kind,status,source,created_by,created_at,updated_at) VALUES ('PROV-P','EMP-P','contract','active','test','test',?,?)").run(now,now);
 await leave.saveLeavePolicy(db,{name:"Casual",leaveCode:"CL",allowNegative:false,entitlementUnits:10,effectiveFrom:now-86400000,actorId:"hr@test"});
 sqlite.prepare("INSERT INTO employee_leave_balances (employee_id,leave_code,balance,updated_at) VALUES ('EMP-P','CL',10,?)").run(now);
 sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','idem-1','CUS-1','[]','[]','blr','blr-east','grooming','pkg','Package','GRP-1','PROV-P','2030-10-05T04:30:00.000Z','2030-10-05T06:30:00.000Z','confirmed','customer_app',1000,'INR','{}','test',?,?)").run(now,now);
 return{sqlite,db};
}

test("G16 pending provider leave blocks new assignment and preserves booked work for recovery",async()=>{
 const w=await world(),request=await leave.requestLeave(w.db,{employeeId:"EMP-P",leaveCode:"CL",startDate:"2030-10-05",endDate:"2030-10-05",units:1,reason:"Family leave",actorId:"provider@test"});
 assert.equal(request.status,"pending");assert.equal(request.providerLeave?.affectedBookings,1);assert.equal(request.providerLeave?.recoveryCasesOpened,1);
 assert.equal(await capacity.providerUnavailableForWindow(w.db,{providerId:"PROV-P",scheduledStart:"2030-10-05T04:30:00.000Z",scheduledEnd:"2030-10-05T06:30:00.000Z"}),true);
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-1'").get().status,"confirmed");
 assert.equal(w.sqlite.prepare("SELECT status FROM provider_recovery_cases WHERE booking_id='BK-1'").get().status,"open");
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_customer_notifications").get().n,0);
 const approved=await leave.decideLeave(w.db,{requestId:request.id,decision:"approved",reason:"Manager approval",actorId:"manager@test"});
 assert.equal(approved.providerLeave?.recoveryCasesEscalated,1);assert.equal(approved.providerLeave?.notificationsQueued,2);
 assert.equal(w.sqlite.prepare("SELECT status FROM provider_recovery_cases WHERE booking_id='BK-1'").get().status,"ops_escalation");
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_customer_notifications WHERE booking_id='BK-1' AND status='queued'").get().n,2);
});

test("G16 rejected provider leave clears the pending dispatch block and cancels untouched recovery handoff",async()=>{
 const w=await world(),request=await leave.requestLeave(w.db,{employeeId:"EMP-P",leaveCode:"CL",startDate:"2030-10-05",endDate:"2030-10-05",units:1,reason:"Family leave",actorId:"provider@test"});
 const rejected=await leave.decideLeave(w.db,{requestId:request.id,decision:"rejected",reason:"Coverage retained",actorId:"manager@test"});
 assert.equal(rejected.providerLeave?.dispatchBlockCleared,true);
 assert.equal(await capacity.providerUnavailableForWindow(w.db,{providerId:"PROV-P",scheduledStart:"2030-10-05T04:30:00.000Z",scheduledEnd:"2030-10-05T06:30:00.000Z"}),false);
 assert.equal(w.sqlite.prepare("SELECT status FROM provider_recovery_cases WHERE booking_id='BK-1'").get().status,"cancelled");
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-1'").get().status,"confirmed");
});
