import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{DatabaseSync}from"node:sqlite";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";

installWorkersHooks("__SERVICE_DISCOVERY_DB__","__SERVICE_DISCOVERY_ENV__");
globalThis.__SERVICE_DISCOVERY_ENV__={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",PAWSPACE_SCHEDULING_ENV:"uat",PAWSPACE_MAPS_ENV:"sandbox"};
const{haversineDistanceKm,schedule}=await import("../backend/src/scheduling.ts");
const{validateIndianPincode}=await import("../lib/pincode-validation.ts");
const{currentHomeBase,saveProviderHomeBase}=await import("../lib/provider-home-base.ts");
const{SERVICE_DISCOVERY_RADIUS_KM}=await import("../lib/service-discovery-address.ts");

function d1(sqlite){function statement(sql,args=[]){return{bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};}}}return{prepare:(sql)=>statement(sql),batch:async(statements)=>{const results=[];for(const statement of statements)results.push(await statement.run());return results;}};}
const provider=(id,quality,latitude,longitude,extra={})=>({id,cityId:"blr",name:id,model:"commission",services:["grooming"],zones:["blr-east"],live:true,rating:4.8,qualityScore:quality,capacity:1,travelBufferMinutes:30,maxDailyJobs:4,latitude,longitude,...extra});
const availability=(providerId,date)=>({id:`a-${providerId}-${date}`,providerId,cityId:"blr",zoneId:"blr-east",date,windows:["00:00-23:59"],source:"roster",updatedAt:new Date().toISOString()});
function repo({providers,bookings=[],unavailable=()=>false}){return{async listEligibleProviders(){return providers;},async listBookings(_city,id){return bookings.filter(row=>row.providerId===id);},async listAvailability(id,date){return[availability(id,date)];},async providerUnavailableForWindow(id,start,end){return unavailable(id,start,end);},async getPet(id){return{id,customerId:"c",legacyIds:[],name:id,species:"dog",allergies:[],vaccinationStatus:"verified",createdAt:"",updatedAt:""};},async close(){}};}
const start="2026-10-10T04:30:00.000Z",end="2026-10-10T06:30:00.000Z",request=(extra={})=>({cityId:"blr",zoneId:"blr-east",serviceCode:"grooming",petIds:["pet"],scheduledStart:start,scheduledEnd:end,latitude:12.9716,longitude:77.5946,serviceRadiusKm:SERVICE_DISCOVERY_RADIUS_KM,...extra});
function northOf(origin,km){return{latitude:origin.latitude+km/111.195,longitude:origin.longitude};}

test("16-km geofence accepts boundary-minus-epsilon and rejects boundary-plus-epsilon",async()=>{const origin={latitude:12.9716,longitude:77.5946},inside=northOf(origin,15.999),outside=northOf(origin,16.001);assert.ok(haversineDistanceKm(origin,inside)<16);assert.ok(haversineDistanceKm(origin,outside)>16);const decision=await schedule(repo({providers:[provider("outside",99,outside.latitude,outside.longitude),provider("inside",90,inside.latitude,inside.longitude)]}),request());assert.equal(decision.provider?.id,"inside");assert.match(decision.evaluations.find(item=>item.providerId==="outside").reasons.join(" "),/outside 16\.00 km service radius/);});

