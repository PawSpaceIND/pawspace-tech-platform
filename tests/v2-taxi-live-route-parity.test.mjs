/*
 * Pet Taxi live-route parity. Quote pricing, coordinate freezing, the additive migration and both
 * route adapters are EXECUTED against a real SQLite-backed D1 with Google Maps captured at the fetch
 * boundary. The remaining source assertions cover route handlers whose auth + booking fixture surface
 * is out of scope for this suite.
 */
import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";
import{freshSqlite,makeD1,refusal,taxiUrl,futurePickup}from"./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_LIVE_ROUTE_DB__","__TAXI_LIVE_ROUTE_ENV__");
const governance=await import("../lib/taxi-ride-governance.ts");
const pricing=await import("../lib/taxi-route-pricing.ts");
const maps=await import("../lib/grooming-maps.ts");
const commercialRoute=await import("../app/api/taxi-commercial/route.ts");

const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const COORDS=["origin_latitude","origin_longitude","destination_latitude","destination_longitude","return_drop_latitude","return_drop_longitude"];
const PICKUP={latitude:12.9719,longitude:77.6412},DROP={latitude:12.9698,longitude:77.75};
const PICKUP_LABEL="Indiranagar 100ft Road, Bengaluru",DROP_LABEL="Whitefield Main Road, Bengaluru";
const GEOCODED={[PICKUP_LABEL]:PICKUP,[DROP_LABEL]:DROP};
const latLng=point=>({location:{latLng:point}});

function world(){
 const sqlite=freshSqlite(),db=makeD1(sqlite);
 globalThis.__TAXI_LIVE_ROUTE_DB__=db;
 globalThis.__TAXI_LIVE_ROUTE_ENV__={PAWSPACE_MAPS_ENV:"sandbox",GOOGLE_MAPS_SERVER_API_KEY_UAT:"fixture-server-key"};
 return{sqlite,db};
}
/** Google Geocoding + Routes captured at the fetch boundary; returns the Routes request bodies. */
function stubMaps(t){
 const original=globalThis.fetch,routeBodies=[];
 globalThis.fetch=async(url,init={})=>{
  const target=new URL(String(url));
  if(target.pathname.endsWith("/geocode/json")){
   const address=target.searchParams.get("address"),point=GEOCODED[address];
   return Response.json(point?{status:"OK",results:[{formatted_address:address,geometry:{location:{lat:point.latitude,lng:point.longitude}}}]}:{status:"ZERO_RESULTS",results:[]});
  }
  if(target.hostname==="routes.googleapis.com"){routeBodies.push(JSON.parse(String(init.body)));return Response.json({routes:[{distanceMeters:14200,duration:"2400s",polyline:{encodedPolyline:"enc"}}]});}
  throw new Error("unexpected fetch "+target);
 };
 t.after(()=>{globalThis.fetch=original;});
 return routeBodies;
}
const postQuote=body=>commercialRoute.POST(new Request(taxiUrl("/api/taxi-commercial"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scheduledStart:futurePickup(),passengerCount:1,petCount:1,luggageCount:0,...body})}));
const rideInput=(overrides={})=>({originLabel:PICKUP_LABEL,destinationLabel:DROP_LABEL,origin:PICKUP,destination:DROP,passengerCount:1,petCount:1,luggageCount:0,scheduledStart:futurePickup(),tripType:"one_way",ridePurpose:"regular",waitingMinutes:0,distanceKm:14.2,estimatedDurationMinutes:40,routeProvider:"google_routes_uat",...overrides});

