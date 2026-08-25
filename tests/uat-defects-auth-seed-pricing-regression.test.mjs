import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("system-wide operations dashboards require booking management authority",async()=>{
  const paths=[
    "app/api/walking-ops/route.ts",
    "app/api/taxi-ops/route.ts",
    "app/api/food-ops/route.ts",
    "app/api/sitting-ops/route.ts",
    "app/api/boarding-ops/route.ts",
    "app/api/food-supply-chain/route.ts",
    "app/api/training-ops/route.ts",
    "app/api/ops-work-queue/route.ts",
    "app/api/unified-cases/route.ts",
  ];
  for(const path of paths){
    const source=await read(path);
    assert.match(source,/requirePermission\(actor,"bookings\.manage"\)|authorize\(request,"bookings\.manage"\)/,`${path} must not expose a system-wide dashboard to bookings.view alone`);
  }
});

test("public/read dashboards do not seed synthetic host or training data",async()=>{
  const host=await read("app/api/host-profile/route.ts");
  const training=await read("app/api/training-ops/route.ts");
  assert.doesNotMatch(host,/seedDemoHostProfiles\s*\(/);
  assert.doesNotMatch(training,/seedProviderCapacityDefaults\s*\(/);
  assert.match(training,/ensureProviderCapacityTables\s*\(/);
});

test("live commercial quotes never infer Bengaluru when geography is absent",async()=>{
  const quotes=await read("lib/live-commercial-quotes.ts");
  const resolver=await read("lib/live-pricing-resolver.ts");
  assert.match(quotes,/resolveLiveBasePrice/);
  assert.match(quotes,/location\s*\?\s*await resolveLivePrice/);
  assert.doesNotMatch(quotes,/cityId:\s*input\.cityId\s*\?\?\s*["']blr["']/);
  assert.doesNotMatch(quotes,/zoneId:\s*input\.zoneId\s*\?\?\s*["']blr-east["']/);
  assert.match(resolver,/export async function resolveLiveBasePrice/);
  assert.doesNotMatch(resolver,/calculatePrice\([\s\S]*resolveLiveBasePrice/);
});

test("prelaunch booking swarm is blocked outside the isolated UAT sandbox",async()=>{
  const auth=await read("lib/server-auth.ts");
  const swarm=await read("app/api/prelaunch-booking-swarm/route.ts");
  assert.match(swarm,/authorize\(request,"launch\.manage"\)/);
  assert.match(auth,/pathname==="\/api\/prelaunch-booking-swarm"/);
  assert.match(auth,/uatLoginEnabled\(uatEnv\)/);
  assert.match(auth,/PAWSPACE_PAYMENT_ENV\|\|""\)!=="sandbox"/);
  assert.match(auth,/Prelaunch swarm is available only in the isolated UAT sandbox/);
});
