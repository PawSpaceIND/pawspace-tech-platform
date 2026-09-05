import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8");
const route=read("app/api/location-recovery/route.ts"),gateway=read("lib/api-gateway.ts");

test("provider GPS GET delegates gateway auth to ownership-aware route",()=>{
  assert.match(gateway,/if\(url\.pathname==="\/api\/location-recovery"\)\{if\(method==="GET"\)return null;/);
  assert.match(route,/hasPermission\(actor\.permissions,"bookings\.manage"\)/);
  assert.match(route,/requireProviderOwnership\(db,actor,providerId\)/);
  assert.match(route,/canonical_bookings WHERE provider_id=\? AND status IN \('confirmed','assigned','on_the_way','arrived','in_service'\)/);
});

test("provider GPS GET exposes deterministic staging distance without production fabrication",()=>{
  assert.match(route,/appEnv==="staging"\|\|schedulingEnv==="uat"\?2\.5:null/);
  assert.match(route,/simulatedDistanceKm/);
  assert.match(route,/distance_meters/);
  assert.match(route,/rawGpsCustomerExposure:false/);
});
