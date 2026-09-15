/**
 * R3-A1 — the zone service and the boarding host roster disagreed about the same city.
 *
 * MEASURED BEFORE THE FIX, against the running UAT server:
 *   /api/service-zone?pincode=560102 (HSR Layout) -> zoneId "blr-south"
 *   /api/boarding-commercial?zoneId=blr-south     -> hosts: []          (blr-east: 4)
 * and two of those four blr-east hosts carried area "HSR Layout" and "Koramangala" — areas that this
 * platform's own lib/service-zones.ts files under blr-south. So a customer in HSR, Koramangala,
 * Jayanagar or BTM was told "No verified Boarding host currently has capacity for every selected pet"
 * while a host card elsewhere in the app named their own neighbourhood.
 *
 * Every test below runs the real functions and the real route handlers against a real SQLite-backed
 * D1 and asserts on the rows and responses they actually produced. The first one is the OUTCOME test:
 * it does not check that two fields now agree, it checks that the customer can get a governed quote.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, stayUrl, stayWindow } from "./helpers/stay-harness.mjs";

installWorkersHooks("__R3A_ZONE_DB__", "__R3A_ZONE_ENV__");

const zones = await import("../lib/service-zones.ts");
const governance = await import("../lib/boarding-governance.ts");
const capability = await import("../lib/boarding-host-capability.ts");
const commercialRoute = await import("../app/api/boarding-commercial/route.ts");
const zoneRoute = await import("../app/api/service-zone/route.ts");

/** HSR Layout. The pincode the auditor drove, and the one the roster claimed to cover. */
const HSR_PINCODE = "560102";

async function world() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3A_ZONE_DB__ = db;
  globalThis.__R3A_ZONE_ENV__ = {};
  await governance.ensureBoardingGovernanceTables(db);
  return { sqlite, db };
}

const json = async (response) => ({ status: response.status, body: await response.json() });

test("OUTCOME: an HSR Layout customer reaches a verified Boarding host and a governed quote", async () => {
  const { db } = await world();

  // 1. The address step, through the real route: the pincode the customer types resolves to a zone.
  const resolved = await json(await zoneRoute.GET(new Request(stayUrl(`/api/service-zone?pincode=${HSR_PINCODE}`))));
  assert.equal(resolved.status, 200, `zone lookup failed: ${JSON.stringify(resolved.body)}`);
  const zoneId = resolved.body.data.assignment.zoneId;
  const cityId = resolved.body.data.assignment.cityId;
  assert.equal(zoneId, "blr-south", "HSR Layout is South Bengaluru in this platform's own zone map");

  // 2. The host step, through the real route, with the SAME zone the address produced — window-aware
  //    discovery, which is what the customer's search actually calls.
  const { scheduledStart, scheduledEnd } = stayWindow({ startInHours: 72, durationHours: 4 });
  const search = new URLSearchParams({ cityId, zoneId, scheduledStart, scheduledEnd, petCount: "1", species: "dog" });
  const discovered = await json(await commercialRoute.GET(new Request(stayUrl(`/api/boarding-commercial?${search}`))));
  assert.equal(discovered.status, 200, `host discovery failed: ${JSON.stringify(discovered.body)}`);
  const hosts = discovered.body.data.hosts;
  assert.ok(hosts.length > 0, `an address in ${zoneId} must reach at least one Boarding host, got none`);
  assert.equal(discovered.body.data.availabilityVerified, true, "the hosts returned must be window-verified, not catalogue-only");
  for (const host of hosts) {
    assert.equal(host.homeVerified, true);
    assert.equal(host.kycStatus, "verified");
    assert.ok(host.availableGuestPets >= 1, `${host.providerId} was offered with no free guest-pet capacity`);
  }

  // 3. The money step: the server prices the stay against the host the customer picked, in that zone.
  const quoted = await json(await commercialRoute.POST(new Request(stayUrl("/api/boarding-commercial"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageCode: "boarding-4h", petCount: 1, scheduledStart, scheduledEnd, paymentMode: "prepaid", cityId, zoneId, providerId: hosts[0].providerId }),
  })));
  assert.equal(quoted.status, 201, `governed quote refused: ${JSON.stringify(quoted.body)}`);
  assert.equal(quoted.body.data.zoneId, "blr-south");
  assert.ok(Number(quoted.body.data.totalAmount) > 0, "a quote with no money in it is not a quote");
});

test("every host the roster seeds is filed in the zone its own area belongs to", async () => {
  const { db } = await world();
  const rows = await db.prepare("SELECT provider_id,area,zone_id FROM boarding_host_profiles").all();
  assert.ok(rows.results.length >= 4, "the founder roster must have seeded its hosts");
  for (const row of rows.results) {
    const expected = zones.zoneIdForArea(row.area);
    assert.ok(expected, `host ${row.provider_id} claims area "${row.area}", which the service-zone map does not serve`);
    assert.equal(row.zone_id, expected, `host ${row.provider_id} is filed under ${row.zone_id} but "${row.area}" is ${expected}`);
  }
  // …and the zone every host is filed under is one a customer address can actually resolve to.
  const reachable = new Set(rows.results.map((row) => row.zone_id));
  assert.ok(reachable.has("blr-south"), "South Bengaluru — Koramangala, HSR, JP Nagar, Jayanagar, BTM — must have a Boarding host");
  assert.ok(reachable.has("blr-east"), "East Bengaluru must keep its Boarding hosts");
});

