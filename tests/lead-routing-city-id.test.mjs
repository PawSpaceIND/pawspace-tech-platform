/*
 * Owner decision 2026-09-22 (decision 5 of 10) — lead-routing policies key on CITY ID.
 *
 * Three places in this codebase decided whether a city scope covers a lead, and they did not agree:
 *
 *   lib/lead-assignment-governance.ts  candidateRows -> cityMatches -> leadCityCovers  (alias-aware)
 *   lib/lead-assignment-governance.ts  activePolicy                                     (SUBSTRING ONLY)
 *   lib/lead-owner-identity.ts         matchesLeadScope -> its own copy of the alias map
 *
 * So a policy scoped to the city id "blr" — the id canonical_bookings and canonical_customers already
 * carry, and the one a routing policy is supposed to be written in — never matched a lead whose CRM
 * area reads "Bengaluru", because "bengaluru".includes("blr") is false. assignLead refused the lead
 * with "No active lead assignment policy matches this lead service/city" while an eligible rep, matched
 * by the alias-aware matcher two lines away, sat in that very city.
 *
 * Every case here drives the real engine against a real database. The policy is written in city ids,
 * which is what the decision says a policy is written in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors } from "./helpers/execution-harness.mjs";

installWorkersHooks("__LEAD_CITY_DB__", "__LEAD_CITY_ENV__");

const REP = "asha.rep@pawspace.in";
const MANAGER = "sales.manager@pawspace.in";
const HOUR = 3600000;

/**
 * A lead whose CRM contact records `area`, and a policy + member scoped to `scopeCities`.
 * `canonicalCityId` optionally gives the lead's canonical customer a city id, which is the value the
 * rest of the platform routes on and must win over the free-text area label.
 */
