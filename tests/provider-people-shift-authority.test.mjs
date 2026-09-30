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
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite),now=Date.parse("2030-10-01T00:00:00Z");
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

const eligible=async w=> (await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",new Date("2030-10-07T13:30:00.000Z"))).some(p=>p.id==="PROV-S");
test("active People link cannot become legacy availability when its employee is missing",async()=>{const w=await world();w.sqlite.exec("DELETE FROM employees WHERE id='EMP-S'");assert.equal(await eligible(w),false);});
test("linked employee email normalization cannot bypass shift authority",async()=>{const w=await world();w.sqlite.exec("UPDATE employees SET work_email=' shift@test ' WHERE id='EMP-S'");assert.equal(await eligible(w),false);});
test("inactive link keeps legacy availability; inactive employee with active link is unavailable",async()=>{const w=await world();w.sqlite.exec("UPDATE employees SET employment_status='inactive' WHERE id='EMP-S'");assert.equal(await eligible(w),false);w.sqlite.exec("UPDATE provider_people_links SET status='inactive' WHERE provider_id='PROV-S'");assert.equal(await eligible(w),true);});
test("People timezone and half-open shift boundaries are respected",async()=>{for(const [at,expected] of [["2030-10-07T03:29:59Z",false],["2030-10-07T03:30:00Z",true],["2030-10-07T12:29:59Z",true],["2030-10-07T12:30:00Z",false]]){const w=await world();assert.equal((await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",new Date(at))).some(p=>p.id==="PROV-S"),expected,at);}const w=await world();w.sqlite.exec("UPDATE shift_policies SET timezone='invalid-zone'");assert.equal(await eligible(w),false);});
test("overnight shift uses the starting weekday and closes at exact end",async()=>{const w=await world();w.sqlite.exec("UPDATE shift_policies SET start_time='22:00',end_time='06:00',weekly_off_json='[2]'");for(const [at,expected] of [["2030-10-07T16:29:59Z",false],["2030-10-07T16:30:00Z",true],["2030-10-08T00:29:59Z",true],["2030-10-08T00:30:00Z",false]])assert.equal((await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",new Date(at))).some(p=>p.id==="PROV-S"),expected,at);});
test("People lookup bounds concurrency and records its linear read budget",async()=>{const w=await world();for(let i=0;i<40;i++){w.sqlite.prepare("INSERT INTO employees SELECT ?,NULL,?,display_name,?,phone,employment_status,joined_at,ended_at,created_at,updated_at FROM employees WHERE id='EMP-S'").run('EMP-'+i,'EMP-'+i,'shift'+i+'@test');w.sqlite.prepare("INSERT INTO provider_capacity_profiles SELECT ?,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at,contract_type,vci_registration_number,vci_verification_status,vci_provider_ref FROM provider_capacity_profiles WHERE id='PROV-S'").run('PROV-'+i);w.sqlite.prepare("INSERT INTO provider_people_links VALUES (?,?,'contract','active','test','test',0,0)").run('PROV-'+i,'EMP-'+i);w.sqlite.prepare("INSERT INTO employee_shift_assignments SELECT ?,?,shift_policy_id,effective_from,effective_until,reason,actor_id,created_at FROM employee_shift_assignments WHERE id='ESA-1'").run('ESA-extra-'+i,'EMP-'+i);}
 await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",new Date("2030-10-07T04:30:00Z"));let reads=0,active=0,peak=0;const db={...w.db,prepare(sql){const base=w.db.prepare(sql);const wrap=st=>({...st,bind:(...args)=>wrap(st.bind(...args)),first:async()=>{reads++;active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));try{return await st.first();}finally{active--;}},all:async()=>{reads++;active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));try{return await st.all();}finally{active--;}}});return wrap(base);}};await capacity.loadGovernedProviders(db,"blr","blr-east","grooming",new Date("2030-10-07T04:30:00Z"));assert.ok(peak<=8,`bounded People workers plus existing loader queries, got ${peak}`);assert.ok(reads<=220,`41 linked employees in this schema have a bounded linear read budget, got ${reads}`);console.log(JSON.stringify({linkedProviders:41,reads,peak}));});

test("linked employment join and end cutoffs remain authoritative",async()=>{const w=await world();w.sqlite.prepare("UPDATE employees SET joined_at=? WHERE id='EMP-S'").run(Date.parse("2030-10-08T00:00:00Z"));assert.equal(await eligible(w),false);w.sqlite.prepare("UPDATE employees SET joined_at=0,ended_at=? WHERE id='EMP-S'").run(Date.parse("2030-10-07T04:30:00Z"));assert.equal((await capacity.loadGovernedProviders(w.db,"blr","blr-east","grooming",new Date("2030-10-07T04:30:00Z"))).some(p=>p.id==="PROV-S"),false);});