test("the write path refuses a host whose area contradicts its zone, and accepts the honest one", async () => {
  const { db } = await world();
  const base = {
    providerId: "host_zone_probe", cityId: "blr", area: "HSR Layout", species: ["dog"],
    maxGuestPets: 2, oneFamilyOnly: false, medicationSupport: false,
  };

  const refused = await refusal(capability.saveBoardingHostCapability(db, { ...base, zoneId: "blr-east" }, "ops@pawspace.example"));
  assert.equal(refused?.status, 409, `a host in HSR Layout must not be storable as blr-east (got ${JSON.stringify(refused)})`);
  assert.match(refused.message, /HSR Layout/);
  assert.match(refused.message, /blr-south/);
  const nothing = await db.prepare("SELECT provider_id FROM boarding_host_profiles WHERE provider_id=?").bind(base.providerId).first();
  assert.equal(nothing, null, "the refused write must not have landed a half-correct row");

  const saved = await capability.saveBoardingHostCapability(db, { ...base, zoneId: "blr-south" }, "ops@pawspace.example");
  assert.equal(saved.providerId, "host_zone_probe");
  const stored = await db.prepare("SELECT zone_id,area FROM boarding_host_profiles WHERE provider_id=?").bind(base.providerId).first();
  assert.equal(stored.zone_id, "blr-south");
  assert.equal(stored.area, "HSR Layout");

  // An area outside the seeded pincode map is not the rule's business: the roster may grow.
  const unknown = await capability.saveBoardingHostCapability(db, { ...base, providerId: "host_zone_probe_2", area: "Mysuru Road Extension", zoneId: "blr-west" }, "ops@pawspace.example");
  assert.equal(unknown.providerId, "host_zone_probe_2");
});

test("a database already carrying the contradiction is repaired by the seed, not left serving it", async () => {
  const { db, sqlite } = await world();
  // Exactly the row the live UAT database held: the seed's own host, filed east, advertising HSR.
  sqlite.prepare("UPDATE boarding_host_profiles SET zone_id='blr-east' WHERE provider_id='host_sana'").run();
  sqlite.prepare("UPDATE provider_capacity_profiles SET zones_json='[\"blr-east\"]' WHERE id='host_sana'").run();
  const before = sqlite.prepare("SELECT zone_id,area FROM boarding_host_profiles WHERE provider_id='host_sana'").get();
  assert.equal(before.zone_id, "blr-east", "fixture did not take");

  await governance.ensureBoardingGovernanceTables(db);

  const after = sqlite.prepare("SELECT zone_id,area FROM boarding_host_profiles WHERE provider_id='host_sana'").get();
  assert.equal(after.zone_id, zones.zoneIdForArea(after.area), "INSERT OR IGNORE left the stale zone in place");
  assert.equal(after.zone_id, "blr-south");
  const capacityRow = sqlite.prepare("SELECT zones_json FROM provider_capacity_profiles WHERE id='host_sana'").get();
  assert.deepEqual(JSON.parse(capacityRow.zones_json), ["blr-south"], "discovery joins on zones_json too, so it has to move with the profile");
});

test("an operator's own edit is never overwritten by the repair", async () => {
  const { db, sqlite } = await world();
  await capability.saveBoardingHostCapability(db, {
    providerId: "host_sana", cityId: "blr", zoneId: "blr-east", area: "Domlur",
    species: ["dog", "cat"], maxGuestPets: 2, oneFamilyOnly: true, medicationSupport: true,
  }, "ops@pawspace.example");
  await governance.ensureBoardingGovernanceTables(db);
  const row = sqlite.prepare("SELECT zone_id,area,updated_by FROM boarding_host_profiles WHERE provider_id='host_sana'").get();
  assert.equal(row.updated_by, "ops@pawspace.example");
  assert.equal(row.area, "Domlur", "the seed must not reach back over a real operator decision");
  assert.equal(row.zone_id, "blr-east");
});

test("the UAT demo seed obeys the same rule as the founder roster", () => {
  const sql = readFileSync(new URL("../scripts/uat-demo-seed.sql", import.meta.url), "utf8");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(sql);
  const rows = sqlite.prepare("SELECT provider_id,area,zone_id FROM boarding_host_profiles").all();
  assert.ok(rows.length > 0, "the demo seed must still seed boarding hosts");
  for (const row of rows) {
    const expected = zones.zoneIdForArea(row.area);
    assert.ok(expected, `demo host ${row.provider_id} claims an unserved area "${row.area}"`);
    assert.equal(row.zone_id, expected, `demo host ${row.provider_id} is filed under ${row.zone_id} but "${row.area}" is ${expected}`);
  }
});