test("Taxi quote prices and freezes the same server-geocoded coordinates",async t=>{
 const{db}=world(),routeBodies=stubMaps(t);
 const response=await postQuote({originLabel:PICKUP_LABEL,destinationLabel:DROP_LABEL,tripType:"one_way",ridePurpose:"regular"});
 const body=await response.json();
 assert.equal(response.status,201,JSON.stringify(body));
 assert.equal(routeBodies.length,1);
 assert.deepEqual(routeBodies[0].origin,latLng(PICKUP),"the priced leg starts at the geocoded pickup, not a re-resolved address");
 assert.deepEqual(routeBodies[0].destination,latLng(DROP),"and ends at the geocoded drop-off");
 assert.equal(body.data.distanceKm,14.2);
 const row=await db.prepare("SELECT origin_latitude,origin_longitude,destination_latitude,destination_longitude,distance_km FROM taxi_ride_quotes WHERE id=?").bind(body.data.quoteId).first();
 assert.deepEqual({latitude:row.origin_latitude,longitude:row.origin_longitude},PICKUP,"frozen pickup equals the priced pickup");
 assert.deepEqual({latitude:row.destination_latitude,longitude:row.destination_longitude},DROP,"frozen drop-off equals the priced drop-off");
 assert.equal(row.distance_km,14.2);

 const unresolved=await postQuote({originLabel:"Unknown place nowhere at all",destinationLabel:DROP_LABEL});
 assert.equal(unresolved.status,409,"an address without verified coordinates is never priced");
 assert.equal(routeBodies.length,1,"and no route call is spent on it");

 const badType=await postQuote({originLabel:PICKUP_LABEL,destinationLabel:DROP_LABEL,tripType:"multi_stop"});
 assert.equal(badType.status,400);
 assert.equal((await badType.json()).error,"Unsupported Pet Taxi trip type");
});

test("Taxi ride quote refuses unverified coordinates and unsupported trip type or purpose",async()=>{
 const{db}=world();
 const quote=await governance.createTaxiRideQuote(db,rideInput());
 const row=await db.prepare("SELECT trip_type,ride_purpose,origin_latitude,destination_longitude FROM taxi_ride_quotes WHERE id=?").bind(quote.quoteId).first();
 assert.deepEqual({...row},{trip_type:"one_way",ride_purpose:"regular",origin_latitude:PICKUP.latitude,destination_longitude:DROP.longitude});
 const missing=await refusal(governance.createTaxiRideQuote(db,rideInput({destination:{latitude:Number.NaN,longitude:77.75}})));
 assert.equal(missing?.status,409);assert.match(missing.message,/route coordinates must be verified/);
 const roundTrip=await refusal(governance.createTaxiRideQuote(db,rideInput({tripType:"round_trip",returnDropLabel:"Koramangala 5th Block, Bengaluru",waitingMinutes:30})));
 assert.equal(roundTrip?.status,409,"a round trip without a verified return point is refused");
 assert.deepEqual(await refusal(governance.createTaxiRideQuote(db,rideInput({tripType:"multi_stop"}))),{status:400,message:"Unsupported Pet Taxi trip type"});
 assert.deepEqual(await refusal(governance.createTaxiRideQuote(db,rideInput({ridePurpose:"cargo"}))),{status:400,message:"Unsupported Pet Taxi ride purpose"});
 assert.deepEqual(await refusal(governance.createTaxiRideQuote(db,rideInput({tripType:undefined}))),{status:400,message:"Unsupported Pet Taxi trip type"});
 const{count}=await db.prepare("SELECT COUNT(*) AS count FROM taxi_ride_quotes").first();
 assert.equal(Number(count),1,"no refused input is persisted");

 const option=quote.fareOptions.citroen_ec3;
 const governed=await governance.governTaxiRideBooking(db,{quoteId:quote.quoteId,vehicleClass:"citroen_ec3",petCount:1,scheduledStart:quote.scheduledStart,scheduledEnd:quote.scheduledEnd,submittedTotal:Number(option.quotedTotal),submittedAmountDueNow:Number(option.bookingFee),reservations:[{service_code:"pet_taxi",scheduled_start:quote.scheduledStart,scheduled_end:quote.scheduledEnd}]});
 assert.deepEqual(governed.origin,PICKUP,"booking governance hands back the frozen quote coordinates");
 assert.deepEqual(governed.destination,DROP);
});

test("Taxi route leg sends verified coordinates as latLng waypoints",async()=>{
 const env={PAWSPACE_MAPS_ENV:"sandbox",GOOGLE_MAPS_SERVER_API_KEY_UAT:"fixture-key"},bodies=[];
 const fetcher=async(_url,init)=>{bodies.push(JSON.parse(String(init.body)));return Response.json({routes:[{distanceMeters:5000,duration:"600s"}]});};
 const leg=await pricing.computeTaxiRouteLeg(env,PICKUP,DROP,fetcher);
 assert.deepEqual(leg,{distanceKm:5,durationMinutes:10,provider:"google_routes_uat",providerReference:"google_routes_uat"});
 assert.deepEqual(bodies[0].origin,latLng(PICKUP));
 assert.deepEqual(bodies[0].destination,latLng(DROP));
 for(const[origin,destination]of[[PICKUP,{...PICKUP}],[{latitude:91,longitude:77},DROP],[PICKUP,{latitude:12.9,longitude:Number.NaN}]]){
  assert.equal((await refusal(pricing.computeTaxiRouteLeg(env,origin,destination,fetcher)))?.status,400);
 }
 assert.equal(bodies.length,1,"an invalid or identical coordinate pair never reaches Google");
});

