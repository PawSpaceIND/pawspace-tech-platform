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
    assert.match(source,/requirePermission\(actor,"bookings\.manage"\)|authorize\(request,"bookings\.manage"\)/,`${path} must not expose a system-wide dashboard to bookings.view`);
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
  const source=await read("lib/live-commercial-quotes.ts");
  assert.match(source,/if\(!location\)return quote/);
  assert.doesNotMatch(source,/cityId:\s*input\.cityId\s*\?\?\s*["']blr["']/);
  assert.doesNotMatch(source,/zoneId:\s*input\.zoneId\s*\?\?\s*["']blr-east["']/);
});
