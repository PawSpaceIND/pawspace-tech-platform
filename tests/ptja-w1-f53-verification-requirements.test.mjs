/**
 * Approved provider verification requirements for Dog Walking and Pet Taxi, and the fail-closed rule
 * that unknown is never satisfied. [PTJA-W1-F53]
 *
 * WHAT WAS MEASURED. Two of the six canonical services had no verification category at all:
 *
 *   categoryForVertical(grooming)=groomer  boarding=host  pet_sitting=pet_sitter  dog_training=trainer
 *   categoryForVertical(dog_walking)=null  pet_taxi=null
 *   PROVIDER_CATEGORIES=['groomer','pet_sitter','trainer','host']
 *
 * and the activation checklist answered that null by pushing check("category_verification_mandate",
 * TRUE). A dog walker was activated end to end with zero verification rows - provider_verifications was
 * never even created for that journey - and zero onboarding documents. Nor could an operator close it:
 *   setCategoryMandate('dog_walker') -> "Unknown category (use one of: groomer, pet_sitter, trainer, host)"
 * There was no way to require Aadhaar of a dog walker, or a police check of a pet-taxi driver who takes
 * sole custody of an animal and drives it away.
 *
 * That is this audit's most common defect in its purest form: unknown or absent treated as satisfied.
 *
 * THE APPROVED REQUIREMENTS are asserted below, and they are CONFIGURATION - scoped by service and city
 * in Control Center, so a city that demands more of a taxi driver writes a row rather than waiting for a
 * deploy. The last group proves that end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F53_DB__", "__PTJA_F53_ENV__");

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

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_F53_DB__ = db;
  globalThis.__PTJA_F53_ENV__ = {};
  const { seedApprovedVerificationPolicies } = await import("../lib/provider-verification-policy.ts");
  await seedApprovedVerificationPolicies(db);
  return { sqlite, db };
}
const policyFor = async (db, vertical, cityId = "blr") => {
  const { resolveProviderVerificationPolicy } = await import("../lib/provider-verification-policy.ts");
  return resolveProviderVerificationPolicy(db, vertical, cityId);
};

test("F53: Dog Walking demands the approved custody checks", async () => {
  const { db } = await world();
  const policy = await policyFor(db, "dog_walking");
  // Government photo ID is the platform's existing `aadhaar` check - one record for one fact.
  assert.deepEqual(policy.config.requiredTypes.slice().sort(), [
    "aadhaar", "address", "emergency_safety_training", "pet_handling_induction",
    "police_verification", "references_background", "selfie_liveness",
  ]);
  assert.deepEqual(policy.config.payoutBlockingTypes, ["bank_kyc"], "bank/KYC blocks payout, separately from taking work");
  assert.equal(policy.config.category, "dog_walker");
});

test("F53: Pet Taxi demands the custody checks plus the vehicle documents", async () => {
  const { db } = await world();
  const policy = await policyFor(db, "pet_taxi");
  for (const required of ["aadhaar", "address", "police_verification", "selfie_liveness",
    "pet_handling_induction", "emergency_safety_training",
    "driving_licence", "vehicle_registration", "vehicle_insurance", "vehicle_fitness_pollution"]) {
    assert.ok(policy.config.requiredTypes.includes(required), `${required} must be mandatory for Pet Taxi`);
  }
  assert.deepEqual(policy.config.recommendedTypes, ["references_background"],
    "references are recommended for Pet Taxi, not blocking - as the approved table says");
  assert.ok(!policy.config.requiredTypes.includes("references_background"),
    "and a recommended check must not also be blocking");
});

test("F53: every check the approved requirements name actually exists as a verification type", async () => {
  // A requirement naming a type the platform cannot record is a requirement nobody can ever satisfy.
  const { VERIFICATION_TYPES } = await import("../lib/provider-verification-mandate.ts");
  const { APPROVED_VERIFICATION_BY_VERTICAL } = await import("../lib/provider-verification-policy.ts");
  const known = new Set(VERIFICATION_TYPES.map((type) => type.code));
  for (const [vertical, config] of Object.entries(APPROVED_VERIFICATION_BY_VERTICAL)) {
    for (const type of [...config.requiredTypes, ...config.recommendedTypes, ...config.payoutBlockingTypes]) {
      assert.ok(known.has(type), `${vertical} requires "${type}", which is not a known verification type`);
    }
  }
});

test("F53: an operator can now mandate checks for a walker and a taxi driver", async () => {
  const { db } = await world();
  const mandate = await import("../lib/provider-verification-mandate.ts");
  assert.deepEqual(mandate.PROVIDER_CATEGORIES.slice().sort(),
    ["dog_walker", "groomer", "host", "pet_sitter", "pet_taxi_driver", "trainer"]);
  assert.equal(mandate.verificationCategoryForVertical("dog_walking"), "dog_walker");
  assert.equal(mandate.verificationCategoryForVertical("pet_taxi"), "pet_taxi_driver");

  // Measured before: "Unknown category (use one of: groomer, pet_sitter, trainer, host)".
  const saved = await mandate.setCategoryMandate(db, { category: "pet_taxi_driver",
    verificationTypes: ["aadhaar", "police_verification", "driving_licence"], actorId: "ops@pawspace.test" });
  assert.deepEqual(saved.verificationTypes, ["aadhaar", "police_verification", "driving_licence"]);
});

test("F53: narrowing a category mandate narrows what activation actually demands", async () => {
  // ONE AUTHORITY. lib/provider-verification-mandate.ts already promised - and its own suite already
  // asserted - that an operator may narrow a mandate and have the narrowing stick. Moving the authority
  // into the policy would have silently overruled that: accepted, recorded, then ignored by the gate.
  const { db } = await world();
  const mandate = await import("../lib/provider-verification-mandate.ts");
  await mandate.setCategoryMandate(db, { category: "dog_walker", verificationTypes: ["aadhaar", "police_verification"], actorId: "ops@pawspace.test" });

  const policy = await policyFor(db, "dog_walking");
  assert.deepEqual(policy.config.requiredTypes, ["aadhaar", "police_verification"],
    "the gate reads what the operator saved, not the seeded default");
});

test("F53: an unconfigured vertical blocks activation instead of passing it", async () => {
  const { db } = await world();
  const { resolveProviderVerificationPolicy } = await import("../lib/provider-verification-policy.ts");
  const unknown = await resolveProviderVerificationPolicy(db, "astrology_for_cats", "blr");
  assert.equal(unknown.config.configured, false, "nothing is configured for a vertical nobody has decided about");
  assert.deepEqual(unknown.config.requiredTypes, [], "so it requires nothing...");
  // ...and requiring nothing is exactly why the activation check must FAIL rather than pass. The
  // end-to-end proof is in tests/provider-lifecycle-hardening.test.mjs, whose dog_walking fixtures had to
  // start clearing verification explicitly once this landed - they had been relying on a service that
  // demanded none.
  assert.equal(unknown.matchedBy, "platform_default");
});

test("F53: a city can demand more of a taxi driver without a deploy", async () => {
  const { db } = await world();
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_VERIFICATION_BY_VERTICAL, PROVIDER_VERIFICATION_DOMAIN } = await import("../lib/provider-verification-policy.ts");
  const base = APPROVED_VERIFICATION_BY_VERTICAL.pet_taxi;

  await writeServicePolicy(db, { domain: PROVIDER_VERIFICATION_DOMAIN, serviceCode: "pet_taxi", cityId: "blr",
    config: { ...base, requiredTypes: [...base.requiredTypes, "references_background"], recommendedTypes: [] } },
    "ops@pawspace.test", "Bengaluru requires references of every taxi driver");

  const bengaluru = await policyFor(db, "pet_taxi", "blr");
  const elsewhere = await policyFor(db, "pet_taxi", "maa");
  assert.ok(bengaluru.config.requiredTypes.includes("references_background"), "Bengaluru now demands it");
  assert.ok(!elsewhere.config.requiredTypes.includes("references_background"), "another city still follows the approved default");
  assert.equal(bengaluru.matchedBy, "service_and_city");
});

test("F53: a configuration that contradicts itself or switches off blocking cannot be saved", async () => {
  const { db } = await world();
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_VERIFICATION_BY_VERTICAL, PROVIDER_VERIFICATION_DOMAIN } = await import("../lib/provider-verification-policy.ts");
  const base = APPROVED_VERIFICATION_BY_VERTICAL.dog_walking;
  const rejected = [
    [{ requiredTypes: [], configured: true }, "a configured vertical that requires nothing"],
    [{ recommendedTypes: ["police_verification"] }, "a check that is both blocking and advisory"],
    [{ blockAssignmentOnExpiredOrRejected: false }, "letting an expired mandatory document keep taking work"],
    [{ preserveInProgressWorkOnBlock: false }, "deleting work already in progress when a provider is blocked"],
  ];
  for (const [patch, why] of rejected) {
    await assert.rejects(
      () => writeServicePolicy(db, { domain: PROVIDER_VERIFICATION_DOMAIN, serviceCode: "dog_walking", cityId: "blr", config: { ...base, ...patch } }, "ops@pawspace.test", "attempted change"),
      (error) => { assert.ok(error instanceof Response, `${why}: expected a refusal`); return true; }, `${why} must be refused`);
  }
});

test("F53: a legitimate tightening through the same path is accepted and audited", async () => {
  // Non-vacuity for the case above: refusing every write would satisfy it and make the requirements
  // unconfigurable, which is half the finding.
  const { sqlite, db } = await world();
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_VERIFICATION_BY_VERTICAL, PROVIDER_VERIFICATION_DOMAIN } = await import("../lib/provider-verification-policy.ts");
  const base = APPROVED_VERIFICATION_BY_VERTICAL.dog_walking;

  const saved = await writeServicePolicy(db, { domain: PROVIDER_VERIFICATION_DOMAIN, serviceCode: "dog_walking", cityId: "blr",
    config: { ...base, requiredTypes: [...base.requiredTypes, "pan"] } },
    "ops@pawspace.test", "Bengaluru walkers must also present PAN");

  assert.ok(saved.config.requiredTypes.includes("pan"));
  const audit = sqlite.prepare("SELECT actor_id,reason FROM service_policy_audit WHERE policy_domain='provider_verification_policy' AND city_id='blr' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(audit.actor_id, "ops@pawspace.test");
  assert.match(String(audit.reason), /must also present PAN/);
});
