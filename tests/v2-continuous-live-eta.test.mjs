/*
 * Continuous live ETA for Walking and Pet Taxi, executed rather than described.
 *
 * record_location is driven through the real POST handler of app/api/location-recovery/route.ts against a
 * SQLite-backed D1 built from the production ensure*Tables DDL, with Google Routes captured at the fetch
 * boundary, and the route_eta_snapshots rows it persists are read back. The earlier version of the
 * record_location test regex-matched the route source, so it stayed green whether or not an accepted fix ever
 * produced a snapshot.
 */
import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{enterWorkersDbScope,installWorkersHooks}from"./helpers/module-hooks.mjs";
import{customerSessionCookie,freshSqlite,makeD1,OPS_ORIGIN}from"./helpers/taxi-harness.mjs";

installWorkersHooks("__LIVE_ETA_DB__","__LIVE_ETA_ENV__");
globalThis.__LIVE_ETA_ENV__={APP_ENV:"staging",PAWSPACE_MAPS_ENV:"sandbox",GOOGLE_MAPS_SERVER_API_KEY_UAT:"fixture-server-key"};
const journey=await import("../lib/live-journey-destination.ts");
const locationRoute=await import("../app/api/location-recovery/route.ts");
const customerRoute=await import("../app/api/customer-live-tracking/route.ts");
const{ensureSecurityTables}=await import("../lib/server-auth.ts");
const{ensureCanonicalBookingCoreTables}=await import("../lib/canonical-booking-core-schema.ts");
const{ensureCustomerLiveTrackingServiceTables}=await import("../lib/customer-live-tracking-schema.ts");
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");

const STAFF="ops.live-eta@pawspace.in",PROVIDER="PRV-LIVE-ETA",CUSTOMER="CUST-LIVE-ETA";
const PICKUP={latitude:12.9719,longitude:77.6412},DROP={latitude:12.9698,longitude:77.75},DOORSTEP={latitude:12.981,longitude:77.611};
const GPS={latitude:12.975,longitude:77.63};
const latLng=point=>({location:{latLng:point}});

function world(){
 const sqlite=freshSqlite(),db=makeD1(sqlite);
 enterWorkersDbScope(db);
 return{sqlite,db};
}

/** One canonical booking in the production schema, with the accepted work order the customer view falls back to. */
async function seedBooking(db,sqlite,{id,serviceCode,status}){
 await ensureCanonicalBookingCoreTables(db);await ensureCustomerLiveTrackingServiceTables(db);
 const now=Date.now(),start=new Date(now+30*60_000).toISOString(),end=new Date(now+90*60_000).toISOString();
 sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,?,?,?,?,?,?,?,499,'harness',?,?)")
  .run(id,`idem-${id}`,CUSTOMER,serviceCode,serviceCode,serviceCode,`GRP-${id}`,PROVIDER,start,end,status,now,now);
 sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,'Live ETA provider','full_time',?,?,?,'accepted',?,?)")
  .run(`WO-${id}`,id,`GRP-${id}`,PROVIDER,serviceCode,start,end,now,now);
 return{start,end,now};
}
async function seedTaxi(db,sqlite,{id="BK-TAXI-LIVE",bookingStatus="assigned",tripStatus="vehicle_assigned"}={}){
 const{start,end,now}=await seedBooking(db,sqlite,{id,serviceCode:"pet_taxi",status:bookingStatus});
 sqlite.prepare("INSERT INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,'Indiranagar pickup point','Whitefield veterinary clinic','taxi-blr-east-short',5,45,?,?,?,?,?)")
  .run(`TRIP-${id}`,id,`GRP-${id}`,`RES-${id}`,PROVIDER,start,end,tripStatus,now,now);
 sqlite.prepare("INSERT INTO taxi_ride_booking_details (booking_id,quote_id,vehicle_class,passenger_count,pet_count,luggage_count,trip_type,ride_purpose,waiting_minutes,origin_latitude,origin_longitude,destination_latitude,destination_longitude,distance_km,estimated_duration_minutes,initial_total,final_total,booking_fee_amount,created_at,updated_at) VALUES (?,?,'citroen_ec3',1,1,0,'one_way','regular',0,?,?,?,?,14.2,40,499,499,99,?,?)")
  .run(id,`QUOTE-${id}`,PICKUP.latitude,PICKUP.longitude,DROP.latitude,DROP.longitude,now,now);
 return id;
}
async function seedWalk(db,sqlite,{id="BK-WALK-LIVE",bookingStatus="assigned",sessions=["scheduled"]}={}){
 const{start,end,now}=await seedBooking(db,sqlite,{id,serviceCode:"dog_walking",status:bookingStatus});
 sessions.forEach((status,index)=>sqlite.prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run(`WALK-${id}-${index+1}`,id,`GRP-${id}`,`RES-${id}-${index+1}`,PROVIDER,index+1,start,end,status,now,now));
 sqlite.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,status,created_at,updated_at) VALUES (?,?,?,'12 Doorstep Road, Bengaluru',?,?,'active',?,?)")
  .run(id,CUSTOMER,PROVIDER,DOORSTEP.latitude,DOORSTEP.longitude,now,now);
 return id;
}

