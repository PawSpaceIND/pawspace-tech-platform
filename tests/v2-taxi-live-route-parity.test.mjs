import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");

test("Taxi quote freezes server-verified route coordinates",()=>{
 const commercial=read("app/api/taxi-commercial/route.ts");
 const governance=read("lib/taxi-ride-governance.ts");
 assert.match(commercial,/geocodeAddress/);
 assert.match(commercial,/originGeo/);
 assert.match(commercial,/destinationGeo/);
 assert.match(governance,/origin_latitude REAL/);
 assert.match(governance,/destination_latitude REAL/);
 assert.match(governance,/Pet Taxi route coordinates must be verified before quoting/);
});

test("Taxi booking persists canonical route coordinates instead of client coordinates",()=>{
 const route=read("app/api/taxi-ride-bookings/route.ts");
 assert.match(route,/governed\.origin\.latitude/);
 assert.match(route,/governed\.destination\.longitude/);
 assert.match(route,/taxi_ride_booking_details/);
 assert.doesNotMatch(route,/input\.originLatitude|input\.destinationLatitude/);
});

test("customer Taxi live map switches from pickup to dropoff by lifecycle state",()=>{
 const route=read("app/api/customer-live-tracking/route.ts");
 assert.match(route,/async function taxiDestination/);
 assert.match(route,/\["in_progress","arrived_dropoff","dropoff_confirmed"\]/);
 assert.match(route,/row\.destination_latitude/);
 assert.match(route,/row\.origin_latitude/);
 assert.match(route,/phase:inRide\?"dropoff":"pickup"/);
});

test("customer Taxi route line starts from privacy-rounded provider GPS",()=>{
 const route=read("app/api/customer-live-tracking/route.ts");
 assert.match(route,/Math\.round\(Number\(point\.latitude\)\*1000\)\/1000/);
 assert.match(route,/computeGoogleRoute\(rounded,destination\.label\)/);
 assert.match(route,/privacyRounded:true/);
});

test("existing Taxi staging databases receive additive coordinate columns",()=>{
 const governance=read("lib/taxi-ride-governance.ts");
 for(const column of["origin_latitude","origin_longitude","destination_latitude","destination_longitude","return_drop_latitude","return_drop_longitude"]){
   assert.ok(governance.includes('["taxi_ride_quotes","'+column+'"')||governance.includes('["taxi_ride_booking_details","'+column+'"'),column+" must be in the additive migration allowlist");
 }
 assert.match(governance,/ALTER TABLE \\${table} ADD COLUMN \\${column} \\${type}/);
});
