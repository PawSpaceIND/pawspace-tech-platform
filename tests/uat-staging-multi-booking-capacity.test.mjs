/**
 * Owner request 2026-09-26: on STAGING, test bookings used up the thin UAT Boarding, Pet Sitting and Pet
 * Taxi roster, so every later tester saw "no host / sitter / driver available". The fix is more UAT
 * capacity in scripts/uat-staging-provider-capacity.sql, NOT a relaxed scheduler: a sitter or driver still
 * cannot be in two places at once, and a Boarding home still holds a bounded number of pets.
 *
 * Every assertion here executes the seed file itself against a real SQLite database, then drives the real
 * code the customer's booking goes through: backend/src/scheduling.ts schedule() over
 * lib/provider-capacity-governance.ts loadGovernedProviders (verification + founder_seed provenance gate)
 * and lib/scheduling-roster-authority.ts (published availability), the Taxi fleet hold in
 * lib/taxi-fleet-governance.ts, and Boarding host discovery and matching. A change that keeps the SQL text
 * but breaks the rows fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__UAT_MULTI_BOOKING_DB__", "__UAT_MULTI_BOOKING_ENV__");
// The staging runtime declares a UAT scheduling environment; that declaration plus founder_seed provenance
// is what lets an unverified synthetic roster row be matched at all.
globalThis.__UAT_MULTI_BOOKING_ENV__ = { PAWSPACE_SCHEDULING_ENV: "uat" };

const { schedule } = await import("../backend/src/scheduling.ts");
const { loadGovernedProviders } = await import("../lib/provider-capacity-governance.ts");
const { listAuthoritativeAvailability } = await import("../lib/scheduling-roster-authority.ts");
const { ensureTaxiFleetTables, holdTaxiFleetVehicle, TAXI_FULL_TIME_DRIVERS } = await import("../lib/taxi-fleet-governance.ts");
const { ensureBoardingStayLifecycleTables } = await import("../lib/boarding-stay-lifecycle.ts");
const { boardingStayStatement } = await import("../lib/boarding-governance.ts");
const { discoverBoardingHosts } = await import("../lib/boarding-host-discovery.ts");
const { assertBoardingHostMatches } = await import("../lib/boarding-host-capability.ts");

const SEED_PATH = "scripts/uat-staging-provider-capacity.sql";
const seed = fs.readFileSync(new URL(`../${SEED_PATH}`, import.meta.url), "utf8");
const ZONES = ["east", "south", "north", "west", "central"];

/** A local IST wall-clock time tomorrow, as the UTC instant the booking APIs carry. */
function istTomorrow(hour, plusHours = 0) {
  const ist = new Date(Date.now() + 5.5 * 3_600_000 + 24 * 3_600_000);
  const day = ist.toISOString().slice(0, 10);
  return new Date(new Date(`${day}T${String(hour).padStart(2, "0")}:00:00+05:30`).getTime() + plusHours * 3_600_000).toISOString();
}

/** Staging as it really is: the runtime created its tables first, then the deploy loaded the seed. */
async function world({ loadSeed = true } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  await ensureBoardingStayLifecycleTables(db);
  await ensureTaxiFleetTables(db);
  if (loadSeed) sqlite.exec(seed);
  return { sqlite, db, bookings: [] };
}

/** The repository the customer reserve path builds (app/api/uat-scheduling/route.ts), over this database. */
function repository({ db, bookings }, at) {
  return {
    listEligibleProviders: (cityId, zoneId, serviceCode) => loadGovernedProviders(db, cityId, zoneId, serviceCode, new Date(at)),
    listBookings: async (cityId, providerId) => bookings.filter((b) => b.cityId === cityId && (!providerId || b.providerId === providerId)),
    listAvailability: async (providerId, date) => (await listAuthoritativeAvailability(db, providerId, date)).map((row) => ({
      id: String(row.id), providerId: String(row.provider_id), cityId: String(row.city_id), zoneId: String(row.zone_id),
      date: String(row.date), windows: JSON.parse(String(row.windows_json)), source: String(row.source),
    })),
    providerUnavailableForWindow: async () => false,
    getPet: async (id) => ({ id, customerId: "CUST-UAT", name: id, species: "dog", allergies: [], vaccinationStatus: "verified" }),
  };
}

