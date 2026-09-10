import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/uat-scheduling/route.ts", import.meta.url), "utf8");

test("UAT roster seeds geocoded home bases only for founder synthetic groomers", () => {
  assert.match(route, /uatRosterSeedingEnabled\(env\)/);
  assert.match(route, /provider\.updatedBy==="founder_seed"/);
  assert.match(route, /UAT_GROOMING_HOME_BASES/);
  for (const provider of ["groom_arun", "groom_kiran", "groom_sanjay"]) assert.match(route, new RegExp(provider));
  assert.match(route, /ensureProviderHomeBaseTables/);
  assert.match(route, /INSERT OR IGNORE INTO provider_home_base/);
});

test("UAT home-base fixtures do not disable or bypass the governed geofence", () => {
  assert.match(route, /serviceRadiusKm:governed\.serviceRadiusKm/);
  assert.match(route, /schedule\(repository\(db,new Date\(input\.scheduledStart\)\)/);
  assert.doesNotMatch(route, /serviceRadiusKm\s*:\s*undefined/);
  assert.doesNotMatch(route, /PAWSPACE_SCHEDULING_ENV\s*=\s*["']uat["']/);
});
