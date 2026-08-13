import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// The pincode -> zone table is the FIRST thing a customer touches. If their
// pincode does not resolve, the funnel ends before a booking is ever attempted.
//
// The table shipped fabricated: it placed Koramangala in the WEST zone under
// pincode 560018 (Chamarajpet), Whitefield in the NORTH under 560048, listed
// "Whitehall" as a Bengaluru locality, and omitted HSR Layout, Koramangala,
// Bellandur, BTM, Bannerghatta and Indiranagar's real pincodes entirely - while
// the city launch config advertised the whole 560001-560110 range as live.
//
// These tests pin the property that matters: the coverage the business
// ADVERTISES must equal the coverage the booking flow ACCEPTS.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } };
}

const zones = await import("../lib/service-zones.ts");
const { resolveZoneByPincode, SERVICE_ZONES } = zones;

// The city table's DDL is taken from the module that OWNS it, never re-typed here. Writing it by
// hand is how the first version of this suite passed while the resolver queried "city_launch_config"
// (singular) and the real table is "city_launch_configs" - the test created the table under the
// wrong name too, so it cheerfully agreed with the bug and 560006 stayed unserviceable on staging.
const CITY_DDL = (() => {
  const source = read("lib/city-governance.ts");
  const match = /CREATE TABLE IF NOT EXISTS city_launch_configs \([\s\S]*?\)(?=")/.exec(source);
  assert.ok(match, "could not find the city_launch_configs DDL in lib/city-governance.ts");
  return match[0];
})();
const CITY_TABLE = /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(CITY_DDL)[1];

function fresh({ live = true, pincodes = "560001–560110" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec(CITY_DDL);
  sqlite.prepare(`INSERT INTO ${CITY_TABLE} (id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("bengaluru", "blr", "Bengaluru", "Karnataka", live ? "Live" : "Draft", "12.9716, 77.5946", 35, pincodes, 1, "{}", 1, "test", 0, 0);
  return { sqlite, db };
}

test("the resolver queries the city table that actually exists", () => {
  // Guard the exact mistake above: the resolver's table name must match the owning module's DDL.
  const resolver = read("lib/service-zones.ts");
  const referenced = [...resolver.matchAll(/FROM (city_launch_config[a-z_]*)/g)].map(match => match[1]);
  assert.ok(referenced.length > 0, "the resolver must consult the city launch configuration");
  for (const name of referenced) {
    assert.equal(name, CITY_TABLE, `the resolver queries "${name}" but lib/city-governance.ts creates "${CITY_TABLE}"`);
  }
});

// The areas PawSpace actually operates in. Each must resolve, and to the right zone.
const CORE_AREAS = [
  { pincode: "560102", area: "HSR Layout", zone: "blr-south" },
  { pincode: "560034", area: "Koramangala", zone: "blr-south" },
  { pincode: "560095", area: "Koramangala", zone: "blr-south" },
  { pincode: "560068", area: "BTM", zone: "blr-south" },
  { pincode: "560076", area: "Bannerghatta", zone: "blr-south" },
  { pincode: "560078", area: "JP Nagar", zone: "blr-south" },
  { pincode: "560041", area: "Jayanagar", zone: "blr-south" },
  { pincode: "560038", area: "Indiranagar", zone: "blr-east" },
  { pincode: "560066", area: "Whitefield", zone: "blr-east" },
  { pincode: "560037", area: "Marathahalli", zone: "blr-east" },
  { pincode: "560103", area: "Bellandur", zone: "blr-east" },
  { pincode: "560071", area: "Domlur", zone: "blr-east" },
  { pincode: "560032", area: "Hebbal", zone: "blr-north" },
  { pincode: "560064", area: "Yelahanka", zone: "blr-north" },
  { pincode: "560010", area: "Rajajinagar", zone: "blr-west" },
  { pincode: "560040", area: "Vijayanagar", zone: "blr-west" },
  { pincode: "560001", area: "MG Road", zone: "blr-central" },
];

test("every core Bengaluru area resolves, to the correct zone", async () => {
  const { db } = fresh();
  for (const item of CORE_AREAS) {
    const result = await resolveZoneByPincode(db, item.pincode);
    assert.ok(result, `${item.pincode} (${item.area}) must resolve - an unresolvable pincode ends the funnel`);
    assert.equal(result.assignment.zoneId, item.zone, `${item.pincode} (${item.area}) belongs to ${item.zone}, not ${result.assignment.zoneId}`);
  }
});

test("advertised coverage equals accepted coverage", async () => {
  // The city config publishes 560001-560110 as Live. Every pincode in that range must resolve,
  // whether or not anyone remembered to add it to the table.
  const { db } = fresh();
  const unresolved = [];
  for (let pincode = 560001; pincode <= 560110; pincode += 1) {
    const result = await resolveZoneByPincode(db, String(pincode));
    if (!result) unresolved.push(String(pincode));
  }
  assert.deepEqual(unresolved, [],
    "these pincodes are advertised as serviceable by the city launch config but the booking flow rejects them");
});

test("a pincode outside the published range is still refused", async () => {
  // The fallback must not turn into "we serve everywhere". Chennai and Mumbai must not resolve.
  const { db } = fresh();
  for (const pincode of ["600001", "400001", "110001", "560999"]) {
    assert.equal(await resolveZoneByPincode(db, pincode), null, `${pincode} is outside the published range and must not resolve`);
  }
});

test("a city that is not Live does not make its range serviceable", async () => {
  const { db } = fresh({ live: false });
  // 560102 is in the explicit table, so it still resolves - that is intended.
  // 560006 is NOT in the table, so it may only resolve via a LIVE city range.
  assert.equal(await resolveZoneByPincode(db, "560006"), null, "a Draft city must not open the funnel");
});

test("the zone descriptions match the pincodes assigned to them", () => {
  // The descriptions are customer-visible. They previously said West Bengaluru covered "Koramangala,
  // Jayanagar" (both south) and North covered "Whitefield" (east).
  const source = read("lib/service-zones.ts");
  assert.match(SERVICE_ZONES["blr-south"].description, /Koramangala/);
  assert.match(SERVICE_ZONES["blr-south"].description, /HSR/);
  assert.match(SERVICE_ZONES["blr-east"].description, /Whitefield/);
  assert.doesNotMatch(SERVICE_ZONES["blr-west"].description, /Koramangala|Jayanagar/, "Koramangala and Jayanagar are south, not west");
  assert.doesNotMatch(SERVICE_ZONES["blr-north"].description, /Whitefield/, "Whitefield is east, not north");
  // Check the DATA, not the prose - the comment above the table names the old fake locality on purpose.
  const areas = [...source.matchAll(/area:"([^"]+)"/g)].map(match => match[1]);
  assert.ok(!areas.includes("Whitehall"), "'Whitehall' is not a Bengaluru locality");
  assert.ok(areas.includes("HSR Layout") && areas.includes("Koramangala"), "the densest pet-owning areas must be on the map");
});

test("no pincode is claimed by two zones", () => {
  const source = read("lib/service-zones.ts");
  const seen = new Map();
  const duplicates = [];
  for (const match of source.matchAll(/"(\d{6})":\{pincode:"\d{6}",zoneId:"([a-z-]+)"/g)) {
    const [, pincode, zone] = match;
    if (seen.has(pincode) && seen.get(pincode) !== zone) duplicates.push(`${pincode}: ${seen.get(pincode)} vs ${zone}`);
    seen.set(pincode, zone);
  }
  assert.deepEqual(duplicates, []);
  assert.ok(seen.size >= 60, `expected real coverage of the city, only ${seen.size} pincodes are mapped`);
});
