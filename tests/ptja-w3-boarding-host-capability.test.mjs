/**
 * Boarding host capability: five answers, then five matching constraints. [PTJA-W3-BH]
 *
 * THE APPROVED RULE, supplied by the business:
 *   The five proposed fields are correct and must be answered before a Boarding host profile becomes
 *   active: service area, species accepted, guest capacity, one-family-at-a-time, medication handling.
 *   They are MATCHING CONSTRAINTS, not universal rejection rules - the service area must cover the
 *   booking location, the species must match the pet, available capacity must cover the booking,
 *   one-family-at-a-time becomes a hard constraint when enabled, and medication capability becomes a
 *   hard constraint only when the pet requires medication.
 *   Do not add universal police or government-ID requirements through this work.
 *
 * WHAT WAS MEASURED BEFORE. boarding_host_profiles carries all five columns and nothing collects them:
 * the only writers in the repository are a hardcoded seed and a demo SQL file, so a real host can never
 * be boarded. Activation checks that a profile ROW EXISTS, not that it says anything - a row with no
 * area, an empty species list and zero capacity passes. And medication_support is read by nothing at
 * all: a host who cannot give medication was matched to a pet that needs it, every time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_BH_DB__", "__PTJA_BH_ENV__");

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

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

const HOST = "PRV-HOST-1";

const COMPLETE = {
  providerId: HOST, cityId: "blr", zoneId: "blr-east",
  area: "Indiranagar", species: ["dog", "cat"], maxGuestPets: 3,
  oneFamilyOnly: false, medicationSupport: true,
};

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_BH_DB__ = db;
  globalThis.__PTJA_BH_ENV__ = {};
  const governance = await import("../lib/boarding-governance.ts");
  await governance.ensureBoardingGovernanceTables(db);
  const capability = await import("../lib/boarding-host-capability.ts");
  await capability.ensureBoardingHostCapabilityTables(db);
  const now = Date.now();
  // Every NOT NULL column the table declares is filled, so a fixture cannot fail for a reason unrelated
  // to the capability rule under test.
  const columns = sqlite.prepare("PRAGMA table_info(provider_capacity_profiles)").all();
  const values = { id: HOST, city_id: "blr", name: "Host One", provider_model: "commission",
    services_json: JSON.stringify(["boarding"]), zones_json: JSON.stringify(["blr-east"]),
    rating: 4.8, quality_score: 90, capacity: 3, travel_buffer_minutes: 0, max_daily_jobs: 3,
    live: 1, status: "active", version: 1, updated_by: "seed", updated_at: now,
    effective_from: "2026-01-01", effective_to: null };
  const used = [], bound = [];
  for (const column of columns) {
    const name = String(column.name);
    if (name in values) { used.push(name); bound.push(values[name]); continue; }
    if (Number(column.notnull) !== 1 || column.dflt_value !== null) continue;
    used.push(name);
    bound.push(/INT|REAL|NUM/i.test(String(column.type)) ? 0 : "");
  }
  sqlite.prepare(`INSERT OR REPLACE INTO provider_capacity_profiles (${used.join(",")}) VALUES (${used.map(() => "?").join(",")})`).run(...bound);
  return { sqlite, db, capability, governance };
}

const save = (capability, db, over = {}) =>
  attempt(capability.saveBoardingHostCapability(db, { ...COMPLETE, ...over }, "ops@pawspace.test"));

// ---------------------------------------------------------------------------------------------------
// The five answers must exist before a host is active
// ---------------------------------------------------------------------------------------------------

test("BH-01: a host profile cannot go active with any of the five unanswered", async () => {
  const { db, capability } = await world();
  for (const [label, over] of [
    ["no service area", { area: "" }],
    ["no species accepted", { species: [] }],
    ["no guest capacity", { maxGuestPets: 0 }],
    ["no one-family answer", { oneFamilyOnly: null }],
    ["no medication answer", { medicationSupport: null }],
  ]) {
    const result = await save(capability, db, over);
    assert.equal(result.ok, false, `${label} must not produce an active host: ${JSON.stringify(result).slice(0, 250)}`);
  }
});

test("BH-02: a complete profile saves and is active", async () => {
  // Non-vacuity for BH-01. Refusing everything would satisfy it and mean no host can ever board.
  const { sqlite, db, capability } = await world();
  const saved = await save(capability, db);
  assert.equal(saved.ok, true, `a complete answer set activates the host: ${JSON.stringify(saved).slice(0, 300)}`);
  const row = sqlite.prepare("SELECT active,area,species_json,max_guest_pets,one_family_only,medication_support FROM boarding_host_profiles WHERE provider_id=?").get(HOST);
  assert.equal(Number(row.active), 1, "the profile is active");
  assert.equal(String(row.area), "Indiranagar", "and carries every answer");
  assert.equal(Number(row.max_guest_pets), 3);
  assert.equal(Number(row.medication_support), 1);
});

test("BH-03: false is a valid ANSWER, absence is not", async () => {
  // "This host does not give medication" is information. "Nobody asked" is not, and the two must not
  // collapse into the same stored 0.
  const { sqlite, db, capability } = await world();
  const saved = await save(capability, db, { medicationSupport: false, oneFamilyOnly: false });
  assert.equal(saved.ok, true, `an explicit no is a complete answer: ${JSON.stringify(saved).slice(0, 250)}`);
  assert.equal(Number(sqlite.prepare("SELECT medication_support FROM boarding_host_profiles WHERE provider_id=?").get(HOST).medication_support), 0);
});

test("BH-04: the capability gaps are reportable before anybody tries to book", async () => {
  const { db, capability } = await world();
  const gaps = await capability.boardingHostCapabilityGaps(db, HOST);
  assert.ok(gaps.missing.length >= 5, `an unanswered host lists every gap: ${JSON.stringify(gaps)}`);
  await save(capability, db);
  const after = await capability.boardingHostCapabilityGaps(db, HOST);
  assert.deepEqual(after.missing, [], `and a complete host has none: ${JSON.stringify(after)}`);
});

test("BH-05: activation refuses a boarding provider whose capability is incomplete", async () => {
  // The existing gate checks only that a profile ROW EXISTS. A row saying nothing passed it.
  const { sqlite, db } = await world();
  const now = Date.now();
  sqlite.prepare("INSERT INTO boarding_host_profiles (provider_id,city_id,zone_id,area,species_json,max_guest_pets,one_family_only,medication_support,resident_pets,home_verified,kyc_status,background_check_status,active,version,updated_by,updated_at) VALUES (?,?,?,'','[]',0,0,0,'none',1,'verified','verified',1,1,'seed',?)")
    .run(HOST, "blr", "blr-east", now);
  const activation = await import("../lib/provider-onboarding-human-activation.ts");
  const result = await attempt(activation.addProviderToServiceMap(db, { providerId: HOST, zoneIds: ["blr-east"], actorEmail: "ops@pawspace.test" }));
  assert.equal(result.ok, false, `an empty capability row must not put a host live: ${JSON.stringify(result).slice(0, 300)}`);
  assert.match(String(result.message), /species|capacity|area|medication|one.family/i, `and say what is missing: ${String(result.message).slice(0, 200)}`);
});

// ---------------------------------------------------------------------------------------------------
// Matching constraints, not universal rejections
// ---------------------------------------------------------------------------------------------------

const match = (capability, db, over = {}) => attempt(capability.assertBoardingHostMatches(db, {
  providerId: HOST, cityId: "blr", zoneId: "blr-east",
  species: ["dog"], petCount: 1, medicationRequired: false, ...over,
}));

test("BH-06: the species must match the pet", async () => {
  const { db, capability } = await world();
  await save(capability, db, { species: ["dog"] });
  const refused = await match(capability, db, { species: ["cat"] });
  assert.equal(refused.ok, false, `a dogs-only host is not matched to a cat: ${JSON.stringify(refused).slice(0, 250)}`);
  const allowed = await match(capability, db, { species: ["dog"] });
  assert.equal(allowed.ok, true, `and still takes dogs: ${JSON.stringify(allowed).slice(0, 250)}`);
});

test("BH-07: available capacity must cover the booking", async () => {
  const { db, capability } = await world();
  await save(capability, db, { maxGuestPets: 2 });
  const refused = await match(capability, db, { petCount: 3 });
  assert.equal(refused.ok, false, `three pets do not fit two places: ${JSON.stringify(refused).slice(0, 250)}`);
  const allowed = await match(capability, db, { petCount: 2 });
  assert.equal(allowed.ok, true, "and two do");
});

test("BH-08: the service area must cover the booking location", async () => {
  const { db, capability } = await world();
  await save(capability, db);
  const refused = await match(capability, db, { zoneId: "blr-west" });
  assert.equal(refused.ok, false, `a host outside the booking zone is not matched: ${JSON.stringify(refused).slice(0, 250)}`);
});

test("BH-09: one-family-at-a-time is a hard constraint ONLY when the host enabled it", async () => {
  const { sqlite, db, capability } = await world();
  const now = Date.now();
  const otherFamily = () => sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES (?,?,?,?,'blr','blr-east','pkg','2026-08-01T09:00:00.000Z','2026-08-05T09:00:00.000Z',4,1,'confirmed','required','pending','pending','none',?,?)")
    .run("BSTAY-OTHER", "BK-OTHER", "CUS-OTHER", HOST, now, now);

  await save(capability, db, { oneFamilyOnly: true, maxGuestPets: 4 });
  otherFamily();
  const refused = await match(capability, db, { customerId: "CUS-NEW" });
  assert.equal(refused.ok, false, `a one-family host with a family in residence is not matched: ${JSON.stringify(refused).slice(0, 250)}`);

  await save(capability, db, { oneFamilyOnly: false, maxGuestPets: 4 });
  const allowed = await match(capability, db, { customerId: "CUS-NEW" });
  assert.equal(allowed.ok, true, `and a host who did not enable it still takes the booking: ${JSON.stringify(allowed).slice(0, 250)}`);
});

test("BH-10: medication capability is a hard constraint ONLY when the pet needs medication", async () => {
  const { db, capability } = await world();
  await save(capability, db, { medicationSupport: false });
  const refused = await match(capability, db, { medicationRequired: true });
  assert.equal(refused.ok, false, `a host who cannot give medication is not matched to a pet that needs it: ${JSON.stringify(refused).slice(0, 250)}`);
  const allowed = await match(capability, db, { medicationRequired: false });
  assert.equal(allowed.ok, true, `and is perfectly eligible for a pet that does not: ${JSON.stringify(allowed).slice(0, 250)}`);
});

test("BH-11: a host WITH medication support takes both kinds of pet", async () => {
  // Non-vacuity for BH-10, in the other direction.
  const { db, capability } = await world();
  await save(capability, db, { medicationSupport: true });
  for (const medicationRequired of [true, false]) {
    const allowed = await match(capability, db, { medicationRequired });
    assert.equal(allowed.ok, true, `medicationRequired=${medicationRequired} must be accepted: ${JSON.stringify(allowed).slice(0, 250)}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// What this work must NOT do
// ---------------------------------------------------------------------------------------------------

test("BH-12: no police or government-ID requirement is introduced for Boarding", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/boarding-host-capability.ts", import.meta.url), "utf8");
  void 0;
  for (const term of ["police_verification", "aadhaar", "government_id"]) {
    assert.equal(source.includes(term), false,
      `${term} must not appear: the police floor is Dog Walking and Pet Taxi, and this work may not extend it`);
  }
  // Read from source rather than an export: the floor is a module-private Set, which is itself the
  // point - it is not something another module can widen at runtime.
  const policySource = readFileSync(new URL("../lib/provider-verification-policy.ts", import.meta.url), "utf8");
  const floor = policySource.match(/POLICE_FLOOR_VERTICALS\s*=\s*new Set\(\[([^\]]*)\]/);
  assert.ok(floor, "the police floor is declared as a fixed set");
  assert.equal(floor[1].includes("boarding"), false, "boarding is still outside the police floor");
  assert.match(floor[1], /dog_walker/, "and the two verticals that carry it still do");
  assert.match(floor[1], /pet_taxi_driver/);
});

// ---------------------------------------------------------------------------------------------------
// The constraints reach the real booking path, not just this library
// ---------------------------------------------------------------------------------------------------

test("BH-13: the booking gate consults the capability matcher", async () => {
  // The trap this audit keeps finding: an authority that exists and nothing calls. governBoardingBooking
  // reaches assertHostEligible, which now delegates the five matching constraints.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/boarding-governance.ts", import.meta.url), "utf8");
  assert.match(source, /assertBoardingHostMatches/, "the booking path delegates to the matcher");
  assert.match(source, /medicationRequired/, "and carries the medication signal into it");
  const route = readFileSync(new URL("../app/api/canonical-bookings/route.ts", import.meta.url), "utf8");
  assert.match(route, /medicationRequired:input\.pets\.some/, "which the booking route derives from the pets on the booking");
});

test("BH-14: a medication booking is refused against a host who cannot handle it, through the booking gate", async () => {
  const { sqlite, db, capability, governance } = await world();
  await capability.saveBoardingHostCapability(db, { ...COMPLETE, medicationSupport: false }, "ops@pawspace.test");
  sqlite.prepare("UPDATE boarding_host_profiles SET home_verified=1,kyc_status='verified',background_check_status='verified' WHERE provider_id=?").run(HOST);
  // A REAL quote, because governBoardingBooking checks the quote before it checks the host - without
  // one this case refused for the wrong reason and proved nothing about medication.
  const DAY = 86_400_000;
  const start = new Date(Date.now() + 10 * DAY).toISOString();
  const end = new Date(Date.now() + 11 * DAY).toISOString();
  const quoted = await attempt(governance.createBoardingQuote(db, {
    packageCode: "boarding-24h", petCount: 1,
    scheduledStart: start, scheduledEnd: end,
    paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east",
  }));
  assert.equal(quoted.ok, true, `the fixture's quote is real: ${JSON.stringify(quoted).slice(0, 300)}`);
  const quote = quoted.value;
  const refused = await attempt(governance.governBoardingBooking(db, {
    quoteId: String(quote.quoteId ?? quote.id), packageCode: String(quote.packageCode ?? "boarding-24h"),
    packageName: String(quote.packageName ?? "Standard"), petCount: 1,
    scheduledStart: start, scheduledEnd: end,
    submittedTotal: Number(quote.totalAmount ?? 0), submittedAmountDueNow: Number(quote.amountDueNow ?? 0),
    paymentMode: "prepaid", paymentStatus: "captured",
    reservationCount: 1, providerId: HOST, cityId: "blr", zoneId: "blr-east",
    species: ["dog"], vaccinationStatuses: ["verified"], medicationRequired: true, customerId: "CUS-1",
  }));
  assert.equal(refused.ok, false, `the booking gate refuses it: ${JSON.stringify(refused).slice(0, 300)}`);
  assert.match(String(refused.message), /medication/i, `for the medication reason, not something incidental: ${String(refused.message).slice(0, 200)}`);
});