/** Reserve one booking through the real scheduler and, when it is assigned, hold that provider's time. */
async function reserve(w, request) {
  const input = { cityId: "blr", occurrences: 1, ...request };
  const decision = await schedule(repository(w, input.scheduledStart), input);
  if (decision.provider) {
    w.bookings.push({ id: `BKG-${w.bookings.length + 1}`, cityId: "blr", zoneId: input.zoneId, providerId: decision.provider.id,
      petIds: input.petIds, capacityUnits: input.petIds.length, scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd,
      serviceCode: input.serviceCode, status: "confirmed" });
  }
  return decision;
}

/** The lib modules refuse by throwing a Response; returns it so its status and body can be asserted. */
async function refusal(promise, message) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof Response, `${message}: expected an HTTP refusal, got ${error}`);
    return error;
  }
  assert.fail(`${message}: expected a refusal`);
}

test("every Bengaluru zone gets 7 Boarding hosts (8 pet units each), 8 sitters and 10 drivers, all founder_seed and published", async () => {
  const { sqlite } = await world();
  const tomorrow = istTomorrow(12).slice(0, 10);
  for (const zone of ZONES) {
    const zoneId = `blr-${zone}`;
    const count = (service, prefix) => sqlite.prepare(
      "SELECT COUNT(*) n FROM provider_capacity_profiles WHERE id LIKE ? AND city_id='blr' AND live=1 AND status='active' AND updated_by='founder_seed' AND services_json=? AND zones_json=?",
    ).get(`${prefix}_${zone}_%`, JSON.stringify([service]), JSON.stringify([zoneId])).n;
    assert.equal(count("boarding", "uatcap_host"), 7, `${zoneId} Boarding hosts`);
    assert.equal(count("pet_sitting", "uatcap_sit"), 8, `${zoneId} sitters`);
    assert.equal(count("pet_taxi", "uatcap_taxi"), 10, `${zoneId} drivers`);
    const hosts = sqlite.prepare("SELECT p.capacity,h.max_guest_pets,h.one_family_only,h.zone_id,h.active,h.home_verified,h.kyc_status,h.background_check_status,h.species_json,h.medication_support FROM provider_capacity_profiles p JOIN boarding_host_profiles h ON h.provider_id=p.id WHERE p.id LIKE ?").all(`uatcap_host_${zone}_%`);
    assert.equal(hosts.length, 7, `${zoneId} hosts each have a host profile`);
    for (const { one_family_only: _declared, ...host } of hosts) {
      assert.deepEqual(host, { capacity: 8, max_guest_pets: 8, zone_id: zoneId, active: 1, home_verified: 1,
        kyc_status: "verified", background_check_status: "verified", species_json: '["dog","cat"]', medication_support: 1 });
    }
    assert.equal(hosts.filter((host) => host.one_family_only === 0).length, 6, `${zoneId} has six multi-family homes`);
    // Authored roster rows, so the scheduler does not depend on the per-request uat_roster write.
    const published = sqlite.prepare("SELECT COUNT(DISTINCT provider_id) n FROM scheduling_availability WHERE source='roster' AND zone_id=? AND date=? AND (provider_id LIKE 'uatcap\\_host\\_%' ESCAPE '\\' OR provider_id LIKE 'uatcap\\_sit\\_%' ESCAPE '\\' OR provider_id LIKE 'uatcap\\_taxi\\_%' ESCAPE '\\') AND provider_id NOT IN ('uatcap_taxi_ft','uatcap_sit_cm','uatcap_host_cm')").get(zoneId, tomorrow).n;
    assert.equal(published, 25, `${zoneId} publishes availability for every new provider`);
  }
});

