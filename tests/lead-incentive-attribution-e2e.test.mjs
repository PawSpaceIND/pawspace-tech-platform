import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__LEAD_INCENTIVE_DB__", "__LEAD_INCENTIVE_ENV__");

function d1(sqlite){
 const statement=(sql,args=[])=>({bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const r=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(r.changes||0)}}},all:async()=>({results:sqlite.prepare(sql).all(...args)})});
 return{prepare:sql=>statement(sql),batch:async items=>{sqlite.exec("BEGIN IMMEDIATE");try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec("COMMIT");return out}catch(error){sqlite.exec("ROLLBACK");throw error}},exec:async sql=>{sqlite.exec(sql);return{count:0,duration:0}}};
}

async function world(){
 const sqlite=new DatabaseSync(":memory:"),db=d1(sqlite);globalThis.__LEAD_INCENTIVE_DB__=db;globalThis.__LEAD_INCENTIVE_ENV__={};
 sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,service_code TEXT,status TEXT,total_amount REAL,scheduled_start TEXT)");
 sqlite.exec("CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,owner TEXT NOT NULL,converted_booking_id TEXT)");
 const sales=await import("../lib/sales-incentive-engine.ts");await sales.ensureSalesIncentiveTables(db);
 return{sqlite,db,sales};
}

test("converted Training lead automatically credits its configured sales owner once",async()=>{
 const{sqlite,db,sales}=await world();
 sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','dog_training','confirmed',30000,'2026-09-10T10:00:00Z')").run();
 sqlite.prepare("INSERT INTO lead_work_items VALUES ('LEAD-1','rep@pawspace.test','BK-1')").run();
 sqlite.prepare("INSERT INTO sales_employee_base (id,employee_id,base_vertical,effective_from,reason,actor_id,created_at) VALUES ('SB-1','rep@pawspace.test','training','2026-09-01','configured for sales','ops',1)").run();
 const first=await sales.attributeConvertedLeadBookingToOwner(db,{leadId:"LEAD-1",bookingId:"BK-1",actorId:"system:test"});
 assert.equal(first.attributed,true);assert.equal(first.duplicatePrevented,false);
 const replay=await sales.attributeConvertedLeadBookingToOwner(db,{leadId:"LEAD-1",bookingId:"BK-1",actorId:"system:test"});
 assert.equal(replay.attributed,true);assert.equal(replay.duplicatePrevented,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sales_attributed_bookings WHERE booking_id='BK-1'").get().n,1);
 const daily=await sales.computeDailySalesIncentive(db,{employeeId:"rep@pawspace.test",date:"2026-09-10",actorId:"system:test"});
 assert.equal(daily.achievedValue,30000);assert.equal(daily.incentive,500);
});

test("a conflicting prior attribution is never overwritten and becomes a review exception",async()=>{
 const{sqlite,db,sales}=await world();
 sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-2','grooming','confirmed',25000,'2026-09-10T10:00:00Z')").run();
 sqlite.prepare("INSERT INTO lead_work_items VALUES ('LEAD-2','right@pawspace.test','BK-2')").run();
 sqlite.prepare("INSERT INTO sales_employee_base (id,employee_id,base_vertical,effective_from,reason,actor_id,created_at) VALUES ('SB-2','right@pawspace.test','grooming_inbound','2026-09-01','configured for sales','ops',1)").run();
 sqlite.prepare("INSERT INTO sales_attributed_bookings VALUES ('SAB-X','BK-2','wrong@pawspace.test','legacy',1)").run();
 const result=await sales.attributeConvertedLeadBookingToOwner(db,{leadId:"LEAD-2",bookingId:"BK-2",actorId:"system:test"});
 assert.equal(result.attributed,false);assert.equal(result.conflict,true);
 assert.equal(sqlite.prepare("SELECT employee_id FROM sales_attributed_bookings WHERE booking_id='BK-2'").get().employee_id,"wrong@pawspace.test");
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sales_attribution_exceptions WHERE booking_id='BK-2'").get().n,1);
});