import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {d1} from './helpers/execution-harness.mjs';
installWorkersHooks('__MANAGER_TRUTH_DB__','__MANAGER_TRUTH_ENV__');
const {ensurePeopleTables}=await import('../lib/people-foundation.ts');
const {saveSalesEmployeeBase}=await import('../lib/sales-incentive-engine.ts');
const {buildManagerDashboard}=await import('../lib/manager-dashboard.ts');
const ASOF=Date.parse('2026-09-08T12:00:00Z');
async function world(t,{bookings=true,effectiveFrom='2026-09-01'}={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);globalThis.__MANAGER_TRUTH_DB__=db;globalThis.__MANAGER_TRUTH_ENV__={};await ensurePeopleTables(db);
 function person(id,email,manager){sqlite.prepare("INSERT INTO employees(id,employee_code,display_name,work_email,user_email,employment_status,joined_at,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?)").run(id,id,id,email,email,ASOF,ASOF,ASOF);sqlite.prepare("INSERT INTO employee_employment_versions(id,employee_id,version,effective_from,effective_until,manager_employee_id,team_code,reason,actor_id,created_at) VALUES(?,?,1,?,NULL,?,'sales','test fixture','test',?)").run('V-'+id,id,ASOF,manager,ASOF);}
 person('M','manager@test.invalid',null);person('A','sales@test.invalid','M');person('B','foreign@test.invalid','OTHER-MANAGER');
 await saveSalesEmployeeBase(db,{employeeId:'sales@test.invalid',baseVertical:'grooming_outbound',effectiveFrom,reason:'isolated report fixture',actorId:'test'});
 await saveSalesEmployeeBase(db,{employeeId:'foreign@test.invalid',baseVertical:'grooming_outbound',effectiveFrom,reason:'isolated report fixture',actorId:'test'});
 sqlite.exec('CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY, total_amount REAL, status TEXT, scheduled_start TEXT)');
 if(bookings){for(let day=2;day<=8;day++){const id='DAY-'+day;sqlite.prepare('INSERT INTO canonical_bookings VALUES(?,?,?,?)').run(id,day*100,'completed','2026-09-'+String(day).padStart(2,'0')+'T10:00:00Z');sqlite.prepare('INSERT INTO sales_attributed_bookings VALUES(?,?,?,?,?)').run(id,id,'sales@test.invalid','test',ASOF);}
 for(const [id,status,email] of [['CANCELLED','cancelled','sales@test.invalid'],['FOREIGN','completed','foreign@test.invalid']]){sqlite.prepare('INSERT INTO canonical_bookings VALUES(?,?,?,?)').run(id,90000,status,'2026-09-08T10:00:00Z');sqlite.prepare('INSERT INTO sales_attributed_bookings VALUES(?,?,?,?,?)').run(id,id,email,'test',ASOF);}}
 return{sqlite,db};
}
const input={actorEmail:'manager@test.invalid',permissions:['people.view'],asOf:ASOF};
test('manager seven-day totals reconcile to owned source records and exclude cancelled sales',async t=>{const {db}=await world(t);const result=await buildManagerDashboard(db,input);assert.equal(result.employeeCount,1);assert.equal(result.verticals.sales.length,1);const row=result.verticals.sales[0];assert.equal(row.employeeEmail,'sales@test.invalid');assert.equal(row.daily.achievedValue,800);assert.equal(row.weekly.achievedValue,3500);assert.equal(row.monthly.achievedValue,3500);assert.ok(!row.unavailableMetrics.includes('weekly'));});
test('one failed day makes the week unavailable instead of a believable partial sum',async t=>{const {db}=await world(t);let failed=0;const broken={...db,prepare(sql){const statement=db.prepare(sql);if(!sql.includes('date(b.scheduled_start)=?'))return statement;return{...statement,bind(...args){const bound=statement.bind(...args);if(args[1]!=='2026-09-04')return bound;return{...bound,first:async()=>{failed++;throw new Error('injected single-day query failure');}};}};}};
 const row=(await buildManagerDashboard(broken,input)).verticals.sales[0];assert.equal(failed,1);assert.equal(row.weekly,null);assert.equal(row.daily.achievedValue,800);assert.equal(row.monthly.achievedValue,3500);assert.ok(row.unavailableMetrics.includes('weekly'));});
test('an entirely successful empty week stays a genuine zero',async t=>{const {db}=await world(t,{bookings:false});const row=(await buildManagerDashboard(db,input)).verticals.sales[0];assert.equal(row.weekly.achievedValue,0);assert.ok(!row.unavailableMetrics.includes('weekly'));});
test('missing historical base configuration cannot produce a complete weekly total',async t=>{const {db}=await world(t,{effectiveFrom:'2026-09-08'});const row=(await buildManagerDashboard(db,input)).verticals.sales[0];assert.equal(row.daily.achievedValue,800);assert.equal(row.weekly,null);assert.equal(row.monthly,null);assert.ok(row.unavailableMetrics.includes('weekly'));});