const post=body=>locationRoute.POST(new Request(`${OPS_ORIGIN}/api/location-recovery`,{method:"POST",headers:{"oai-authenticated-user-email":STAFF,"content-type":"application/json",origin:OPS_ORIGIN},body:JSON.stringify(body)}));
async function act(body){
 const response=await post(body),payload=await response.json();
 assert.equal(response.status,200,`${body.action}: ${JSON.stringify(payload)}`);
 return payload.data;
}
/** A real operator, an approved punctuality policy and a started session: everything record_location needs. */
async function trackingSession(db,sqlite,serviceCode,bookingId){
 await ensureSecurityTables(db);
 const now=Date.now();
 sqlite.prepare("INSERT OR IGNORE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-LIVE-ETA',?,'Live ETA operator','manager','active',?,?)").run(STAFF,now,now);
 await act({action:"save_policy",id:`PUNC-${serviceCode}`,serviceCode,etaFreshnessSeconds:300,allowedAccuracyMeters:50,customerAlertMinutes:10,opsEscalationMinutes:15,reassignmentMinutes:20,rawGpsRetentionDays:30,approvalState:"approved",effectiveFrom:"2026-01-01"});
 return String((await act({action:"start_session",bookingId,providerId:PROVIDER})).id);
}
const recordFix=(sessionId,overrides={})=>act({action:"record_location",sessionId,providerId:PROVIDER,latitude:GPS.latitude,longitude:GPS.longitude,accuracyMeters:12,clientCapturedAt:Date.now(),...overrides});

/** Google Routes captured at the fetch boundary. `during(n)` runs while the n-th Routes call is in flight. */
function stubRoutes(t,{during=()=>{},respond=()=>Response.json({routes:[{distanceMeters:4200,duration:"540s",polyline:{encodedPolyline:"live-polyline"}}]})}={}){
 const original=globalThis.fetch,bodies=[];
 globalThis.fetch=async(url,init={})=>{
  const target=new URL(String(url));
  if(target.hostname!=="routes.googleapis.com")throw new Error(`unexpected fetch ${target}`);
  bodies.push(JSON.parse(String(init.body)));
  await during(bodies.length);
  return respond();
 };
 t.after(()=>{globalThis.fetch=original;});
 return bodies;
}
const snapshots=(sqlite,bookingId)=>sqlite.prepare("SELECT * FROM route_eta_snapshots WHERE booking_id=? ORDER BY rowid").all(bookingId);
const setStatus=(sqlite,bookingId,{trip,booking})=>{
 if(trip)sqlite.prepare("UPDATE taxi_trips SET status=? WHERE booking_id=?").run(trip,bookingId);
 if(booking)sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id=?").run(booking,bookingId);
};

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

test("states outside a live journey have no destination instead of defaulting to the Taxi pickup",async()=>{
 const{sqlite,db}=world();
 const taxi=await seedTaxi(db,sqlite),walk=await seedWalk(db,sqlite);
 const resolve=(bookingId,serviceCode,status)=>journey.resolveLiveJourneyDestination(db,{bookingId,serviceCode,status});
 for(const status of["confirmed","scheduled","assigned","accepted","vehicle_assigned","pickup_confirmed"])assert.equal((await resolve(taxi,"pet_taxi",status))?.phase,"pickup",status);
 for(const status of["in_progress","arrived_dropoff","dropoff_confirmed"])assert.equal((await resolve(taxi,"pet_taxi",status))?.phase,"dropoff",status);
 for(const status of["scheduled","ready_to_start","in_progress"])assert.equal((await resolve(walk,"dog_walking",status))?.phase,"service_doorstep",status);
 for(const status of["completed","cancelled","refunded","recovery_pending","reassignment_needed","payment_pending","not_a_real_state",""]){
  assert.equal(await resolve(taxi,"pet_taxi",status),null,`Taxi ${status||"(empty)"}`);
  assert.equal(await resolve(walk,"dog_walking",status),null,`Walking ${status||"(empty)"}`);
 }
 assert.equal(await resolve(taxi,"grooming","assigned"),null,"only Walking and Taxi journeys resolve here");
});

