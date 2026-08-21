import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

async function edit(path, mutate) {
  const before = await readFile(path, "utf8");
  const after = mutate(before);
  assert.notEqual(after, before, `${path}: expected a change`);
  await writeFile(path, after);
}

function replaceOne(source, from, to, label) {
  const first = source.indexOf(from);
  assert.notEqual(first, -1, `${label}: source pattern missing`);
  assert.equal(source.indexOf(from, first + from.length), -1, `${label}: source pattern is ambiguous`);
  return source.replace(from, to);
}

function replaceAllRequired(source, from, to, label) {
  const count = source.split(from).length - 1;
  assert.ok(count > 0, `${label}: source pattern missing`);
  return source.split(from).join(to);
}

await edit("lib/service-zone-client.ts", (source) => {
  source = replaceOne(
    source,
    "};\n\nexport async function resolveServiceCoverage",
    `};\n\nexport function cityIdFromZoneId(zoneId: string): string {\n  const cityId = zoneId.trim().split(\"-\")[0]?.toLowerCase() || \"\";\n  if (!/^[a-z0-9]{2,16}$/.test(cityId)) throw new Error(\"Service zone is missing a valid city identifier.\");\n  return cityId;\n}\n\nexport async function resolveServiceCoverage`,
    "service-zone city helper",
  );
  source = replaceOne(
    source,
    "assignment?: { pincode?: string; zoneId?: string; city?: string; area?: string };",
    "assignment?: { pincode?: string; zoneId?: string; cityId?: string; city?: string; area?: string };",
    "service-zone response city id",
  );
  source = replaceOne(
    source,
    `  if (assignment.city !== \"Bengaluru\") {\n    throw new Error(\`${"${assignment.city || \\\"This city\\\"}"} is not enabled for customer bookings yet.\`);\n  }\n  return {\n    cityId: \"blr\",`,
    `  const cityId = String(assignment.cityId || cityIdFromZoneId(assignment.zoneId)).trim().toLowerCase();\n  return {\n    cityId,`,
    "service-zone Bengaluru hardcode",
  );
  return source;
});

await edit("app/mobile-app/address-picker.tsx", (source) => {
  source = replaceOne(
    source,
    "export type ZoneResult={zone:Zone;assignment:{pincode:string;zoneId:string;city:string;area:string};address:string};",
    "export type ZoneResult={zone:Zone;assignment:{pincode:string;zoneId:string;cityId:string;city:string;area:string};address:string};",
    "address picker city type",
  );
  return replaceOne(
    source,
    "assignment:{pincode:coverage.pincode,zoneId:coverage.zoneId,city:coverage.city,area:coverage.area}",
    "assignment:{pincode:coverage.pincode,zoneId:coverage.zoneId,cityId:coverage.cityId,city:coverage.city,area:coverage.area}",
    "address picker city assignment",
  );
});

await edit("lib/uat-scheduling-client.ts", (source) => replaceOne(
  source,
  "serviceCode:\"grooming\"|\"dog_training\"|\"boarding\"|\"pet_sitting\"|\"pet_taxi\"|\"dog_walking\";zoneId:string;",
  "serviceCode:\"grooming\"|\"dog_training\"|\"boarding\"|\"pet_sitting\"|\"pet_taxi\"|\"dog_walking\";cityId:string;zoneId:string;",
  "common scheduling city field",
));

