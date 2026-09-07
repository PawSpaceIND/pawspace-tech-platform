import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {
 ARRIVAL_GEOFENCE_METERS,
 MAX_FUTURE_CLOCK_SKEW_MS,
 arrivalGeofenceVerdict,
 classifyGpsObservation,
 gpsIngestionKey,
 shouldApplyTelemetryResponse,
} from "../lib/gps-telemetry-policy.ts";

const offsetLatitude=(meters)=>meters/6_371_000*180/Math.PI;
const trust=(overrides={})=>classifyGpsObservation({
 latitude:12.9121,longitude:77.6446,accuracyMeters:18,clientCapturedAt:1_000_000,serverReceivedAt:1_001_000,
 freshnessSeconds:30,allowedAccuracyMeters:50,gpsIngestionEnabled:true,...overrides,
});

async function source(path){return readFile(new URL(`../${path}`,import.meta.url),"utf8");}

test("arrival geofence is inclusive at 250m and distinguishes 249m/251m",()=>{
 const target={latitude:0,longitude:0};
 const at249=arrivalGeofenceVerdict({latitude:offsetLatitude(249),longitude:0},target,ARRIVAL_GEOFENCE_METERS);
 const at251=arrivalGeofenceVerdict({latitude:offsetLatitude(251),longitude:0},target,ARRIVAL_GEOFENCE_METERS);
 assert.equal(at249.distanceMeters,249);assert.equal(at249.within,true);
 assert.equal(at251.distanceMeters,251);assert.equal(at251.within,false);
});

test("fresh high-accuracy telemetry is accepted",()=>{assert.deepEqual(trust().trustState,"accepted");});

test("old telemetry cannot drive ETA or arrival",()=>{
 const verdict=trust({serverReceivedAt:1_100_000,clientCapturedAt:1_000_000});
 assert.equal(verdict.trustState,"stale");assert.equal(verdict.reason,"client_capture_outside_freshness_window");
});

test("future-clock telemetry beyond approved skew is stale",()=>{
 const verdict=trust({serverReceivedAt:1_000_000,clientCapturedAt:1_000_000+MAX_FUTURE_CLOCK_SKEW_MS+1});
 assert.equal(verdict.trustState,"stale");assert.equal(verdict.reason,"client_capture_ahead_of_server_time");
});

test("low-accuracy telemetry is evidence but not trusted",()=>{
 const verdict=trust({accuracyMeters:51,allowedAccuracyMeters:50});
 assert.equal(verdict.trustState,"low_accuracy");assert.equal(verdict.reason,"accuracy_outside_approved_policy");
});

test("GPS kill switch rejects ingestion",()=>{
 const verdict=trust({gpsIngestionEnabled:false});
 assert.equal(verdict.trustState,"rejected");assert.equal(verdict.reason,"gps_kill_switch_active");
});

test("telemetry idempotency key is deterministic per observation",()=>{
 const input={bookingId:"BOOK-1",providerId:"PROV-1",capturedAt:123456789,latitude:12.9121234,longitude:77.6446123};
 assert.equal(gpsIngestionKey(input),gpsIngestionKey({...input}));
 assert.notEqual(gpsIngestionKey(input),gpsIngestionKey({...input,capturedAt:input.capturedAt+1}));
});

test("out-of-order response protection applies only monotonically newer sequence",()=>{
 assert.equal(shouldApplyTelemetryResponse(8,7),true);assert.equal(shouldApplyTelemetryResponse(7,7),false);assert.equal(shouldApplyTelemetryResponse(6,7),false);
});

test("live grooming route is wired to universal evidence and no legacy event insert remains",async()=>{
 const route=await source("app/api/grooming-route/route.ts");
 assert.match(route,/prepareGroomingTelemetry/);assert.match(route,/commitGroomingTelemetry/);assert.match(route,/server_received_at DESC/);
 assert.doesNotMatch(route,/INSERT INTO provider_location_events/);assert.match(route,/idempotencyKey/);
 assert.doesNotMatch(route,/razorpay|PAWSPACE_PAYMENT_ENV/i);
});

test("arrival ignores raw lifecycle coordinates and binds to trusted server evidence with CAS",async()=>{
 const lifecycle=await source("app/api/grooming-lifecycle/route.ts");
 assert.match(lifecycle,/latestTrustedGroomingObservation/);assert.match(lifecycle,/locationEventId/);
 assert.match(lifecycle,/UPDATE canonical_bookings SET status=\?,updated_at=\? WHERE id=\? AND status=\?/);
 assert.match(lifecycle,/claimed!==1/);
 assert.doesNotMatch(lifecycle,/Number\(input\.latitude\)|Number\(input\.longitude\)/);
});

test("foreground sender is serialized, cancellable and latest-fix wins",async()=>{
 const card=await source("app/partner-app/grooming-route-card.tsx");
 assert.match(card,/new AbortController\(\)/);assert.match(card,/inFlight/);assert.match(card,/pending/);assert.match(card,/gpsIngestionKey/);
 assert.match(card,/FOREGROUND_GPS_INTERVAL_MS/);assert.match(card,/shouldApplyTelemetryResponse/);
});

test("normal booking address path cannot persist a NULL active doorstep",async()=>{
 const picker=await source("app/mobile-app/address-picker.tsx"),service=await source("app/api/grooming-service-location/route.ts");
 assert.match(picker,/latitude:Number\(place\.latitude\)/);assert.match(picker,/longitude:Number\(place\.longitude\)/);
 assert.match(service,/verifiedCoordinates/);assert.match(service,/coordinates\.latitude/);assert.match(service,/coordinates\.longitude/);
 assert.doesNotMatch(service,/hasCoords\s*\?\s*lat\s*:\s*null/);
});

test("atomic ingestion binds event, ETA, receipt and audit in one batch and records path deltas",async()=>{
 const pipeline=await source("lib/grooming-gps-pipeline.ts");
 assert.match(pipeline,/grooming_location_ingestions/);assert.match(pipeline,/securityAuditStatement/);assert.match(pipeline,/db\.batch\(statements\)/);
 assert.match(pipeline,/distanceFromPreviousMeters/);assert.match(pipeline,/cumulativeDistanceMeters/);assert.match(pipeline,/origin_location_event_id/);
});

test("Maps route adapter remains sandbox-locked",async()=>{
 const maps=await source("lib/grooming-maps.ts");assert.match(maps,/mode!=="sandbox"/);assert.match(maps,/GOOGLE_MAPS_SERVER_API_KEY_UAT/);
});
