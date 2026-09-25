import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");

test("cross-service customer tracking is gated as customer scheduling access",()=>{
 const api=read("lib/api-gateway.ts"),session=read("lib/session-api-gateway.ts");
 assert.match(api,/customer-live-tracking/);
 assert.match(session,/customer-live-tracking/);
 assert.match(session,/subjectType:"customer"/);
});

test("Walking and Taxi share one customer live tracking projection",()=>{
 const route=read("app/api/customer-live-tracking/route.ts");
 assert.match(route,/dog_walking/);
 assert.match(route,/pet_taxi/);
 assert.match(route,/requireCustomerOwnership/);
 assert.match(route,/visibleStatuses:ACTIVE/);
 assert.match(route,/privacyRounded:true/);
 assert.match(route,/resolveBookingDoorstep/);
});

test("Taxi in-ride map uses only verified canonical drop-off coordinates",()=>{
 const route=read("app/api/customer-live-tracking/route.ts");
 assert.match(route,/taxi_ride_booking_details/);
 assert.match(route,/destination_latitude/);
 assert.match(route,/destination_longitude/);
 assert.match(route,/Pet Taxi verified pickup\/drop-off coordinates are unavailable/);
 assert.match(route,/arrived_dropoff/);
 assert.match(route,/dropoff_confirmed/);
});

test("Walking and Taxi customer manage screens render the shared tracker",()=>{
 const walking=read("app/walking/manage/walking-customer-management.tsx");
 const taxi=read("app/taxi/manage/taxi-customer-management.tsx");
 for(const source of[walking,taxi]){assert.match(source,/CustomerServiceLiveTracking/);assert.match(source,/bookingId=\{bookingId\}/);}
});

test("universal ETA snapshots retain Google route polyline evidence",()=>{
 const route=read("app/api/location-recovery/route.ts"),lib=read("lib/universal-location-recovery.ts");
 assert.match(route,/polyline=route\.polyline/);
 assert.match(route,/providerReference,polyline/);
 assert.match(lib,/polyline\?:string\|null/);
 assert.match(lib,/polyline:input\.polyline/);
});

test("customer tracking state projection can opt into service-specific active states",async()=>{
 const url=new URL("../lib/customer-location-disclosure.ts",import.meta.url);
 const mod=await import(url.href+"?parity="+Date.now());
 const now=Date.now();
 const value=mod.customerTrackingProjection({bookingStatus:"assigned",hasTrustedLocation:true,eta:{providerStatus:"configured",distanceMeters:1200,durationSeconds:600,staleAfter:now+60000},now,visibleStatuses:["assigned"]});
 assert.equal(value.state,"live");
 assert.equal(value.etaMinutes,10);
 assert.equal(value.distanceKm,1.2);
});