test("a Walking programme's journey is the walk in progress, else the next open walk, not the earliest",async()=>{
 const{sqlite,db}=world();
 for(const[index,[sessions,expected,why]]of[
  [["completed","scheduled","scheduled"],"scheduled","walk 1 is done, so walk 2 is the journey"],
  [["completed","ready_to_start","scheduled"],"ready_to_start","the next open walk, whatever its pre-walk state"],
  [["completed","scheduled","in_progress"],"in_progress","a walk in progress beats an earlier open one"],
  [["completed","completed"],"completed","every walk closed"],
  [["completed","cancelled","cancelled"],"cancelled","the latest closed walk speaks for a programme cancelled part-way"],
 ].entries()){
  const bookingId=await seedWalk(db,sqlite,{id:`BK-WALK-${index}`,sessions});
  assert.equal(await journey.serviceJourneyStatus(db,"dog_walking",bookingId),expected,why);
 }
});

test("record_location stores a fresh ETA for every accepted Taxi fix: pickup before the trip, drop-off in ride",async t=>{
 const{sqlite,db}=world(),routes=stubRoutes(t);
 const bookingId=await seedTaxi(db,sqlite);
 const sessionId=await trackingSession(db,sqlite,"pet_taxi",bookingId);
 const first=await recordFix(sessionId);
 assert.equal(first.trustState,"accepted");
 assert.equal(first.telemetryMode,"sandbox_adapter");
 assert.equal(routes.length,1,"the accepted fix is routed once");
 assert.deepEqual(routes[0].origin,latLng(GPS),"from the accepted fix itself");
 assert.deepEqual(routes[0].destination,latLng(PICKUP),"to the verified pickup before the trip starts");
 assert.equal(routes[0].routingPreference,"TRAFFIC_AWARE");
 const[pickup]=snapshots(sqlite,bookingId);
 assert.equal(pickup?.id,first.eta?.id,"the response carries the snapshot it persisted");
 assert.equal(pickup.origin_location_event_id,first.id,"tied to the exact fix that produced it");
 assert.deepEqual(JSON.parse(pickup.destination_snapshot_json),{...PICKUP,phase:"pickup"});
 assert.deepEqual([pickup.provider_status,pickup.distance_meters,pickup.duration_seconds],["configured",4200,540]);
 assert.equal(JSON.parse(pickup.detail_json).polyline,"live-polyline");
 assert.ok(pickup.stale_after>pickup.calculated_at);

 setStatus(sqlite,bookingId,{trip:"in_progress",booking:"in_progress"});
 const moving={latitude:12.9705,longitude:77.7},second=await recordFix(sessionId,moving);
 assert.deepEqual(routes[1].origin,latLng(moving));
 assert.deepEqual(routes[1].destination,latLng(DROP),"in ride the ETA runs to the verified drop-off");
 const rows=snapshots(sqlite,bookingId);
 assert.equal(rows.length,2,"each accepted fix refreshes the ETA");
 assert.equal(rows[1].origin_location_event_id,second.id);
 assert.deepEqual(JSON.parse(rows[1].destination_snapshot_json),{...DROP,phase:"dropoff"});
});