async function routed({ area, scopeCities, canonicalCityId = null, service = "grooming" }) {
  const { sqlite, db } = world("__LEAD_CITY_DB__", "__LEAD_CITY_ENV__");
  const engine = await import("../lib/lead-assignment-governance.ts");

  await seedActors(sqlite, db, [
    { id: "u-asha", email: REP, role: "sales_executive" },
    { id: "u-mgr", email: MANAGER, role: "sales_manager" },
  ]);
  await engine.ensureLeadAssignmentTables(db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT DEFAULT 'Unassigned',source TEXT DEFAULT 'Website',lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,created_at,updated_at) VALUES ('CRM-1','Rhea Nair','+919800000001','rhea@example.com',?,?,?)").run(area, now, now);
  if (canonicalCityId) sqlite.prepare("INSERT INTO canonical_customers (id,name,primary_phone,email,city_id,created_at,updated_at) VALUES ('CRM-1','Rhea Nair','+919800000001','rhea@example.com',?,?,?)").run(canonicalCityId, now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LEAD-1','CRM-1','meta_ads',?,'Unassigned',?,'active','day_1',1,?,?,?,?,?)")
    .run(service, MANAGER, now, now + HOUR, now + 2 * HOUR, now, now);

  const policy = await engine.saveLeadAssignmentPolicy(db, {
    name: "City-scoped grooming telesales", teamCode: "telesales_blr", serviceCodes: ["grooming"],
    cityIds: scopeCities, maxActiveWorkload: 25, continuityEnabled: false, requireShift: false,
    fallbackQueue: "telesales_unassigned", effectiveFrom: now - HOUR,
    reason: "City-id routing verification for the owner decision", actorId: MANAGER,
  });
  await engine.activateLeadAssignmentPolicy(db, { policyId: policy.id, approvalReference: "OPS-APPROVAL-CITY", reason: "City-id routing verification for the owner decision", actorId: MANAGER });
  await engine.saveLeadAssignmentMember(db, { employeeEmail: REP, teamCode: "telesales_blr", serviceCodes: ["grooming"], cityIds: scopeCities, active: true, actorId: MANAGER });

  const assign = () => engine.assignLead(db, { leadId: "LEAD-1", idempotencyKey: `city:${area}:${scopeCities.join("+")}`, reason: "new_lead", actorId: MANAGER });
  return { sqlite, db, engine, assign };
}

/** assignLead either assigns to someone, or refuses. Returns the owner, or null with the refusal text. */
async function outcome(assign) {
  try {
    const result = await assign();
    return { owner: String(result.assignment?.employee_email ?? ""), refusal: null };
  } catch (error) {
    return { owner: null, refusal: error instanceof Response ? await error.text() : String(error?.message ?? error) };
  }
}

test("a policy written in city ids routes a lead whose CRM area is the city's name", async () => {
  // The defect, at its smallest: policy scope "blr", lead area "Bengaluru".
  const { assign } = await routed({ area: "Bengaluru", scopeCities: ["blr"] });
  const { owner, refusal } = await outcome(assign);
  assert.equal(refusal, null, "a policy scoped to the platform's own city id must match a lead in that city");
  assert.equal(owner, REP);
});

test("it routes the area labels a CRM contact actually carries, not just the bare city name", async () => {
  for (const area of ["Indiranagar, Bengaluru", "BTM Layout, Bangalore", "bengaluru", "BLR"]) {
    const { assign } = await routed({ area, scopeCities: ["blr"] });
    const { owner, refusal } = await outcome(assign);
    assert.equal(refusal, null, `area '${area}' is in Bengaluru and must route`);
    assert.equal(owner, REP, `area '${area}' must reach the rep scoped to blr`);
  }
});

test("scopes already written as labels keep working", async () => {
  // Keying on ids had to widen what matches, never narrow it: the policies that exist today are written
  // as "Bengaluru", and none of them may stop routing.
  for (const scope of [["Bengaluru"], ["Bangalore"], ["blr", "maa"]]) {
    const { assign } = await routed({ area: "Indiranagar, Bengaluru", scopeCities: scope });
    const { owner, refusal } = await outcome(assign);
    assert.equal(refusal, null, `scope ${JSON.stringify(scope)} must still route a Bengaluru lead`);
    assert.equal(owner, REP);
  }
});

test("another city's lead is still refused, and told so", async () => {
  // Non-vacuity. If the matcher had been widened into "matches anything", every case above would pass
  // and routing would be broken in the more dangerous direction.
  const { assign } = await routed({ area: "Banjara Hills, Hyderabad", scopeCities: ["blr"] });
  const { owner, refusal } = await outcome(assign);
  assert.equal(owner, null, "a Hyderabad lead must not be handed to the Bengaluru desk");
  assert.match(refusal, /No active lead assignment policy matches/);
});

test("a city nobody has configured matches only itself", async () => {
  const mismatch = await outcome((await routed({ area: "Kochi", scopeCities: ["blr"] })).assign);
  assert.equal(mismatch.owner, null, "an unmapped city must not fall into another city's queue");

  const match = await outcome((await routed({ area: "Kochi", scopeCities: ["Kochi"] })).assign);
  assert.equal(match.owner, REP, "but a policy scoped to it does route it");
});

test("the canonical customer's city id wins over the free-text CRM area", async () => {
  // crm_contacts.area is an area LABEL maintained by whoever typed it. canonical_customers.city_id is
  // the id the rest of the platform books and dispatches on, so that is the lead's city.
  const { assign } = await routed({ area: "", canonicalCityId: "blr", scopeCities: ["blr"] });
  const { owner, refusal } = await outcome(assign);
  assert.equal(refusal, null, "a lead whose canonical customer is in blr routes on blr");
  assert.equal(owner, REP);

  const wrongCity = await outcome((await routed({ area: "Bengaluru", canonicalCityId: "hyd", scopeCities: ["blr"] })).assign);
  assert.equal(wrongCity.owner, null, "a stale area label must not override the canonical city id");
});

test("all three city matchers now answer the same question the same way", async () => {
  // The three used to be able to drift apart silently; lib/lead-owner-identity.ts carried its own copy
  // of the alias map. This asserts the resolver they now share, over the spellings that differed.
  const { engine } = await routed({ area: "Bengaluru", scopeCities: ["blr"] });
  const identity = await import("../lib/lead-owner-identity.ts");
  assert.equal(typeof engine.leadCityId, "function", "the shared resolver must be exported");
  for (const [value, id] of [["blr", "blr"], ["Bengaluru", "blr"], ["BANGALORE", "blr"], ["Indiranagar, Bengaluru", "blr"], ["Hyderabad", "hyd"], ["Kochi", "kochi"], ["", ""]]) {
    assert.equal(engine.leadCityId(value), id, `'${value}' resolves to '${id}'`);
  }
  assert.equal(engine.leadCityCovers("blr", "Bengaluru"), true);
  assert.equal(engine.leadCityCovers("Bengaluru", "blr"), true, "the match is symmetric, whichever side is written as an id");
  assert.equal(engine.leadCityCovers("blr", "Hyderabad"), false);
  const source = (await import("node:fs")).readFileSync(new URL("../lib/lead-owner-identity.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /bengaluru:"blr"/, "the duplicated alias map must be gone, not merely unused");
  assert.equal(typeof identity.assignLeadOwner, "function");
});