test("malformed pincodes are never normalized into serviceable PINs",()=>{for(const value of["560034x","x560034","560034-1","056003","56003","5600347","56 0034"])assert.equal(validateIndianPincode(value).ok,false,value);assert.deepEqual(validateIndianPincode("560034"),{ok:true,pincode:"560034"});const zones=fs.readFileSync("lib/service-zones.ts","utf8");assert.match(zones,/validateIndianPincode\(pincode\)/);assert.doesNotMatch(zones,/pincode\.replace\(\/\\D\/g/);});

test("future home-base changes are resolved at the appointment instant",async()=>{const sqlite=new DatabaseSync(":memory:"),db=d1(sqlite),now=Date.UTC(2026,8,7),future=Date.UTC(2026,9,1);await saveProviderHomeBase(db,{providerId:"groomer",address:"Old base",latitude:12.97,longitude:77.59,effectiveFrom:now-86_400_000,reason:"initial governed base",actorId:"ops"});await saveProviderHomeBase(db,{providerId:"groomer",address:"Future base",latitude:13.10,longitude:77.70,effectiveFrom:future,reason:"planned base move",actorId:"ops"});assert.equal((await currentHomeBase(db,"groomer",future-1))?.address,"Old base");assert.equal((await currentHomeBase(db,"groomer",future+1))?.address,"Future base");const route=fs.readFileSync("app/api/uat-scheduling/route.ts","utf8");assert.match(route,/loadGovernedProviders\(db,cityId,zoneId,serviceCode,appointmentAt\)/);assert.match(route,/repository\(db,input\)/);assert.match(route,/const appointmentAt=new Date\(input\.scheduledStart\)/);});

test("partial-day leave blocks only the overlapping appointment",async()=>{const leaveStart=Date.parse("2026-10-10T05:00:00.000Z"),leaveEnd=Date.parse("2026-10-10T05:30:00.000Z"),unavailable=(id,s,e)=>id==="leave"&&Date.parse(s)<leaveEnd&&Date.parse(e)>leaveStart,providers=[provider("leave",99,12.98,77.59),provider("free",90,12.99,77.59)];const during=await schedule(repo({providers,unavailable}),request());assert.equal(during.provider?.id,"free");const later=await schedule(repo({providers,unavailable}),request({scheduledStart:"2026-10-10T07:00:00.000Z",scheduledEnd:"2026-10-10T09:00:00.000Z"}));assert.equal(later.provider?.id,"leave");});

test("ranking uses workload then distance then provider id as deterministic equal-score tie breakers",async()=>{const origin={latitude:12.9716,longitude:77.5946},near=northOf(origin,2),far=northOf(origin,6),nearDistance=haversineDistanceKm(origin,near),farDistance=haversineDistanceKm(origin,far),nearQuality=90,farQuality=nearQuality+(farDistance-nearDistance)/2,base=[provider("z-near",nearQuality,near.latitude,near.longitude),provider("a-far",farQuality,far.latitude,far.longitude)];const equalized=await schedule(repo({providers:base}),request());const scores=equalized.evaluations.map(item=>item.score);assert.ok(Math.abs(scores[0]-scores[1])<1e-9,`composite scores should be equal for tie-break proof: ${scores}`);assert.equal(equalized.provider?.id,"z-near","distance is the next business tie-break after equal score/workload");const exact=[provider("z-id",90,near.latitude,near.longitude),provider("a-id",90,near.latitude,near.longitude)];const byId=await schedule(repo({providers:exact}),request());assert.equal(byId.provider?.id,"a-id");const busyBooking={id:"b",providerId:"a-id",status:"assigned",scheduledStart:"2026-10-10T00:30:00.000Z",scheduledEnd:"2026-10-10T01:30:00.000Z",petIds:["x"],capacityUnits:1};const byWorkload=await schedule(repo({providers:exact,bookings:[busyBooking]}),request());assert.equal(byWorkload.provider?.id,"z-id");});

function capacityDb(){const sqlite=new DatabaseSync(":memory:");sqlite.exec("CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL); CREATE UNIQUE INDEX active_exact ON scheduling_reservations(provider_id,scheduled_start,scheduled_end) WHERE status!='cancelled';");return sqlite;}
function slotAttempt(sqlite,id,s,e){return Promise.resolve().then(()=>{const info=sqlite.prepare("INSERT INTO scheduling_reservations (id,provider_id,scheduled_start,scheduled_end,status) SELECT ?,'p',?,?,'assigned' WHERE NOT EXISTS (SELECT 1 FROM scheduling_reservations WHERE provider_id='p' AND status!='cancelled' AND scheduled_start<? AND scheduled_end>?) ON CONFLICT(provider_id,scheduled_start,scheduled_end) WHERE status!='cancelled' DO NOTHING").run(id,s,e,e,s);return Number(info.changes);});}
test("20-way same-slot contention produces exactly one active reservation",async()=>{const sqlite=capacityDb(),changes=await Promise.all(Array.from({length:20},(_,i)=>slotAttempt(sqlite,`r${i}`,start,end)));assert.equal(changes.reduce((a,b)=>a+b,0),1);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE status!='cancelled'").get().n,1);});

test("20-way daily-cap contention stops exactly at configured capacity",async()=>{const sqlite=new DatabaseSync(":memory:");sqlite.exec("CREATE TABLE r (id TEXT PRIMARY KEY,provider_id TEXT,scheduled_start TEXT,status TEXT);");const cap=4,attempt=async i=>{const s=new Date(Date.UTC(2026,9,10,0,i)).toISOString();const info=sqlite.prepare("INSERT INTO r (id,provider_id,scheduled_start,status) SELECT ?,'p',?,'assigned' WHERE (SELECT COUNT(*) FROM r WHERE provider_id='p' AND status!='cancelled' AND substr(scheduled_start,1,10)='2026-10-10')<?").run(`d${i}`,s,cap);return Number(info.changes);},changes=await Promise.all(Array.from({length:20},(_,i)=>attempt(i)));assert.equal(changes.reduce((a,b)=>a+b,0),cap);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM r").get().n,cap);});

test("write path reasserts zone, service, effective period and exact unavailability overlap",()=>{const route=fs.readFileSync("app/api/uat-scheduling/route.ts","utf8");assert.match(route,/json_each\(p\.services_json\)/);assert.match(route,/json_each\(p\.zones_json\)/);assert.match(route,/p\.effective_from<=\?/);assert.match(route,/p\.effective_to IS NULL OR p\.effective_to>=\?/);assert.match(route,/u\.starts_at<\? AND u\.ends_at>\?/);assert.doesNotMatch(route,/blockedProviders\(date/);});

test("server address authority overwrites browser city zone coordinates and radius",()=>{const route=fs.readFileSync("app/api/uat-scheduling/route.ts","utf8"),authority=fs.readFileSync("lib/service-discovery-address.ts","utf8");assert.match(route,/resolveGovernedServiceAddress\(db,/);assert.match(route,/input=\{\.\.\.input,cityId:governed\.cityId,zoneId:governed\.zoneId,latitude:governed\.latitude,longitude:governed\.longitude,serviceRadiusKm:governed\.serviceRadiusKm\}/);assert.match(authority,/SERVICE_DISCOVERY_RADIUS_KM=16/);assert.match(authority,/geocodeAddress\(\{address\}\)/);});
// ---------------------------------------------------------------------------------------------------
// LP-N11. A sitting booking was created, payment captured five minutes later through the staff sandbox,
// and the sitter's Accept was then refused 409: provider_assignment_offers.expires_at was offered_at +
// 180s. The seeded commission sitters and hosts (sit_sana, sit_neha, sit_asha, host_*) carried a
// three-minute acceptance window, which expires before a tester can finish checkout. uatcap_sit_cm
// already had 60 and worked, which is why the same journey passed elsewhere.
//
// Owner decision 2026-09-22: 30 minutes, for the advance-booked verticals. Pet Taxi and Dog Walking are
// live dispatch, where a 30-minute window to accept a ride would be operationally wrong, so they keep 3.
//
// The seed writes with INSERT OR IGNORE, so a longer window would never have reached a database that
// already held these rows - which is exactly why staging kept refusing. These cases execute the real
// seeder against SQLite and read the rows back.
// ---------------------------------------------------------------------------------------------------

const { seedProviderCapacityDefaults, getProviderAcceptanceTimeout } = await import("../lib/provider-capacity-governance.ts");
const seededCapacity = () => new DatabaseSync(":memory:");

test("LP-N11: seeded sitters and hosts get a 30-minute acceptance window, taxi and walking keep three", async () => {
  const sqlite = seededCapacity();
  await seedProviderCapacityDefaults(d1(sqlite));
  for (const id of ["sit_sana", "sit_neha", "sit_asha", "host_sana", "host_maya_rohan", "host_arjun_tara", "host_priya_dev"]) {
    assert.equal(await getProviderAcceptanceTimeout(d1(sqlite), id), 30, `${id} must have the advance-booking window`);
  }
  for (const id of ["taxi_rahul", "taxi_meera", "walk_nisha", "walk_kiran", "walk_asha"]) {
    assert.equal(await getProviderAcceptanceTimeout(d1(sqlite), id), 3, `${id} is live dispatch and must keep the short window`);
  }
  sqlite.close();
});

test("LP-N11: a database already holding the three-minute rows is repaired, not ignored", async () => {
  const sqlite = seededCapacity();
  await seedProviderCapacityDefaults(d1(sqlite));
  // Put the database back into the state staging was actually in: the row exists, at three minutes.
  // INSERT OR IGNORE alone can never fix that, which is the whole defect.
  sqlite.prepare("UPDATE provider_capacity_profiles SET acceptance_timeout_minutes=3 WHERE id='sit_sana'").run();
  const raw = () => sqlite.prepare("SELECT acceptance_timeout_minutes m FROM provider_capacity_profiles WHERE id='sit_sana'").get().m;
  // Read the row directly: getProviderAcceptanceTimeout seeds on the way in, so asking it would
  // already repair the row and the precondition could never be observed.
  assert.equal(raw(), 3, "precondition: the stale row is back");

  await seedProviderCapacityDefaults(d1(sqlite));
  assert.equal(raw(), 30, "the seeder itself must repair the stored row, not just the read");
  assert.equal(await getProviderAcceptanceTimeout(d1(sqlite), "sit_sana"), 30, "a redeploy must repair the stale row");
  sqlite.close();
});

test("LP-N11: the repair only ever raises, so a longer window set by anyone else survives", async () => {
  const sqlite = seededCapacity();
  await seedProviderCapacityDefaults(d1(sqlite));
  // An operator lengthens one window through Control, and a uatcap_* profile already carries 60.
  sqlite.prepare("UPDATE provider_capacity_profiles SET acceptance_timeout_minutes=120 WHERE id='sit_neha'").run();
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_sit_cm','blr','PawSpace Sitter (UAT)','commission','[\"pet_sitting\"]','[\"blr-east\"]',1,4.9,95,4,30,12,60,'active',1,'2026-01-01',NULL,'founder_seed',1)").run();

  await seedProviderCapacityDefaults(d1(sqlite));
  assert.equal(await getProviderAcceptanceTimeout(d1(sqlite), "sit_neha"), 120, "a longer window must not be cut back to 30");
  assert.equal(await getProviderAcceptanceTimeout(d1(sqlite), "uatcap_sit_cm"), 60, "the 60-minute UAT profile must not be cut back to 30");
  sqlite.close();
});
