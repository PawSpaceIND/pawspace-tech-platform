import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__PROVIDER_SHIFT_AUTH_DB__");
const capacity=await import("../lib/provider-capacity-governance.ts");
const leave=await import("../lib/attendance-leave.ts");
const linkage=await import("../lib/workforce-person-linkage.ts");

function makeD1(sqlite){
 function statement(sql,args=[]){return{bind:(...next)=>statement(sql,next),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}}},all:async()=>({results:sqlite.prepare(sql).all(...args)})};}
 return{prepare:(sql)=>statement(sql),batch:async(list)=>{const out=[];for(const item of list)out.push(await item.run());return out;}};
}
async function world(){
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite),now=Date.now();
 await leave.ensureAttendanceLeaveTables(db);await capacity.ensureProviderCapacityTables(db);await linkage.ensureWorkforcePersonLinkTables(db);
 sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,ended_at,created_at,updated_at) VALUES ('EMP-S',NULL,'EMP-S','Shift Provider','shift@test',NULL,'contract_active',?,NULL,?,?)").run(now-86400000,now,now);
 sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('PROV-S','blr','Shift Provider','full_time','[\"grooming\"]','[\"blr-east\"]',1,5,100,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)").run(now);
 sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('PROV-LEGACY','blr','Legacy Provider','full_time','[\"grooming\"]','[\"blr-east\"]',1,5,99,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)").run(now);
 sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('PROV-C','blr','Commission Provider','commission','[\"grooming\"]','[\"blr-east\"]',1,5,98,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)").run(now);
 sqlite.prepare("INSERT INTO provider_people_links (provider_id,employee_id,engagement_kind,status,source,created_by,created_at,updated_at) VALUES ('PROV-S','EMP-S','contract','active','test','test',?,?)").run(now,now);
 sqlite.prepare("INSERT INTO shift_policies (id,name,version,status,timezone,start_time,end_time,weekly_off_json,location_rule,approval_reference,effective_from,effective_until,created_by,created_at) VALUES ('SHIFT-1','Provider shift',1,'active','Asia/Kolkata','09:00','18:00','[]','not_required','TEST',1,NULL,'test',?)").run(now);
 sqlite.prepare("INSERT INTO employee_shift_assignments (id,employee_id,shift_policy_id,effective_from,effective_until,reason,actor_id,created_at) VALUES ('ESA-1','EMP-S','SHIFT-1',1,NULL,'test shift','test',?)").run(now);
 return{sqlite,db};
}

test("G15 linked full-time provider is eligible inside the People shift while legacy and commission models remain unchanged",async()=>{
 const w=await world();
 const ids=(await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",new Date("2030-10-07T04:30:00.000Z"))).map(p=>p.id);
 assert.ok(ids.includes("PROV-S"));assert.ok(ids.includes("PROV-LEGACY"));assert.ok(ids.includes("PROV-C"));
});

test("G15 linked full-time provider is removed outside its People shift without changing unlinked providers",async()=>{
 const w=await world();
 const ids=(await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",new Date("2030-10-07T13:30:00.000Z"))).map(p=>p.id);
 assert.ok(!ids.includes("PROV-S"));assert.ok(ids.includes("PROV-LEGACY"));assert.ok(ids.includes("PROV-C"));
});

test("G15 linked full-time provider is removed on its People weekly off",async()=>{
 const w=await world(),at=new Date("2030-10-07T04:30:00.000Z"),day=String(new Date(at.getTime()+330*60_000).getUTCDay());
 w.sqlite.prepare("UPDATE shift_policies SET weekly_off_json=? WHERE id='SHIFT-1'").run(JSON.stringify([day]));
 const ids=(await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",at)).map(p=>p.id);
 assert.ok(!ids.includes("PROV-S"));assert.ok(ids.includes("PROV-LEGACY"));
});