test("each new provider has a unique partner OTP identity, so it can sign in to /partner-app", async () => {
  const { sqlite } = await world();
  const ids = sqlite.prepare("SELECT id,name FROM provider_capacity_profiles WHERE id LIKE 'uatcap\\_host\\_%\\_%' ESCAPE '\\' OR id LIKE 'uatcap\\_sit\\_%\\_%' ESCAPE '\\' OR id LIKE 'uatcap\\_taxi\\_%\\_%' ESCAPE '\\'").all();
  assert.equal(ids.length, 125);
  for (const { id, name } of ids) {
    const identity = sqlite.prepare("SELECT name,phone FROM canonical_providers WHERE id=?").get(id);
    assert.ok(identity, `${id} needs a canonical_providers row`);
    assert.equal(identity.name, name);
    assert.match(identity.phone, /^900000[345][1-5]\d{2}$/);
  }
  const all = sqlite.prepare("SELECT phone FROM canonical_providers").all().map((row) => row.phone);
  assert.equal(new Set(all).size, all.length, "sign-in numbers stay globally unique");
  assert.equal(sqlite.prepare("SELECT phone FROM canonical_providers WHERE id='uatcap_sit_south_3'").get().phone, "9000004203");
});

test("Pet Sitting: nine overlapping visits in one zone all get a sitter, and a sitter still takes one visit at a time", async () => {
  const w = await world();
  const window = { serviceCode: "pet_sitting", zoneId: "blr-south", careMode: "visit", scheduledStart: istTomorrow(11), scheduledEnd: istTomorrow(11, 1) };
  const assigned = [];
  for (let i = 0; i < 9; i++) {
    const decision = await reserve(w, { ...window, petIds: [`PET-S${i}`] });
    assert.ok(decision.provider, `visit ${i + 1} must get a sitter: ${JSON.stringify(decision.explanation)}`);
    assigned.push(decision.provider.id);
  }
  assert.equal(new Set(assigned).size, 9, "no sitter is double-booked");
  assert.equal(assigned.filter((id) => id.startsWith("uatcap_sit_south_")).length, 8);
  const tenth = await reserve(w, { ...window, petIds: ["PET-S9"] });
  assert.equal(tenth.provider, null, "one job at a time per sitter is unchanged: the zone is now genuinely full");
  assert.ok(tenth.evaluations.every((e) => e.reasons.includes("Existing booking conflicts with travel/service buffer")));
});

test("Pet Sitting overnight: eight overlapping overnight stays in one zone all get a sitter", async () => {
  const w = await world();
  const stay = { serviceCode: "pet_sitting", zoneId: "blr-central", careMode: "overnight", scheduledStart: istTomorrow(20), scheduledEnd: istTomorrow(20, 12) };
  const assigned = [];
  for (let i = 0; i < 8; i++) {
    const decision = await reserve(w, { ...stay, petIds: [`PET-O${i}`] });
    assert.ok(decision.provider, `overnight ${i + 1} must get a sitter`);
    assigned.push(decision.provider.id);
  }
  assert.equal(new Set(assigned).size, 8);
});

test("Pet Sitting overnight: a zone sitter takes a two-pet overnight (pets count against capacity)", async () => {
  const w = await world();
  const stay = { serviceCode: "pet_sitting", zoneId: "blr-south", careMode: "overnight", scheduledStart: istTomorrow(20), scheduledEnd: istTomorrow(20, 12) };
  const zoneSitters = [];
  for (let i = 0; i < 8; i++) {
    const decision = await reserve(w, { ...stay, petIds: [`PET-TWO${i}A`, `PET-TWO${i}B`] });
    assert.ok(decision.provider, `two-pet overnight ${i + 1} must get a sitter`);
    if (decision.provider.id.startsWith("uatcap_sit_south_")) zoneSitters.push(decision.provider.id);
  }
  assert.ok(zoneSitters.length >= 7, `the south zone sitters take two-pet overnights (got ${zoneSitters.length})`);
});

