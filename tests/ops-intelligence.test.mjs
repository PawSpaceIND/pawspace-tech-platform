import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__OPS_INTELLIGENCE_DB__", "__OPS_INTELLIGENCE_ENV__");

function makeD1(sqlite){
  function statement(sql,args=[]){return{
    bind:(...bound)=>statement(sql,bound),
    first:async()=>sqlite.prepare(sql).get(...args)??null,
    run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},
    all:async()=>({results:sqlite.prepare(sql).all(...args)}),
  };}
  return{prepare:(sql)=>statement(sql),batch:async(list)=>{sqlite.exec("BEGIN");try{const out=[];for(const item of list)out.push(await item.run());sqlite.exec("COMMIT");return out;}catch(error){sqlite.exec("ROLLBACK");throw error;}},exec:async(sql)=>sqlite.exec(sql)};
}

const {rankProvidersForBooking,forecastDemand}=await import("../lib/ops-intelligence-governance.ts");
const {ensureProviderPerformanceTelemetry,providerPerformanceStatement}=await import("../lib/provider-performance-telemetry.ts");
const {buildUnitEconomics}=await import("../lib/unit-economics.ts");

function rankingDb(){
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  sqlite.exec("CREATE TABLE provider_work_orders(provider_id TEXT,provider_name TEXT,status TEXT,scheduled_start TEXT,service_code TEXT)");
  sqlite.exec("CREATE TABLE booking_ratings(provider_id TEXT,stars REAL,service_code TEXT)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles(id TEXT PRIMARY KEY,name TEXT,city_id TEXT,services_json TEXT,zones_json TEXT,live INTEGER,status TEXT,effective_from TEXT,effective_to TEXT)");
  return{sqlite,db};
}

test("provider ranking is deterministic, governed, advisory and includes cold-start capacity",async t=>{
  const{sqlite,db}=rankingDb();t.after(()=>sqlite.close());
  const at=Date.UTC(2026,8,7,6);
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,?,?,?,1,'active','2026-01-01',NULL)").run("A","Provider A","blr",'["grooming"]','["blr-east"]');
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,?,?,?,1,'active','2026-01-01',NULL)").run("B","Provider B","blr",'["grooming"]','["blr-east"]');
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,?,?,?,1,'active','2026-01-01',NULL)").run("COLD","Cold Start","blr",'["grooming"]','["blr-east"]');
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,?,?,?,?,0,'active','2026-01-01',NULL)").run("OFF","Offline","blr",'["grooming"]','["blr-east"]');
  for(const id of["B","A","OFF"])sqlite.prepare("INSERT INTO provider_work_orders VALUES (?,?, 'completed', ?, 'grooming')").run(id,id,"2026-08-01T00:00:00.000Z");
  const result=await rankProvidersForBooking(db,{serviceCode:"grooming",cityId:"blr",zoneId:"blr-east",at});
  assert.equal(result.recommendationOnly,true);
  assert.equal(result.governedCandidateFilter,true);
  assert.equal(result.degraded,false);
  assert.deepEqual(result.ranked.map(row=>row.providerId),["A","B","COLD"],"equal history scores tie-break canonically and cold-start governed providers remain rankable; offline providers are excluded");
  assert.equal(result.ranked.find(row=>row.providerId==="COLD")?.providerName,"Cold Start");

  sqlite.exec("DROP TABLE booking_ratings");
  const degraded=await rankProvidersForBooking(db,{serviceCode:"grooming",cityId:"blr",zoneId:"blr-east",at});
  assert.equal(degraded.degraded,true);
  assert.ok(degraded.degradedSources.includes("booking_ratings"));
});