test("Taxi booking persists canonical route coordinates instead of client coordinates",()=>{
 const route=read("app/api/taxi-ride-bookings/route.ts");
 assert.match(route,/governed\.origin\.latitude/);
 assert.match(route,/governed\.destination\.longitude/);
 assert.match(route,/taxi_ride_booking_details/);
 assert.doesNotMatch(route,/input\.originLatitude|input\.destinationLatitude/);
});

test("customer Taxi live map switches from pickup to dropoff by lifecycle state",()=>{
 const route=read("app/api/customer-live-tracking/route.ts"),journey=read("lib/live-journey-destination.ts");
 assert.match(route,/resolveLiveJourneyDestination/);
 assert.match(journey,/\["in_progress","arrived_dropoff","dropoff_confirmed"\]/);
 assert.match(journey,/row\.destination_latitude/);
 assert.match(journey,/row\.origin_latitude/);
 assert.match(journey,/phase:inRide\?"dropoff":"pickup"/);
});

test("customer Taxi route line runs from privacy-rounded GPS to the verified marker coordinates",async t=>{
 world();
 const original=globalThis.fetch,bodies=[];
 globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init.body)));return Response.json({routes:[{distanceMeters:4200,duration:"540s",polyline:{encodedPolyline:"abc"}}]});};
 t.after(()=>{globalThis.fetch=original;});
 const route=await maps.computeGoogleRoute({lat:12.972,lng:77.641},{lat:DROP.latitude,lng:DROP.longitude});
 assert.equal(route.status,"configured");
 assert.deepEqual(bodies[0].destination,latLng(DROP),"the polyline ends where the verified destination marker is drawn");
 assert.equal((await maps.computeGoogleRoute({lat:12.972,lng:77.641},{lat:Number.NaN,lng:77.75})).status,"route_unavailable");
 assert.equal(bodies.length,1,"an invalid destination point never reaches Google");
 assert.equal((await maps.computeGoogleRoute({lat:12.972,lng:77.641},"12 MG Road, Bengaluru")).status,"configured","address destinations keep working for other callers");
 assert.deepEqual(bodies[1].destination,{address:"12 MG Road, Bengaluru"});

 const source=read("app/api/customer-live-tracking/route.ts");
 assert.match(source,/Math\.round\(Number\(point\.latitude\)\*1000\)\/1000/);
 assert.match(source,/computeGoogleRoute\(rounded,\{lat:destination\.latitude,lng:destination\.longitude\}\)/);
 assert.match(source,/privacyRounded:true/);
});

test("existing Taxi staging databases receive additive coordinate columns on BOTH tables",async()=>{
 const{sqlite,db}=world();
 sqlite.exec("CREATE TABLE taxi_ride_quotes (id TEXT PRIMARY KEY,origin_label TEXT NOT NULL)");
 sqlite.exec("CREATE TABLE taxi_ride_booking_details (booking_id TEXT PRIMARY KEY,quote_id TEXT NOT NULL UNIQUE)");
 await governance.ensureTaxiRideTables(db);
 await governance.ensureTaxiRideTables(db);
 for(const table of["taxi_ride_quotes","taxi_ride_booking_details"]){
  const columns=new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
  for(const column of COORDS)assert.ok(columns.has(column),`${table}.${column} must be added to a pre-existing table`);
 }
});

// ---------------------------------------------------------------------------------------------
// ROUND 2 (26 Sep 2026 staging): a fare quote ran ~45 s and the customer read "Unexpected token '<'" (the
// platform's HTML error page parsed as JSON); a pickup at Mysore Palace was priced and bookable; and the
// Citroën card printed rule codes.
const MYSORE_LABEL="Mysore Palace, Mysuru",AIRPORT_LABEL="Kempegowda International Airport, Bengaluru";
GEOCODED[MYSORE_LABEL]={latitude:12.3052,longitude:76.6552};
GEOCODED[AIRPORT_LABEL]={latitude:13.1986,longitude:77.7066};
const quoteRequest=body=>new Request(taxiUrl("/api/taxi-commercial"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scheduledStart:futurePickup(),passengerCount:1,petCount:1,luggageCount:0,originLabel:PICKUP_LABEL,destinationLabel:DROP_LABEL,...body})});