test("Pet Taxi: ten overlapping rides in one 3-hour window and zone each get a driver AND a Citroen eC3", async () => {
  const w = await world();
  const window = { serviceCode: "pet_taxi", zoneId: "blr-south", scheduledStart: istTomorrow(10), scheduledEnd: istTomorrow(10, 3) };
  const drivers = [], cars = [];
  for (let i = 0; i < 10; i++) {
    const decision = await reserve(w, { ...window, petIds: [`PET-T${i}`] });
    assert.ok(decision.provider, `ride ${i + 1} must get a driver: ${JSON.stringify(decision.explanation)}`);
    const held = await holdTaxiFleetVehicle(w.db, { quoteId: `TQ-${i}`, vehicleClass: "citroen_ec3", providerId: decision.provider.id, cityId: "blr", scheduledStart: window.scheduledStart, scheduledEnd: window.scheduledEnd });
    assert.equal(held.vehicleClass, "citroen_ec3");
    assert.equal(held.pawspaceSharePercent + held.ownerCommissionPercent, 100);
    drivers.push(decision.provider.id);
    cars.push(held.vehicleId);
  }
  assert.equal(new Set(drivers).size, 10, "no driver is double-booked");
  assert.equal(new Set(cars).size, 10, "no car is double-booked");
});

test("Pet Taxi: the city-wide driver now has a car, XUV rides run in parallel, and the fleet still runs out honestly", async () => {
  const w = await world();
  const window = { scheduledStart: istTomorrow(14), scheduledEnd: istTomorrow(14, 3) };
  // uatcap_taxi_ft, the only driver outside blr-east before this change, had no car at all.
  const ft = await holdTaxiFleetVehicle(w.db, { quoteId: "TQ-FT", vehicleClass: "citroen_ec3", providerId: "uatcap_taxi_ft", cityId: "blr", ...window });
  assert.ok(ft.vehicleId);
  const xuv = [];
  for (let i = 0; i < 5; i++) {
    const decision = await reserve(w, { serviceCode: "pet_taxi", zoneId: "blr-north", petIds: [`PET-X${i}`], ...window });
    assert.ok(decision.provider);
    xuv.push((await holdTaxiFleetVehicle(w.db, { quoteId: `TQ-X${i}`, vehicleClass: "xuv", providerId: decision.provider.id, cityId: "blr", ...window })).vehicleId);
  }
  assert.equal(new Set(xuv).size, 5);
  // 12 eC3 in the city (10 UAT + the runtime's 2); one is already out. Eleven more fit; the twelfth does not.
  const busy = new Set(w.bookings.map((b) => b.providerId));
  const free = ZONES.flatMap((zone) => Array.from({ length: 10 }, (_, i) => `uatcap_taxi_${zone}_${i + 1}`)).filter((id) => !busy.has(id));
  for (let i = 0; i < 11; i++) await holdTaxiFleetVehicle(w.db, { quoteId: `TQ-E${i}`, vehicleClass: "citroen_ec3", providerId: free[i], cityId: "blr", ...window });
  const over = await refusal(holdTaxiFleetVehicle(w.db, { quoteId: "TQ-E-OVER", vehicleClass: "citroen_ec3", providerId: free[11], cityId: "blr", ...window }), "13th eC3");
  assert.equal(over.status, 409);
  assert.match(await over.text(), /No Citroen eC3 is free for this 3-hour Taxi window in blr/);
});

