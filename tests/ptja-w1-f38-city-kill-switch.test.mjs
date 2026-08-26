/**
 * PawSpace Total Journey Audit, Wave 1 F38 — pausing a city, or deleting a pincode from its coverage,
 * did not stop serviceability or fulfilment. The fulfilment path never read city_launch_configs.
 *
 * The City & Geofence console is the founder's only kill switch for a market. MEASURED before the fix,
 * through the real routes: an operator with launch.manage saved Bengaluru as `Paused` with 560034
 * removed from its advertised coverage and got 201; city_launch_configs then held
 * {status:'Paused', 560034 absent}. The platform's own coverage resolver agreed the city was shut -
 * and was the only thing that did:
 *
 *   resolveCityServiceCoverage(blr,grooming,560034) -> {supported:false, reason:"city_not_live"}
 *   GET /api/service-zone?pincode=560034            -> 200, zone blr-south, serviceAvailable:true
 *   POST /api/grooming-service-location             -> 201 {addressSaved:true, navigationUrl:...}
 *   durable rows                                    -> booking_service_locations 'active',
 *                                                      customer_addresses is_default=1
 *
 * So the operator believed Bengaluru was closed while the system kept taking work in it, saved a
 * doorstep address, and produced a Google Maps URL for a provider to drive to.
 *
 * SCOPE, STATED RATHER THAN ASSUMED. tests/service-zone-coverage.test.mjs pins three decisions this
 * repository has already made, and the fix leaves every one of them standing - the last three cases
 * here exist to prove that:
 *
 *   - a launch config must not WIDEN coverage past the reviewed service_zone_mappings table, and
 *     lib/service-zones.ts must not query city_launch_configs at all;
 *   - a reviewed mapping for a city with NO launch config opens a second city on its own;
 *   - a Draft city's explicitly mapped pincode still resolves, deliberately.
 *
 * What the fix adds is the direction none of those cover: the launch config cannot NARROW either.
 * Only the two unambiguous narrowings are enforced - status `Paused`, and a `Live` city that advertises
 * a parseable pincode list this pincode is no longer in. What Draft and Pilot must do to
 * serviceability, and whether an in-flight booking in a paused market must stop rather than only new
 * ones, are product decisions and are recorded as open in ptja/wave1-continuation/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F38_DB__", "__PTJA_F38_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const LAUNCH_STAFF = {
  "oai-authenticated-user-email": "launch-ops@pawspace.test",
  "oai-authenticated-user-full-name": "Launch%20ops",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};
const SERVICES = { Grooming: { enabled: true, price: 1349 }, Training: { enabled: true, price: 3500 }, Boarding: { enabled: true, price: 899 }, "Pet Sitting": { enabled: true, price: 699 } };
const TARGET = "560034";

async function post(modulePath, path, body, headers = {}) {
  const route = await import(modulePath);
  const response = await route.POST(new Request(`https://uat.pawspace.in${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

async function get(modulePath, path) {
  const route = await import(modulePath);
  const response = await route.GET(new Request(`https://uat.pawspace.in${path}`));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

/** A real booking in Bengaluru, a real customer session, and the real launch config seeded Live. */
async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_F38_DB__ = db;
  globalThis.__PTJA_F38_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedDefaultZones } = await import("../lib/service-zones.ts");
  const { seedDefaultCityLaunchConfigs } = await import("../lib/city-governance.ts");
  await ensureSecurityTables(db);
  await seedDefaultZones(db);
  await seedDefaultCityLaunchConfigs(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-PTJA-F38','launch-ops@pawspace.test','Launch ops','founder','active',?,?)").bind(now, now).run();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,service_code,city_id,zone_id) VALUES ('BK-F38','CUST-F38','groom_arun','grooming','blr','blr-south')").run();

  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: "customer:CUST-F38",
    subjectType: "customer", subjectId: "CUST-F38", verificationState: "verified",
    actorId: "ptja-f38", reason: "PTJA W1-F38 executable regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: "CUST-F38",
  });
  const cookie = `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
  const seededPincodes = sqlite.prepare("SELECT pincodes FROM city_launch_configs WHERE city_code='blr'").get().pincodes;

  /**
   * Drives the REAL launch-governance route, the same surface an operator uses.
   *
   * baseVersion is read fresh each time, which is what an operator's screen does: load, then save what
   * you loaded. Coverage saves became optimistically concurrent when the business closed the lost-update
   * half of F40, so an update that does not declare the version it read is refused. [PTJA-W3-CC]
   */
  const saveCity = ({ status, pincodes }) => post("../app/api/city-governance/route.ts", "/api/city-governance", {
    action: "save_city",
    city: {
      id: "bengaluru", cityCode: "blr", city: "Bengaluru", state: "Karnataka", status,
      centre: "12.9716, 77.5946", radiusKm: 35, pincodes, gstIncluded: true, services: SERVICES,
      baseVersion: Number(sqlite.prepare("SELECT version FROM city_launch_configs WHERE id='bengaluru'").get().version),
    },
  }, LAUNCH_STAFF);

  const resolveZone = () => get("../app/api/service-zone/route.ts", `/api/service-zone?pincode=${TARGET}`);
  const saveAddress = () => post("../app/api/grooming-service-location/route.ts", "/api/grooming-service-location",
    { bookingId: "BK-F38", customerId: "CUST-F38", address: "221B Koramangala 5th Block", pincode: TARGET }, { cookie });
  const durableRows = () => ({
    serviceLocations: sqlite.prepare("SELECT COUNT(*) n FROM booking_service_locations").get().n,
    addresses: sqlite.prepare("SELECT COUNT(*) n FROM customer_addresses").get().n,
  });

  return { sqlite, db, seededPincodes, withoutTarget: seededPincodes.split(",").map(v => v.trim()).filter(v => v !== TARGET).join(","), saveCity, resolveZone, saveAddress, durableRows };
}

test("W1-F38: pausing a city stops zone resolution and the doorstep-address gate", async () => {
  const w = await world();
  assert.equal((await w.saveCity({ status: "Paused", pincodes: w.seededPincodes })).status, 201);
  assert.equal(w.sqlite.prepare("SELECT status FROM city_launch_configs WHERE city_code='blr'").get().status, "Paused");

  const zone = await w.resolveZone();
  assert.equal(zone.status, 409, `a paused market must not resolve zones: ${JSON.stringify(zone.body)}`);
  assert.equal(zone.body?.code, "city_paused");

  const address = await w.saveAddress();
  assert.equal(address.status, 409, `a paused market must not accept a doorstep address: ${JSON.stringify(address.body)}`);
  assert.equal(address.body?.code, "city_paused");
  assert.deepEqual(w.durableRows(), { serviceLocations: 0, addresses: 0 },
    "a refused address must leave no active service location and no default customer address");
});

test("W1-F38: removing a pincode from a Live city's coverage stops it too", async () => {
  const w = await world();
  assert.equal((await w.saveCity({ status: "Live", pincodes: w.withoutTarget })).status, 201);
  assert.equal(w.sqlite.prepare("SELECT status FROM city_launch_configs WHERE city_code='blr'").get().status, "Live",
    "this case must exercise coverage, not the paused kill switch");

  const zone = await w.resolveZone();
  assert.equal(zone.status, 409, `a de-advertised pincode must not resolve: ${JSON.stringify(zone.body)}`);
  assert.equal(zone.body?.code, "pincode_not_in_city_coverage");

  const address = await w.saveAddress();
  assert.equal(address.status, 409, `a de-advertised pincode must not accept an address: ${JSON.stringify(address.body)}`);
  assert.equal(address.body?.code, "pincode_not_in_city_coverage");
  assert.deepEqual(w.durableRows(), { serviceLocations: 0, addresses: 0 });
});

test("W1-F38: a Live city that still advertises the pincode serves it normally", async () => {
  // Non-vacuity. Refusing everywhere would satisfy both cases above and would close the only live city.
  const w = await world();
  assert.equal((await w.saveCity({ status: "Live", pincodes: w.seededPincodes })).status, 201);

  const zone = await w.resolveZone();
  assert.equal(zone.status, 200, `an advertised pincode in a Live city must resolve: ${JSON.stringify(zone.body)}`);
  assert.equal(zone.body?.data?.zone?.zoneId, "blr-south");

  const address = await w.saveAddress();
  assert.equal(address.status, 201, `the doorstep address must still save: ${JSON.stringify(address.body)}`);
  assert.deepEqual(w.durableRows(), { serviceLocations: 1, addresses: 1 });
});

test("W1-F38: the reviewed second-city mapping path is not overridden", async () => {
  // tests/service-zone-coverage.test.mjs states this as a decision already made: "an explicit reviewed
  // database mapping enables a second-city zone without opening a broad range". A city with no launch
  // config has no launch governance to consult, and the mapping remains sufficient authority.
  const w = await world();
  w.sqlite.prepare("INSERT INTO service_zone_mappings (pincode,zone_id,city_id,city,area,created_at) VALUES (?,?,?,?,?,?)")
    .run("600001", "maa-north", "maa", "Chennai", "Parrys", 0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM city_launch_configs WHERE city_code='maa'").get().n, 0,
    "this case is only meaningful while Chennai has no launch config");

  const zone = await get("../app/api/service-zone/route.ts", "/api/service-zone?pincode=600001");
  assert.equal(zone.status, 200, `a reviewed second-city mapping must still open its zone: ${JSON.stringify(zone.body)}`);
  assert.equal(zone.body?.data?.assignment?.cityId, "maa");
});

test("W1-F38: a Draft city's explicitly mapped pincode still resolves", async () => {
  // The other decision already made, quoted from that suite: "560102 is in the explicit table, so it
  // still resolves - that is intended." Draft and Pilot semantics are a product decision and are left
  // exactly where this repository put them.
  const w = await world();
  assert.equal((await w.saveCity({ status: "Draft", pincodes: w.seededPincodes })).status, 201);

  const zone = await w.resolveZone();
  assert.equal(zone.status, 200, `a Draft city's mapped pincode must still resolve: ${JSON.stringify(zone.body)}`);
});

test("W1-F38: advertised coverage is parsed strictly, never truncated into a different real pincode", async () => {
  // lib/pincode-validation.ts states the house rule for this boundary in as many words: "do not strip
  // letters/punctuation or truncate longer input, because doing so can silently turn garbage into a
  // different, serviceable PIN." A 7-digit typo must not become coverage for 560034.
  const { advertisedPincodes } = await import("../lib/city-coverage-authority.ts");
  assert.deepEqual([...advertisedPincodes("5600341")], [], "a 7-digit token is malformed, not a prefix");
  assert.deepEqual([...advertisedPincodes("600001, 600002, OMR, Anna Nagar")], ["600001", "600002"],
    "named clusters are not pincodes");
  assert.deepEqual([...advertisedPincodes("")], [], "an empty coverage field advertises nothing");
  assert.deepEqual([...advertisedPincodes("560034,560102")], ["560034", "560102"]);
});
