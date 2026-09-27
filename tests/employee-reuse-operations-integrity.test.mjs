import assert from "node:assert/strict";
import test from "node:test";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
installWorkersHooks("__EMP_OPS_DB__", "__EMP_OPS_ENV__");
const accrual=await import("../lib/daily-incentive-accrual.ts");
const sales=await import("../lib/sales-incentive-engine.ts");
const productivity=await import("../lib/sales-productivity-governance.ts");
const center=await import("../lib/employee-performance-center.ts");
const leads=await import("../lib/lead-assignment-governance.ts");
const people=await import("../lib/people-foundation.ts");
const time=await import("../lib/attendance-leave.ts");
function world(t){const w=freshCountingD1();t.after(()=>w.sqlite.close());globalThis.__EMP_OPS_DB__=w.db;globalThis.__EMP_OPS_ENV__={DB:w.db};return w;}
const DATE="2026-09-20",NOW=Date.parse("2026-09-21T08:00:00+05:30");
async function incentiveWorld(t){const w=world(t);w.sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,total_amount REAL,status TEXT,scheduled_start TEXT)");await sales.saveSalesEmployeeBase(w.db,{employeeId:"employee@audit.test",baseVertical:"training",effectiveFrom:"2026-09-01",reason:"Isolated recovery regression",actorId:"hr@audit.test"});return w;}
function failCalculation(w){const original=w.db.prepare.bind(w.db);w.db.prepare=sql=>{const q=original(sql);if(/SELECT/i.test(sql)&&/sales_employee_base/i.test(sql)&&/WHERE employee_id/i.test(sql)){const wrap=x=>new Proxy(x,{get(target,key){if(key==="bind")return(...args)=>wrap(target.bind(...args));if(key==="first")return async()=>{throw new Error("transient test failure");};return Reflect.get(target,key);}});return wrap(q);}return q;};return()=>{w.db.prepare=original;};}
test("failed incentive calculation is not marked complete and retries safely",async t=>{
 const w=await incentiveWorld(t),restore=failCalculation(w);await accrual.runDailyIncentiveAccrualSweep(w.db,{date:DATE,asOf:NOW});restore();
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM daily_incentive_sweep_runs").get().n,0);
 const second=await accrual.runDailyIncentiveAccrualSweep(w.db,{date:DATE,asOf:NOW+300000});assert.equal(second.processed,1);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM daily_incentive_accruals").get().n,1);
 const third=await accrual.runDailyIncentiveAccrualSweep(w.db,{date:DATE,asOf:NOW+600000});assert.equal(third.reason,"already_processed");
});
test("the next day scheduler recovers an older unfinished employee accrual",async t=>{
 const w=await incentiveWorld(t),restore=failCalculation(w);await accrual.runDailyIncentiveAccrualSweep(w.db,{date:DATE,asOf:NOW});restore();
 await accrual.runDailyIncentiveAccrualSweep(w.db,{asOf:NOW+86400000});
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM daily_incentive_accruals WHERE accrual_date=?").get(DATE).n,1);
});
test("sales performance selects the newest sales run rather than a newer operations run",async t=>{
 const w=world(t);await productivity.ensureSalesProductivityTables(w.db);w.sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY,email TEXT,name TEXT)");
 const now=Date.now(),from=now-7*86400000;
 for(const[id,team,at]of[["SALES","sales",now-2000],["OPS","operations",now-1000]]){
 w.sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES (?,?,?,1,?,?,'completed','test','audit',?,?)").run(id,id,"P-"+team,from,now,at,JSON.stringify({teamCode:team}));
 w.sqlite.prepare("INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,net_collected_revenue,created_at) VALUES (?,?,?,?,?,?,?,?)").run("F-"+team,id,team+"@audit.test",team,from,now,25000,now);}
 const r=await center.employeePerformanceCenter(w.db,{teamCode:"sales",days:30});assert.equal(r.period.sourceRun.id,"SALES");assert.equal(r.rows.length,1);assert.equal(r.totals.net,25000);
});
async function leadWorld(t,{leave=false,unavailable=false}={}){
 const w=world(t);await people.ensurePeopleTables(w.db);await time.ensureAttendanceLeaveTables(w.db);
 w.sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,role_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER); CREATE TABLE crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,area TEXT,email TEXT)");
 w.sqlite.prepare("INSERT INTO app_users VALUES ('U','employee@audit.test','Employee','associate','active',?,?)").run(NOW,NOW);
 w.sqlite.prepare("INSERT INTO crm_contacts VALUES ('C','Synthetic','9000000000','Bengaluru','c@audit.test')").run();
 const emp=await people.upsertEmployee(w.db,{employeeCode:"E",displayName:"Employee",workEmail:"employee@audit.test",userEmail:"employee@audit.test",joinedAt:NOW-86400000,actorId:"hr@audit.test"});
 await leads.ensureLeadAssignmentTables(w.db);
 w.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,recycle_cycle,opt_out,created_at,updated_at,lifecycle_state) VALUES ('L','C','Website','Grooming','Unassigned','Manager','active','day_1',1,?,?,?,0,0,?,?,'new')").run(NOW,NOW+600000,NOW+1800000,NOW,NOW);
 const p=await leads.saveLeadAssignmentPolicy(w.db,{name:"Default-like test policy",teamCode:"sales",serviceCodes:["grooming"],cityIds:["Bengaluru"],maxActiveWorkload:10,continuityEnabled:true,requireShift:false,fallbackQueue:"sales-review",effectiveFrom:NOW-86400000,reason:"Synthetic employee coverage",actorId:"manager@audit.test"});
 await leads.activateLeadAssignmentPolicy(w.db,{policyId:p.id,approvalReference:"TEST-ONLY",reason:"Synthetic coverage approval",actorId:"manager@audit.test"});
 await leads.saveLeadAssignmentMember(w.db,{employeeEmail:"employee@audit.test",teamCode:"sales",serviceCodes:["grooming"],cityIds:["Bengaluru"],active:true,actorId:"manager@audit.test"});
 if(unavailable)await leads.setLeadAssignmentAvailability(w.db,{employeeEmail:"employee@audit.test",availableFrom:NOW-3600000,availableUntil:NOW+3600000,status:"unavailable",reason:"Unavailable test",actorId:"manager@audit.test"});
 if(leave)w.sqlite.prepare("INSERT INTO leave_requests (id,employee_id,leave_code,start_date,end_date,units,reason,status,requested_by,approved_by,approved_at,created_at) VALUES ('LEAVE',?,'CL','2026-09-21','2026-09-21',1,'test','approved','employee@audit.test','manager@audit.test',?,?)").run(emp.id,NOW-1,NOW-2);
 return w;
}
for(const setting of [{leave:true},{unavailable:true}])test(`lead assignment excludes employee even without shift requirement: ${JSON.stringify(setting)}`,async t=>{const w=await leadWorld(t,setting);const r=await leads.assignLead(w.db,{leadId:"L",idempotencyKey:"assign",reason:"new_lead",actorId:"system:test",asOf:NOW});assert.equal(r.assignment.employee_email,null);assert.equal(r.assignment.fallback_queue,"sales-review");});
test("available employee remains eligible; pending leave is not silently approved",async t=>{const w=await leadWorld(t,{leave:true});w.sqlite.prepare("UPDATE leave_requests SET status='pending'").run();const r=await leads.assignLead(w.db,{leadId:"L",idempotencyKey:"assign",reason:"new_lead",actorId:"system:test",asOf:NOW});assert.equal(r.assignment.employee_email,"employee@audit.test");});