test("round 2: a quote that runs past its deadline answers a governed 503 with Retry-After, not the platform's page",async t=>{
 const{db}=world();stubMaps(t);
 // D1 stops answering while the quote is written (staging: ~45 s, then the platform's HTML 500).
 db.onSql("INSERT INTO taxi_ride_quotes",()=>new Promise(()=>{}));
 const started=performance.now(),response=await commercialRoute.executeTaxiRideQuote(quoteRequest({}),{deadlineMs:150}),elapsed=performance.now()-started;
 assert.equal(response.status,503);
 assert.equal(response.headers.get("retry-after"),"5");
 assert.match(response.headers.get("content-type")||"",/application\/json/);
 const body=await response.json();
 assert.deepEqual({code:body.code,retryAfterSeconds:body.retryAfterSeconds},{code:"TAXI_QUOTE_TIMEOUT",retryAfterSeconds:5});
 assert.match(body.error,/taking longer than usual\. Please try again/);
 assert.ok(elapsed<1000,`answered at the deadline (${Math.round(elapsed)} ms), not when D1 came back`);
 assert.ok(commercialRoute.TAXI_QUOTE_DEADLINE_MS<=25_000,"the live deadline answers before the ~30 s platform and proxy cut-offs");
});

test("round 2: a D1 failure during a quote is a governed 503 retry, never a raw or redacted 500",async t=>{
 const{db}=world();stubMaps(t);
 db.onSql("INSERT INTO taxi_ride_quotes",()=>{throw new Error("D1_ERROR: Currently processing a long-running import.");});
 const response=await commercialRoute.POST(quoteRequest({}));
 const body=await response.json();
 assert.equal(response.status,503,JSON.stringify(body));
 assert.equal(body.code,"TAXI_QUOTE_UNAVAILABLE");
 assert.doesNotMatch(body.error,/D1_ERROR|commercial request failed/);
 assert.match(body.error,/Please try again/);
 // Non-vacuity: once D1 answers again, the same request is priced.
 assert.equal((await commercialRoute.POST(quoteRequest({}))).status,201);
});

test("round 2: a pickup outside the service area is refused on its geocoded coordinates before any route is priced",async t=>{
 world();const routeBodies=stubMaps(t);
 const mysore=await commercialRoute.POST(quoteRequest({originLabel:MYSORE_LABEL}));
 const body=await mysore.json();
 assert.equal(mysore.status,409,JSON.stringify(body));
 assert.match(body.error,/PawSpace Pet Taxi picks up only within Bengaluru \(up to 35 km from the city centre\)/);
 assert.equal(routeBodies.length,0,"no Routes call is spent on a pickup PawSpace cannot serve");
 // Inside the city - the airport included - is priced, and a long ride OUT of the city is a product, not a refusal.
 assert.equal((await commercialRoute.POST(quoteRequest({originLabel:AIRPORT_LABEL,ridePurpose:"airport"}))).status,201);
 assert.equal((await commercialRoute.POST(quoteRequest({destinationLabel:MYSORE_LABEL}))).status,201);
 const{assertTaxiPickupInServiceArea}=await import("../lib/taxi-service-area.ts");
 const{db}=world();
 await assert.rejects(()=>assertTaxiPickupInServiceArea(db,{pickup:GEOCODED[MYSORE_LABEL],cityId:"blr"}),error=>error instanceof Response&&error.status===409);
 assert.equal((await assertTaxiPickupInServiceArea(db,{pickup:PICKUP,cityId:"blr"}))?.cityCode,"blr");
});

test("round 2: the Citroën card explains why it cannot take the ride in plain words",async t=>{
 world();stubMaps(t);
 const response=await commercialRoute.POST(quoteRequest({passengerCount:4,petCount:3,luggageCount:4}));
 const body=await response.json();
 assert.equal(response.status,201,JSON.stringify(body));
 const citroen=body.data.fareOptions.citroen_ec3;
 assert.equal(citroen.eligible,false);
 assert.equal(citroen.ineligibleReason,"Seats up to 3 passengers and 3 bags — choose the XUV");
 assert.doesNotMatch(citroen.ineligibleReason,/more_than|_/);
 assert.equal(body.data.fareOptions.xuv.eligible,true);
});
