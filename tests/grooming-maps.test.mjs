import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Grooming Maps keeps doorstep location canonical and provider-owned",async()=>{
  const[customer,locationClient,locationApi,routeApi,routeCard,partner,gateway]=await Promise.all([
    source("app/page.tsx"),source("lib/grooming-location-client.ts"),source("app/api/grooming-service-location/route.ts"),source("app/api/grooming-route/route.ts"),source("app/partner-app/grooming-route-card.tsx"),source("app/partner-app/canonical-grooming-jobs.tsx"),source("lib/api-gateway.ts"),
  ]);
  assert.match(customer,/serviceAddress/);
  assert.match(customer,/saveGroomingServiceLocation\(\{\s*bookingId:\s*canonical\.bookingId,\s*customerId,\s*address:\s*normalizedAddress\s*\}\)/);
  assert.match(locationClient,/\/api\/grooming-service-location/);
  assert.match(locationApi,/requireCustomerOwnership\(db,actor,customerId\)/);
  assert.match(locationApi,/booking_service_locations/);
  assert.match(routeApi,/requireProviderOwnership\(db,actor,input\.providerId\)/);
  assert.match(routeApi,/activeTravelStates=new Set\(\["assigned","on_the_way","arrived"\]\)/);
  assert.match(routeApi,/GPS capture is disabled outside assigned, on-the-way or arrived states/);
  assert.match(routeCard,/navigator\.geolocation\.getCurrentPosition/);
  assert.match(routeCard,/navigator\.geolocation\.watchPosition/);
  assert.match(routeCard,/foreground-only in UAT/);
  assert.match(routeCard,/Background tracking is not enabled/);
  assert.match(partner,/GroomingRouteCard bookingId=\{selected\.bookingId\} providerId=\{selected\.providerId\}/);
  assert.match(gateway,/\/api\/grooming-service-location/);
  assert.match(gateway,/\/api\/grooming-route/);
});

test("Grooming Maps UAT uses server-only sandbox Routes credentials",async()=>{
  const[maps,routeCard]=await Promise.all([source("lib/grooming-maps.ts"),source("app/partner-app/grooming-route-card.tsx")]);
  assert.match(maps,/PAWSPACE_MAPS_ENV/);
  assert.match(maps,/GOOGLE_MAPS_SERVER_API_KEY_UAT/);
  assert.match(maps,/routes\.googleapis\.com\/directions\/v2:computeRoutes/);
  assert.match(maps,/X-Goog-Api-Key/);
  assert.match(maps,/X-Goog-FieldMask/);
  assert.match(maps,/configuration_required/);
  assert.match(maps,/https:\/\/www\.google\.com\/maps\/dir\//);
  assert.match(maps,/provider_location_events/);
  assert.match(maps,/grooming_route_snapshots/);
  assert.doesNotMatch(routeCard,/GOOGLE_MAPS_SERVER_API_KEY_UAT/);
  assert.doesNotMatch(routeCard,/X-Goog-Api-Key/);
});