test("demand forecast excludes draft and cancelled bookings",async t=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite),at=Date.UTC(2026,8,8,6),created=at-86_400_000;t.after(()=>sqlite.close());
  sqlite.exec("CREATE TABLE canonical_bookings(created_at INTEGER,service_code TEXT,city_id TEXT,status TEXT)");
  for(const status of["confirmed","completed","draft","cancelled","canceled"])sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?)").run(created,"grooming","blr",status);
  const result=await forecastDemand(db,{serviceCode:"grooming",cityId:"blr",basisDays:7,horizonDays:1,at});
  assert.equal(result.dailyAverage,0.29,"only confirmed/completed rows should contribute to historical demand");
});

test("provider telemetry is transaction-coupled, retry idempotent and attempt-aware",async t=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);t.after(()=>sqlite.close());
  await ensureProviderPerformanceTelemetry(db);
  sqlite.exec("CREATE TABLE state(id TEXT PRIMARY KEY,value TEXT)");
  const input={providerId:"P1",groupId:"G1",bookingId:"B1",eventType:"assignment_decline",impactScore:-2,detail:{reason:"busy"},createdAt:1,attemptNo:1};
  await db.batch([db.prepare("INSERT INTO state VALUES ('G1','reassigned')"),providerPerformanceStatement(db,input)]);
  await providerPerformanceStatement(db,input).run();
  await providerPerformanceStatement(db,{...input,createdAt:2,attemptNo:2}).run();
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events").get().n,2,"same attempt must dedupe while a later legitimate assignment attempt remains observable");
  assert.equal(sqlite.prepare("SELECT value FROM state WHERE id='G1'").get().value,"reassigned");
});

test("unit economics utilization uses authored roster, city and capacity units",async t=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);t.after(()=>sqlite.close());
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


test("telemetry without an attempt preserves the historical idempotency key",async t=>{
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);t.after(()=>sqlite.close());
 await ensureProviderPerformanceTelemetry(db);
 const input={providerId:"P1",groupId:"G1",bookingId:"B1",eventType:"assignment_decline",impactScore:-2,createdAt:2};
 sqlite.prepare("INSERT INTO provider_performance_events(id,provider_id,group_id,booking_id,event_type,impact_score,detail_json,created_at) VALUES ('PPE:P1:G1:B1:assignment_decline','P1','G1','B1','assignment_decline',-2,'{}',1)").run();
 await providerPerformanceStatement(db,input).run();
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events").get().n,1);
 assert.equal(sqlite.prepare("SELECT created_at FROM provider_performance_events").get().created_at,1);
});

test("malformed explicit telemetry attempt numbers fail before writes",async t=>{
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);t.after(()=>sqlite.close());
 await ensureProviderPerformanceTelemetry(db);
 for(const attemptNo of [0,-1,1.5,NaN,Infinity,"1",null]){
  assert.throws(()=>providerPerformanceStatement(db,{providerId:"P1",eventType:"assignment_decline",impactScore:-2,attemptNo}),/positive integer/);
 }
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events").get().n,0);
});


test("forecast averages and seasonality use the same complete trailing UTC days",async t=>{
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);t.after(()=>sqlite.close());
 sqlite.exec("CREATE TABLE canonical_bookings(created_at INTEGER,service_code TEXT,city_id TEXT,status TEXT)");
 const cutoff=Date.UTC(2026,8,8),at=cutoff+6*3600000,basisDays=7;
 for(const created of [cutoff-basisDays*86400000,cutoff-1,cutoff-basisDays*86400000-1,cutoff,at+1,cutoff+3*86400000]){
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,'grooming','blr','confirmed')").run(created);
 }
 const input={serviceCode:"grooming",cityId:"blr",basisDays,horizonDays:7,at};
 const morning=await forecastDemand(db,input);
 const evening=await forecastDemand(db,{...input,at:cutoff+23*3600000});
 assert.equal(morning.dailyAverage,0.29,"only two rows inside the seven complete days may contribute");
 assert.equal(morning.forecastTotal,2,"the seven weekday averages must use those same two rows");
 assert.deepEqual(evening,morning,"the same as-of day must not drift with partial-day arrivals");
});
