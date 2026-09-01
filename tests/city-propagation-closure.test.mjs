import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { cityIdFromZoneId, resolveServiceCoverage } from "../lib/service-zone-client.ts";
import { reserveUatSchedule } from "../lib/uat-scheduling-client.ts";
import { reserveWalkingSchedule } from "../lib/walking-booking-client.ts";
import { reserveTaxiSchedule } from "../lib/taxi-booking-client.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("city resolution and scheduling preserve BLR plus a second-city propagation contract", async () => {
  assert.equal(cityIdFromZoneId("blr-south"), "blr");
  assert.equal(cityIdFromZoneId("maa-central"), "maa");
  const originalFetch = globalThis.fetch;
  try {
    for (const sample of [
      { pincode: "560034", zoneId: "blr-south", city: "Bengaluru", expected: "blr" },
      { pincode: "600001", zoneId: "maa-central", city: "Chennai", expected: "maa" },
    ]) {
      globalThis.fetch = async () => Response.json({ data: { zone: { zoneId: sample.zoneId, zoneName: sample.zoneId, serviceAvailable: true }, assignment: { pincode: sample.pincode, zoneId: sample.zoneId, city: sample.city, area: "UAT area" } } });
      const resolved = await resolveServiceCoverage(sample.pincode);
      assert.equal(resolved.cityId, sample.expected);
      assert.equal(resolved.zoneId, sample.zoneId);
    }

    const bodies = [];
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init.body || "{}"));
      bodies.push(body);
      return Response.json({ data: { groupId: "grp-1", provider: { id: "prov-1", name: "Provider", model: "commission", rating: 4.9 }, mode: "automatic", occurrences: [], explanation: [] } });
    };
    await reserveUatSchedule({ clientRequestId: "groom-maa", customerId: "c1", petIds: ["p1"], serviceCode: "grooming", cityId: "maa", zoneId: "maa-central", scheduledStart: "2026-08-25T04:00:00.000Z", scheduledEnd: "2026-08-25T06:00:00.000Z" });
    await reserveWalkingSchedule({ clientRequestId: "walk-maa", customerId: "c1", petIds: ["p1"], cityId: "maa", zoneId: "maa-central", scheduledStart: "2026-08-25T04:00:00.000Z", scheduledEnd: "2026-08-25T05:00:00.000Z", walkCount: 1 });
    await reserveTaxiSchedule({ clientRequestId: "taxi-maa", customerId: "c1", petIds: ["p1"], cityId: "maa", zoneId: "maa-central", scheduledStart: "2026-08-25T04:00:00.000Z", scheduledEnd: "2026-08-25T05:00:00.000Z" });
    assert.equal(bodies.length, 3);
    for (const body of bodies) { assert.equal(body.cityId, "maa"); assert.equal(body.zoneId, "maa-central"); }
  } finally { globalThis.fetch = originalFetch; }
});

test("all customer booking flows propagate resolved city instead of hard-coding Bengaluru", async () => {
  const paths = ["app/mobile-app/grooming-flow.tsx", "app/mobile-app/stay-flow.tsx", "app/mobile-app/training-flow.tsx", "app/mobile-app/walking-flow.tsx", "app/mobile-app/taxi-flow.tsx", "app/mobile-app/food-flow.tsx"];
  const sources = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await read(path)])));
  for (const [path, source] of Object.entries(sources)) assert.doesNotMatch(source, /cityId\s*:\s*["']blr["']/, `${path} still hard-codes Bengaluru`);
  assert.match(sources["app/mobile-app/grooming-flow.tsx"], /serviceCode:"grooming",cityId:serviceLocation\.assignment\.cityId,zoneId/);
  assert.match(sources["app/mobile-app/stay-flow.tsx"], /serviceCode:mode==="boarding"\?"boarding":"pet_sitting",cityId:serviceLocation\.assignment\.cityId,zoneId/);
  assert.ok((sources["app/mobile-app/training-flow.tsx"].match(/serviceCode:"dog_training",cityId:serviceCoverage\.cityId,zoneId:serviceCoverage\.zoneId/g) || []).length >= 2);
  assert.match(sources["app/mobile-app/walking-flow.tsx"], /cityId: coverage\.cityId, zoneId: coverage\.zoneId/);
  assert.match(sources["app/mobile-app/taxi-flow.tsx"], /cityId: coverage\.cityId, zoneId: coverage\.zoneId/);
  assert.match(sources["app/mobile-app/food-flow.tsx"], /cityId: resolved\.cityId/);
});

test("scheduler stores, filters and reassigns by request city", async () => {
  const route = await read("app/api/uat-scheduling/route.ts");
  assert.doesNotMatch(route, /["']blr["']/);
  assert.match(route, /loadGovernedProviders\(db,cityIdFor\(input\),input\.zoneId/);
  assert.match(route, /city_id IS NULL OR city_id=\?/);
  assert.match(route, /input\.serviceCode,cityIdFor\(input\),input\.zoneId/);
  assert.match(route, /cityId:cityIdFor\(original\)/);
  assert.match(route, /requestInput:ScheduleRequest=\{[\s\S]*?cityId:cityIdFor\(input\)/);
});