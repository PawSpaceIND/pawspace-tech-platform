import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{freshSqlite,makeD1}from"./helpers/taxi-harness.mjs";

const journey=await import("../lib/live-journey-destination.ts");
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");

function world(){
 const sqlite=freshSqlite(),db=makeD1(sqlite);
 return{sqlite,db};
}

test("Taxi live destination switches from canonical pickup to drop-off",async()=>{
 const{sqlite,db}=world();
 sqlite.exec("CREATE TABLE taxi_trips (booking_id TEXT PRIMARY KEY,status TEXT NOT NULL)");
 sqlite.exec("CREATE TABLE taxi_ride_booking_details (booking_id TEXT PRIMARY KEY,origin_latitude REAL,origin_longitude REAL,destination_latitude REAL,destination_longitude REAL)");
 sqlite.prepare("INSERT INTO taxi_trips VALUES (?,?)").run("B-TAXI","vehicle_assigned");
 sqlite.prepare("INSERT INTO taxi_ride_booking_details VALUES (?,?,?,?,?)").run("B-TAXI",12.97,77.64,12.95,77.70);
 assert.deepEqual(await journey.resolveLiveJourneyDestination(db,{bookingId:"B-TAXI",serviceCode:"pet_taxi",status:"vehicle_assigned"}),{latitude:12.97,longitude:77.64,phase:"pickup"});
 assert.deepEqual(await journey.resolveLiveJourneyDestination(db,{bookingId:"B-TAXI",serviceCode:"pet_taxi",status:"in_progress"}),{latitude:12.95,longitude:77.70,phase:"dropoff"});
});

test("Walking live destination reuses the canonical doorstep resolver",async()=>{
 const{sqlite,db}=world();
 sqlite.exec("CREATE TABLE booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 sqlite.prepare("INSERT INTO booking_service_locations VALUES (?,?,?,?,?,?,?,?,?)").run("B-WALK","C1","P1","Doorstep",12.981,77.611,"active",1,1);
 assert.deepEqual(await journey.resolveLiveJourneyDestination(db,{bookingId:"B-WALK",serviceCode:"dog_walking",status:"assigned"}),{latitude:12.981,longitude:77.611,phase:"service_doorstep"});
});

test("record_location automatically refreshes ETA only from accepted GPS evidence",()=>{
 const route=read("app/api/location-recovery/route.ts");
 assert.match(route,/refreshEtaForAcceptedFix/);
 assert.match(route,/if\(input\.trustState!==\"accepted\"\)return null/);
 assert.match(route,/resolveLiveJourneyDestination/);
 assert.match(route,/computeGoogleRoute\(\{lat:input\.lat,lng:input\.lng\},\{lat:destination\.latitude,lng:destination\.longitude\}\)/);
 assert.match(route,/recordEtaSnapshot/);
 assert.match(route,/eta=await refreshEtaForAcceptedFix/);
 assert.match(route,/telemetryMode:eta\?\"sandbox_adapter\":\"deterministic_sandbox\"/);
});

test("customer and provider tracking share one canonical journey destination",()=>{
 const customer=read("app/api/customer-live-tracking/route.ts");
 const provider=read("app/api/location-recovery/route.ts");
 for(const source of[customer,provider])assert.match(source,/live-journey-destination/);
 assert.doesNotMatch(customer,/async function taxiDestination/);
});
