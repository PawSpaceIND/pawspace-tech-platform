import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function makeD1(sqlite){
  function statement(sql,args=[]){return{
    bind:(...bound)=>statement(sql,bound),
    first:async()=>sqlite.prepare(sql).get(...args)??null,
    run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},
    all:async()=>({results:sqlite.prepare(sql).all(...args)}),
  };}
  return{prepare:(sql)=>statement(sql),batch:async(list)=>{sqlite.exec("BEGIN");try{const out=[];for(const item of list)out.push(await item.run());sqlite.exec("COMMIT");return out;}catch(error){sqlite.exec("ROLLBACK");throw error;}},exec:async(sql)=>sqlite.exec(sql)};
}

const {rankProvidersForBooking}=await import("../lib/ops-intelligence-governance.ts");
const {ensureProviderPerformanceTelemetry,providerPerformanceStatement}=await import("../lib/provider-performance-telemetry.ts");
const {buildUnitEconomics}=await import("../lib/unit-economics.ts");

function rankingDb(){
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  sqlite.exec("CREATE TABLE provider_work_orders(provider_id TEXT,provider_name TEXT,status TEXT,scheduled_start TEXT,service_code TEXT)");
  sqlite.exec("CREATE TABLE booking_ratings(provider_id TEXT,stars REAL,service_code TEXT)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles(id TEXT PRIMARY KEY,city_id TEXT,services_json TEXT,zones_json TEXT,live INTEGER,status TEXT,effective_from TEXT,effective_to TEXT)");
  return{sqlite,db};
}

test("provider ranking is deterministic, governed, advisory and fail-visible",async()=>{
  const{sqlite,db}=rankingDb();
  const at=Date.UTC(2026,8,7,6);
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,?,?,1,'active','2026-01-01',NULL)").run("A","blr",'["grooming"]','["blr-east"]');
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,?,?,1,'active','2026-01-01',NULL)").run("B","blr",'["grooming"]','["blr-east"]');
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,?,?,0,'active','2026-01-01',NULL)").run("OFF","blr",'["grooming"]','["blr-east"]');
  for(const id of["B","A","OFF"])sqlite.prepare("INSERT INTO provider_work_orders VALUES (?,?, 'completed', ?, 'grooming')").run(id,id,"2026-08-01T00:00:00.000Z");
  const result=await rankProvidersForBooking(db,{serviceCode:"grooming",cityId:"blr",zoneId:"blr-east",at});
  assert.equal(result.recommendationOnly,true);
  assert.equal(result.governedCandidateFilter,true);
  assert.equal(result.degraded,false);
  assert.deepEqual(result.ranked.map(row=>row.providerId),["A","B"],"equal raw scores use provider id as canonical tie-break; offline providers are excluded");

  sqlite.exec("DROP TABLE booking_ratings");
  const degraded=await rankProvidersForBooking(db,{serviceCode:"grooming",cityId:"blr",zoneId:"blr-east",at});
  assert.equal(degraded.degraded,true);
  assert.ok(degraded.degradedSources.includes("booking_ratings"));
});

test("provider telemetry is transaction-coupled and retry idempotent",async()=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  await ensureProviderPerformanceTelemetry(db);
  sqlite.exec("CREATE TABLE state(id TEXT PRIMARY KEY,value TEXT)");
  const input={providerId:"P1",groupId:"G1",bookingId:"B1",eventType:"assignment_decline",impactScore:-2,detail:{reason:"busy"},createdAt:1};
  await db.batch([db.prepare("INSERT INTO state VALUES ('G1','reassigned')"),providerPerformanceStatement(db,input)]);
  await providerPerformanceStatement(db,input).run();
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events").get().n,1,"retry must not duplicate telemetry");
  assert.equal(sqlite.prepare("SELECT value FROM state WHERE id='G1'").get().value,"reassigned");
});

test("unit economics utilization uses authored roster, city and capacity units",async()=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  sqlite.exec("CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,status TEXT,total_amount REAL,scheduled_start TEXT,scheduled_end TEXT,city_id TEXT)");
  sqlite.exec("CREATE TABLE scheduling_reservations(id TEXT PRIMARY KEY,provider_id TEXT,city_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT,capacity_units INTEGER)");
  sqlite.exec("CREATE TABLE scheduling_availability(id TEXT PRIMARY KEY,provider_id TEXT,city_id TEXT,zone_id TEXT,date TEXT,windows_json TEXT,source TEXT)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles(id TEXT PRIMARY KEY,city_id TEXT,live INTEGER,status TEXT,effective_from TEXT,effective_to TEXT,capacity INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?,?,?,?,?,?)").run("B1","C1","P1","boarding","confirmed",1000,"2026-09-07T04:00:00.000Z","2026-09-07T06:00:00.000Z","blr");
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,1,'active','2026-01-01',NULL,4)").run("P1","blr");
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,1,'active','2026-01-01',NULL,2)").run("P2","hyd");
  sqlite.prepare("INSERT INTO scheduling_reservations VALUES (?,?,?,'assigned',?,?,?)").run("R1","P1","blr","2026-09-07T04:00:00.000Z","2026-09-07T06:00:00.000Z",2);
  sqlite.prepare("INSERT INTO scheduling_availability VALUES (?,?,?,?,?,?,?)").run("A1","P1","blr","blr-east","2026-09-07",'["09:00-11:00"]',"operations");
  sqlite.prepare("INSERT INTO scheduling_availability VALUES (?,?,?,?,?,?,?)").run("SYN","P1","blr","blr-east","2026-09-07",'["09:00-19:00"]',"uat_roster");
  sqlite.prepare("INSERT INTO scheduling_availability VALUES (?,?,?,?,?,?,?)").run("HYD","P2","hyd","hyd-east","2026-09-07",'["09:00-19:00"]',"operations");
  const result=await buildUnitEconomics(db,{from:"2026-09-07",to:"2026-09-07",cityId:"blr"});
  assert.equal(result.company.utilisationPct,50,"4 booked capacity-hours / 8 authored roster capacity-hours");
});