test("stale and low-accuracy fixes are kept as evidence but never reach Google or produce an ETA",async t=>{
 const{sqlite,db}=world(),routes=stubRoutes(t);
 const bookingId=await seedTaxi(db,sqlite);
 const sessionId=await trackingSession(db,sqlite,"pet_taxi",bookingId);
 const rejected=[await recordFix(sessionId,{accuracyMeters:500}),await recordFix(sessionId,{clientCapturedAt:Date.now()-10*60_000})];
 assert.deepEqual(rejected.map(data=>data.trustState),["low_accuracy","stale"]);
 for(const data of rejected){assert.equal(data.eta,undefined);assert.equal(data.telemetryMode,"deterministic_sandbox");}
 assert.equal(routes.length,0);
 assert.equal(snapshots(sqlite,bookingId).length,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM universal_provider_location_events WHERE booking_id=?").get(bookingId).count,2);
});

test("a Routes outage degrades the ETA snapshot but never fails GPS ingestion",async t=>{
 const{sqlite,db}=world(),routes=stubRoutes(t,{respond:()=>Response.json({error:{message:"quota exhausted"}},{status:429})});
 const bookingId=await seedTaxi(db,sqlite);
 const sessionId=await trackingSession(db,sqlite,"pet_taxi",bookingId);
 const data=await recordFix(sessionId);
 assert.equal(data.trustState,"accepted","the fix is still ingested");
 assert.equal(routes.length,1);
 const[row]=snapshots(sqlite,bookingId);
 assert.deepEqual([row?.provider_status,row?.duration_seconds,row?.predicted_arrival_at],["route_unavailable",null,null],"stored as degraded evidence, never as a route");
});

test("a fix after the booking closes stores no ETA although its location session is still active",async t=>{
 const{sqlite,db}=world(),routes=stubRoutes(t);
 const taxi=await seedTaxi(db,sqlite),taxiSession=await trackingSession(db,sqlite,"pet_taxi",taxi);
 setStatus(sqlite,taxi,{trip:"in_progress",booking:"in_progress"});
 assert.ok((await recordFix(taxiSession)).eta,"sanity: a live trip does refresh");
 for(const[label,trip,booking]of[
  ["trip completed","completed","completed"],
  ["booking cancelled while the trip row still reads in ride","in_progress","cancelled"],
  ["trip cancelled before the booking row caught up","cancelled","in_progress"],
  ["booking refunded","completed","refunded"],
  ["driver released for reassignment","recovery_pending","reassignment_needed"],
 ]){
  setStatus(sqlite,taxi,{trip,booking});
  const data=await recordFix(taxiSession);
  assert.equal(data.trustState,"accepted",`${label}: the fix itself is still trusted evidence`);
  assert.equal(data.eta,undefined,`${label}: but it must not produce an ETA`);
 }
 const walk=await seedWalk(db,sqlite,{sessions:["completed","scheduled"]}),walkSession=await trackingSession(db,sqlite,"dog_walking",walk);
 sqlite.prepare("UPDATE walking_sessions SET status='completed' WHERE booking_id=?").run(walk);
 sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(walk);
 assert.equal((await recordFix(walkSession)).eta,undefined,"a finished Walking programme stops refreshing too");
 assert.equal(routes.length,1,"no Routes call is spent on a closed journey");
 assert.equal(snapshots(sqlite,taxi).length+snapshots(sqlite,walk).length,1);
 for(const bookingId of[taxi,walk])assert.equal(sqlite.prepare("SELECT status FROM provider_location_sessions WHERE booking_id=?").get(bookingId).status,"active","the premise: nothing closed the location session");
});

test("a completed first walk no longer ends live tracking and ETA for the next walk",async t=>{
 const{sqlite,db}=world(),routes=stubRoutes(t);
 const bookingId=await seedWalk(db,sqlite,{sessions:["completed","scheduled","scheduled"]});
 const sessionId=await trackingSession(db,sqlite,"dog_walking",bookingId);
 assert.ok((await recordFix(sessionId)).eta,"walk 2 is live, so its accepted fix refreshes the ETA");
 assert.deepEqual(routes[0].destination,latLng(DOORSTEP));
 assert.deepEqual(JSON.parse(snapshots(sqlite,bookingId)[0].destination_snapshot_json),{...DOORSTEP,phase:"service_doorstep"});
 const{cookie}=await customerSessionCookie(db,{principalKey:"customer:live-eta",customerId:CUSTOMER});
 const response=await customerRoute.GET(new Request(`${OPS_ORIGIN}/api/customer-live-tracking?bookingId=${bookingId}`,{headers:{cookie}}));
 const body=await response.json();
 assert.equal(response.status,200,JSON.stringify(body));
 assert.equal(body.data.tracking.state,"live","the customer sees walk 2 live, not \"location sharing has ended\"");
 assert.deepEqual([body.data.tracking.etaMinutes,body.data.tracking.distanceKm],[9,4.2]);
});

test("a lifecycle transition during the Routes call does not store an ETA for the phase it left",async t=>{
 const{sqlite,db}=world(),bookingId=await seedTaxi(db,sqlite,{tripStatus:"pickup_confirmed"});
 const routes=stubRoutes(t,{during:call=>{
  if(call===1)setStatus(sqlite,bookingId,{trip:"in_progress",booking:"in_progress"});
  if(call===3)setStatus(sqlite,bookingId,{booking:"cancelled"});
 }});
 const sessionId=await trackingSession(db,sqlite,"pet_taxi",bookingId);
 const raced=await recordFix(sessionId);
 assert.deepEqual(routes[0].destination,latLng(PICKUP),"the fix was routed while the trip was still heading to the pickup");
 assert.equal(raced.eta,undefined,"a pickup ETA is not stored once the trip has started");
 assert.equal(snapshots(sqlite,bookingId).length,0);
 assert.ok((await recordFix(sessionId)).eta,"the next fix routes afresh");
 assert.deepEqual(routes[1].destination,latLng(DROP));
 assert.equal((await recordFix(sessionId)).eta,undefined,"a cancellation during the Routes call stores nothing either");
 const rows=snapshots(sqlite,bookingId);
 assert.equal(rows.length,1);
 assert.deepEqual(JSON.parse(rows[0].destination_snapshot_json),{...DROP,phase:"dropoff"});
});

test("customer and provider tracking share one canonical journey destination",()=>{
 const customer=read("app/api/customer-live-tracking/route.ts");
 const provider=read("app/api/location-recovery/route.ts");
 for(const source of[customer,provider])assert.match(source,/live-journey-destination/);
 assert.doesNotMatch(customer,/async function taxiDestination/);
});