test("Boarding: every zone discovers six multi-family homes with 8 free places, and one host takes 8 pets", async () => {
  const w = await world();
  const stay = { scheduledStart: istTomorrow(10), scheduledEnd: istTomorrow(10, 24) };
  for (const zone of ZONES) {
    const hosts = await discoverBoardingHosts(w.db, { cityId: "blr", zoneId: `blr-${zone}`, petCount: 2, species: ["dog", "cat"], ...stay });
    const uat = hosts.filter((host) => host.providerId.startsWith(`uatcap_host_${zone}_`));
    assert.equal(uat.length, 7, `blr-${zone} shows all seven UAT homes`);
    assert.ok(uat.every((host) => host.capacity === 8 && host.availableGuestPets === 8));
  }
  // Scheduler: two overlapping four-pet stays share one home; a ninth pet is refused on capacity.
  const host = "uatcap_host_west_1";
  const book = (pets, tag) => reserve(w, { serviceCode: "boarding", zoneId: "blr-west", preferredProviderId: host, preferredProviderMode: "strict",
    petIds: Array.from({ length: pets }, (_, i) => `PET-${tag}${i}`), ...stay });
  assert.equal((await book(4, "A")).provider?.id, host);
  assert.equal((await book(4, "B")).provider?.id, host, "a second family shares the same home");
  const ninth = await book(1, "C");
  assert.equal(ninth.provider, null);
  assert.ok(ninth.evaluations.find((e) => e.providerId === host).reasons.includes("Capacity 8 exceeded for the stay range"));
  // Booking-time gate reads the stays actually in the home.
  const matching = { providerId: host, cityId: "blr", zoneId: "blr-west", species: ["dog"], medicationRequired: false, ...stay };
  for (const [i, petCount] of [4, 4].entries()) {
    await assertBoardingHostMatches(w.db, { ...matching, petCount });
    await boardingStayStatement(w.db, { bookingId: `BKG-BOARD-${i}`, customerId: `CUST-${i}`, providerId: host, cityId: "blr", zoneId: "blr-west",
      packageCode: "boarding-24h", ...stay, stayUnits: 1, petCount }).run();
  }
  const full = await refusal(assertBoardingHostMatches(w.db, { ...matching, petCount: 1 }), "ninth pet");
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, "boarding_host_capacity_exceeded");
});

test("existing UAT hosts are raised to 8 places, but only rows the seeds own, and re-running changes nothing", async () => {
  const { sqlite } = await world({ loadSeed: false });
  sqlite.exec("UPDATE provider_capacity_profiles SET capacity=5,updated_by='ops.manager@pawspace.in' WHERE id='host_priya_dev'");
  const before = sqlite.prepare("SELECT provider_id,one_family_only FROM boarding_host_profiles ORDER BY provider_id").all();
  sqlite.exec(seed);
  const capacity = (id) => sqlite.prepare("SELECT capacity FROM provider_capacity_profiles WHERE id=?").get(id).capacity;
  const places = (id) => sqlite.prepare("SELECT max_guest_pets FROM boarding_host_profiles WHERE provider_id=?").get(id).max_guest_pets;
  for (const id of ["host_maya_rohan", "host_sana", "host_arjun_tara", "uatcap_host_cm"]) assert.equal(capacity(id), 8, id);
  assert.equal(capacity("host_priya_dev"), 5, "an operator's own capacity is never overruled");
  for (const id of ["host_maya_rohan", "host_sana", "host_arjun_tara", "host_priya_dev"]) assert.equal(places(id), 8, id);
  const after = sqlite.prepare("SELECT provider_id,one_family_only FROM boarding_host_profiles WHERE provider_id IN (" + before.map(() => "?").join(",") + ") ORDER BY provider_id").all(...before.map((row) => row.provider_id));
  assert.deepEqual(after, before, "one-family-at-a-time stays as each host declared it");
  const snapshot = () => JSON.stringify(["provider_capacity_profiles", "boarding_host_profiles", "canonical_providers", "taxi_fleet_vehicles", "taxi_driver_vehicle_eligibility", "taxi_vehicle_profiles"]
    .map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()));
  const once = snapshot();
  sqlite.exec(seed);
  assert.equal(snapshot(), once, "the seed is idempotent");
});