await edit("app/api/uat-scheduling/route.ts", (source) => {
  source = replaceOne(source, "serviceCode:SchedulingService;zoneId:string;", "serviceCode:SchedulingService;cityId?:string;zoneId:string;", "scheduler request city");
  source = replaceOne(
    source,
    "const dateRange=(start:string,days=100)=>Array.from({length:days},(_,i)=>{const d=new Date(start);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10);});",
    `const dateRange=(start:string,days=100)=>Array.from({length:days},(_,i)=>{const d=new Date(start);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10);});\nfunction cityIdFor(input:Pick<RequestBody,\"cityId\"|\"zoneId\">){const explicit=String(input.cityId||\"\").trim().toLowerCase();if(explicit)return explicit;const derived=String(input.zoneId||\"\").trim().split(\"-\")[0]?.toLowerCase()||\"\";if(!/^[a-z0-9]{2,16}$/.test(derived))throw new Error(\"A valid cityId is required for scheduling\");return derived;}`,
    "scheduler city resolver",
  );
  source = replaceAllRequired(source, "loadGovernedProviders(db,\"blr\",input.zoneId", "loadGovernedProviders(db,cityIdFor(input),input.zoneId", "scheduler provider city");
  source = replaceAllRequired(source, ".bind(id,provider.id,\"blr\",input.zoneId", ".bind(id,provider.id,cityIdFor(input),input.zoneId", "scheduler availability city");
  source = replaceOne(
    source,
    "async function activeRules(db:Awaited<ReturnType<typeof database>>,input:RequestBody){const rows=await db.prepare(\"SELECT condition_json FROM scheduling_rules WHERE active=1 AND (service_code IS NULL OR service_code=?) AND (city_id IS NULL OR city_id='blr') AND (zone_id IS NULL OR zone_id=?) ORDER BY priority ASC\").bind(input.serviceCode,input.zoneId).all<{condition_json:string}>();",
    "async function activeRules(db:Awaited<ReturnType<typeof database>>,input:RequestBody){const rows=await db.prepare(\"SELECT condition_json FROM scheduling_rules WHERE active=1 AND (service_code IS NULL OR service_code=?) AND (city_id IS NULL OR city_id=?) AND (zone_id IS NULL OR zone_id=?) ORDER BY priority ASC\").bind(input.serviceCode,cityIdFor(input),input.zoneId).all<{condition_json:string}>();",
    "scheduler rule city",
  );
  source = replaceAllRequired(source, "input.serviceCode,\"blr\",input.zoneId", "input.serviceCode,cityIdFor(input),input.zoneId", "scheduler reservation city");
  source = replaceOne(source, "{cityId:\"blr\",zoneId:original.zoneId", "{cityId:cityIdFor(original),zoneId:original.zoneId", "scheduler reassignment city");
  source = replaceOne(source, "const requestInput:ScheduleRequest={cityId:\"blr\",zoneId:input.zoneId", "const requestInput:ScheduleRequest={cityId:cityIdFor(input),zoneId:input.zoneId", "scheduler reserve city");
  assert.doesNotMatch(source, /[\"']blr[\"']/, "scheduler route must not rewrite any request to Bengaluru");
  return source;
});

await edit("app/mobile-app/grooming-flow.tsx", (source) => {
  source = replaceAllRequired(source, "cityId:\"blr\"", "cityId:serviceLocation.assignment.cityId", "grooming city hardcode");
  return replaceOne(
    source,
    "serviceCode:\"grooming\",zoneId,",
    "serviceCode:\"grooming\",cityId:serviceLocation.assignment.cityId,zoneId,",
    "grooming scheduler city",
  );
});

await edit("app/mobile-app/stay-flow.tsx", (source) => {
  source = replaceAllRequired(source, "cityId:\"blr\"", "cityId:serviceLocation.assignment.cityId", "stay city hardcode");
  return replaceOne(
    source,
    "serviceCode:mode===\"boarding\"?\"boarding\":\"pet_sitting\",zoneId,",
    "serviceCode:mode===\"boarding\"?\"boarding\":\"pet_sitting\",cityId:serviceLocation.assignment.cityId,zoneId,",
    "stay scheduler city",
  );
});

await edit("app/mobile-app/training-flow.tsx", (source) => replaceAllRequired(
  source,
  "serviceCode:\"dog_training\",zoneId:serviceCoverage.zoneId",
  "serviceCode:\"dog_training\",cityId:serviceCoverage.cityId,zoneId:serviceCoverage.zoneId",
  "training scheduler city",
));

await edit("lib/walking-booking-client.ts", (source) => {
  source = replaceOne(source, "petIds:string[];zoneId:string;scheduledStart:string", "petIds:string[];cityId:string;zoneId:string;scheduledStart:string", "walking schedule input city");
  return replaceOne(source, "serviceCode:\"dog_walking\",zoneId:input.zoneId", "serviceCode:\"dog_walking\",cityId:input.cityId,zoneId:input.zoneId", "walking schedule body city");
});
await edit("app/mobile-app/walking-flow.tsx", (source) => replaceOne(
  source,
  "petIds: [pet.id], zoneId: coverage.zoneId, scheduledStart",
  "petIds: [pet.id], cityId: coverage.cityId, zoneId: coverage.zoneId, scheduledStart",
  "walking flow city",
));

await edit("lib/taxi-booking-client.ts", (source) => {
  source = replaceOne(source, "petIds:string[];zoneId:string;scheduledStart:string", "petIds:string[];cityId:string;zoneId:string;scheduledStart:string", "taxi schedule input city");
  return replaceOne(source, "serviceCode:\"pet_taxi\",zoneId:input.zoneId", "serviceCode:\"pet_taxi\",cityId:input.cityId,zoneId:input.zoneId", "taxi schedule body city");
});
await edit("app/mobile-app/taxi-flow.tsx", (source) => replaceOne(
  source,
  "petIds: [pet.id], zoneId: coverage.zoneId, scheduledStart",
  "petIds: [pet.id], cityId: coverage.cityId, zoneId: coverage.zoneId, scheduledStart",
  "taxi flow city",
));

const testSource = `import assert from \"node:assert/strict\";\nimport test from \"node:test\";\nimport { readFile } from \"node:fs/promises\";\nimport { cityIdFromZoneId, resolveServiceCoverage } from \"../lib/service-zone-client.ts\";\nimport { reserveUatSchedule } from \"../lib/uat-scheduling-client.ts\";\nimport { reserveWalkingSchedule } from \"../lib/walking-booking-client.ts\";\nimport { reserveTaxiSchedule } from \"../lib/taxi-booking-client.ts\";\n\nconst read = (path) => readFile(new URL(\`../\${path}\`, import.meta.url), \"utf8\");\n\ntest(\"city resolution and scheduling preserve BLR plus a second enabled-city contract\", async () => {\n  assert.equal(cityIdFromZoneId(\"blr-south\"), \"blr\");\n  assert.equal(cityIdFromZoneId(\"maa-central\"), \"maa\");\n  const originalFetch = globalThis.fetch;\n  try {\n    for (const sample of [\n      { pincode: \"560034\", zoneId: \"blr-south\", city: \"Bengaluru\", expected: \"blr\" },\n      { pincode: \"600001\", zoneId: \"maa-central\", city: \"Chennai\", expected: \"maa\" },\n    ]) {\n      globalThis.fetch = async () => Response.json({ data: { zone: { zoneId: sample.zoneId, zoneName: sample.zoneId, serviceAvailable: true }, assignment: { pincode: sample.pincode, zoneId: sample.zoneId, city: sample.city, area: \"UAT area\" } } });\n      const resolved = await resolveServiceCoverage(sample.pincode);\n      assert.equal(resolved.cityId, sample.expected);\n      assert.equal(resolved.zoneId, sample.zoneId);\n    }\n\n    const bodies = [];\n    globalThis.fetch = async (_url, init = {}) => {\n      const body = JSON.parse(String(init.body || \"{}\"));\n      bodies.push(body);\n      return Response.json({ data: { groupId: \"grp-1\", provider: { id: \"prov-1\", name: \"Provider\", model: \"commission\", rating: 4.9 }, mode: \"automatic\", occurrences: [], explanation: [] } });\n    };\n    await reserveUatSchedule({ clientRequestId: \"groom-maa\", customerId: \"c1\", petIds: [\"p1\"], serviceCode: \"grooming\", cityId: \"maa\", zoneId: \"maa-central\", scheduledStart: \"2026-08-25T04:00:00.000Z\", scheduledEnd: \"2026-08-25T06:00:00.000Z\" });\n    await reserveWalkingSchedule({ clientRequestId: \"walk-maa\", customerId: \"c1\", petIds: [\"p1\"], cityId: \"maa\", zoneId: \"maa-central\", scheduledStart: \"2026-08-25T04:00:00.000Z\", scheduledEnd: \"2026-08-25T05:00:00.000Z\", walkCount: 1 });\n    await reserveTaxiSchedule({ clientRequestId: \"taxi-maa\", customerId: \"c1\", petIds: [\"p1\"], cityId: \"maa\", zoneId: \"maa-central\", scheduledStart: \"2026-08-25T04:00:00.000Z\", scheduledEnd: \"2026-08-25T05:00:00.000Z\" });\n    assert.equal(bodies.length, 3);\n    for (const body of bodies) { assert.equal(body.cityId, \"maa\"); assert.equal(body.zoneId, \"maa-central\"); }\n  } finally { globalThis.fetch = originalFetch; }\n});\n\ntest(\"all customer booking flows propagate resolved city instead of hard-coding Bengaluru\", async () => {\n  const paths = [\"app/mobile-app/grooming-flow.tsx\", \"app/mobile-app/stay-flow.tsx\", \"app/mobile-app/training-flow.tsx\", \"app/mobile-app/walking-flow.tsx\", \"app/mobile-app/taxi-flow.tsx\", \"app/mobile-app/food-flow.tsx\"];\n  const sources = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await read(path)])));\n  for (const [path, source] of Object.entries(sources)) assert.doesNotMatch(source, /cityId\\s*:\\s*[\"']blr[\"']/, \`\${path} still hard-codes Bengaluru\`);\n  assert.match(sources[\"app/mobile-app/grooming-flow.tsx\"], /serviceCode:\"grooming\",cityId:serviceLocation\\.assignment\\.cityId,zoneId/);\n  assert.match(sources[\"app/mobile-app/stay-flow.tsx\"], /serviceCode:mode===\"boarding\"\\?\"boarding\":\"pet_sitting\",cityId:serviceLocation\\.assignment\\.cityId,zoneId/);\n  assert.ok((sources[\"app/mobile-app/training-flow.tsx\"].match(/serviceCode:\"dog_training\",cityId:serviceCoverage\\.cityId,zoneId:serviceCoverage\\.zoneId/g) || []).length >= 2);\n  assert.match(sources[\"app/mobile-app/walking-flow.tsx\"], /cityId: coverage\\.cityId, zoneId: coverage\\.zoneId/);\n  assert.match(sources[\"app/mobile-app/taxi-flow.tsx\"], /cityId: coverage\\.cityId, zoneId: coverage\\.zoneId/);\n  assert.match(sources[\"app/mobile-app/food-flow.tsx\"], /cityId: resolved\\.cityId/);\n});\n\ntest(\"scheduler stores, filters and reassigns by request city\", async () => {\n  const route = await read(\"app/api/uat-scheduling/route.ts\");\n  assert.doesNotMatch(route, /[\"']blr[\"']/);\n  assert.match(route, /loadGovernedProviders\\(db,cityIdFor\\(input\\),input\\.zoneId/);\n  assert.match(route, /city_id IS NULL OR city_id=\\?/);\n  assert.match(route, /input\\.serviceCode,cityIdFor\\(input\\),input\\.zoneId/);\n  assert.match(route, /cityId:cityIdFor\\(original\\)/);\n  assert.match(route, /const requestInput:ScheduleRequest=\\{cityId:cityIdFor\\(input\\)/);\n});\n`;
await writeFile("tests/city-propagation-closure.test.mjs", testSource);

console.log("Applied P0 city propagation closure across customer flows, scheduler and regression evidence.");