test("the seed's Taxi fleet DDL matches the runtime schema whichever runs first", async () => {
  const columns = (sqlite, table) => sqlite.prepare(`PRAGMA table_info(${table})`).all().map(({ cid, name, type, notnull, dflt_value, pk }) => ({ cid, name, type, notnull, dflt_value, pk }));
  const runtimeOnly = freshSqlite();
  await ensureTaxiFleetTables(makeD1(runtimeOnly));
  const seedFirst = freshSqlite();
  seedFirst.exec(seed);
  const seedFirstDb = makeD1(seedFirst);
  await ensureTaxiFleetTables(seedFirstDb); // the runtime's ALTERs meet existing columns and must be ignored
  const runtimeFirst = (await world()).sqlite;
  for (const table of ["taxi_fleet_vehicles", "taxi_driver_vehicle_eligibility"]) {
    assert.deepEqual(columns(seedFirst, table), columns(runtimeOnly, table), `${table}: seed first`);
    assert.deepEqual(columns(runtimeFirst, table), columns(runtimeOnly, table), `${table}: runtime first`);
  }
  // Seed first, the runtime still adds its own three cars beside the fifteen UAT ones.
  assert.equal(seedFirst.prepare("SELECT COUNT(*) n FROM taxi_fleet_vehicles").get().n, 18);
  const held = await holdTaxiFleetVehicle(seedFirstDb, { quoteId: "TQ-SEED-FIRST", vehicleClass: "citroen_ec3", providerId: "uatcap_taxi_east_1", cityId: "blr", scheduledStart: istTomorrow(9), scheduledEnd: istTomorrow(9, 3) });
  assert.equal(held.vehicleId, "TXF-CITROEN-9179", "the company car keeps its first-pick order");
});

test("production path is unchanged: without the staging seed the runtime fleet and roster are exactly as before", async () => {
  const w = await world({ loadSeed: false });
  assert.deepEqual([...TAXI_FULL_TIME_DRIVERS], ["taxi_rahul", "taxi_meera"]);
  assert.deepEqual(w.sqlite.prepare("SELECT id FROM taxi_fleet_vehicles ORDER BY id").all().map((row) => row.id), ["TXF-CITROEN-9179", "TXF-CITROEN-9188", "TXF-XUV-OWNER"]);
  assert.deepEqual(w.sqlite.prepare("SELECT DISTINCT provider_id FROM taxi_driver_vehicle_eligibility ORDER BY 1").all().map((row) => row.provider_id), ["taxi_meera", "taxi_rahul"]);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_capacity_profiles WHERE id LIKE 'uatcap%'").get().n, 0);
  assert.deepEqual((await loadGovernedProviders(w.db, "blr", "blr-south", "pet_sitting")).map((p) => p.id), [], "no roster outside blr-east without the staging seed");
  const window = { cityId: "blr", scheduledStart: istTomorrow(10), scheduledEnd: istTomorrow(10, 3) };
  await holdTaxiFleetVehicle(w.db, { quoteId: "TQ-P1", vehicleClass: "citroen_ec3", providerId: "taxi_rahul", ...window });
  await holdTaxiFleetVehicle(w.db, { quoteId: "TQ-P2", vehicleClass: "citroen_ec3", providerId: "taxi_meera", ...window });
  const third = await refusal(holdTaxiFleetVehicle(w.db, { quoteId: "TQ-P3", vehicleClass: "citroen_ec3", providerId: "taxi_rahul", ...window }), "third production eC3");
  assert.equal(third.status, 409, "two city eC3 per window, as production has always had");
  assert.match(await third.text(), /No Citroen eC3 is free/);
  // The seed is loaded only by staging workflows; the production deploy never reads it.
  const workflows = fs.readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((name) => name.endsWith(".yml"));
  const loaders = workflows.filter((name) => fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8").includes(SEED_PATH));
  assert.ok(loaders.length > 0);
  for (const name of loaders) assert.doesNotMatch(name, /production/, `${name} must not load the UAT roster`);
  for (const name of loaders) assert.match(fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"), /staging/i, `${name} targets staging`);
});
