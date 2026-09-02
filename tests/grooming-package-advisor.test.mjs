import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

// ---------------------------------------------------------------------------
// Grooming package recommendation - real execution of the real modules.
//
// The solution document asks the bot to recommend one of six grooming packages
// from pet type, age, breed and coat, and to be briefed by a written document.
// A written document goes stale; a bot quoting a price PawSpace will not honour
// is the failure that costs real money and real trust.
//
// So the property under test is: the bot can only ever name a package the
// catalogue still sells, at the catalogue's own price, chosen by an ops-owned
// rule - and in every case where that is not possible it says so and hands the
// call to a human instead of improvising.
// ---------------------------------------------------------------------------
installWorkersHooks("__GROOMING_ADVISOR_DB__");

async function world() {
  const { sqlite, db, reset } = freshCountingD1();
  globalThis.__GROOMING_ADVISOR_DB__ = db;
  const catalogue = await import("../lib/catalogue-governance.ts");
  const advisor = await import("../lib/grooming-package-advisor.ts");
  await catalogue.ensureCatalogueTables(db);
  await advisor.ensureGroomingPackageRuleTables(db);
  reset();
  return { sqlite, db, catalogue, advisor };
}

/** The six packages the document refers to, created through the governed catalogue writer. */
async function sixPackages(w) {
  const packages = [
    ["grm_basic_bath", "Basic Bath & Brush", 899],
    ["grm_full_groom", "Full Groom", 1499],
    ["grm_deshed", "De-shed Treatment", 1799],
    ["grm_puppy_intro", "Puppy First Groom", 699],
    ["grm_cat_groom", "Cat Grooming", 1299],
    ["grm_premium_spa", "Premium Spa", 2499],
  ];
  for (const [packageCode, name, basePrice] of packages) {
    await w.catalogue.createCataloguePackage(w.db, { serviceCode: "grooming", packageCode, cityId: "blr", name, description: `${name} at your doorstep`, basePrice, slotMinutes: 90, actorId: "ops@pawspace.in" });
  }
}

const rule = (w, input) => w.advisor.upsertGroomingPackageRule(w.db, { actorId: "ops@pawspace.in", ...input });
const recommend = (w, pet) => w.advisor.recommendGroomingPackage(w.db, { cityId: "blr", ...pet });

// ---------------------------------------------------------------------------
// 1. Nothing configured means no recommendation, never a guess.
// ---------------------------------------------------------------------------
test("with no rules configured the bot recommends nothing and hands the call to a human", async () => {
  const w = await world();
  await sixPackages(w);
  const result = await recommend(w, { species: "dog", breed: "Labrador", coatType: "short", ageMonths: 36 });
  assert.equal(result.recommended, null);
  assert.equal(result.reason, "rules_not_configured");
  assert.equal(result.handToHuman, true);
  // The real catalogue is still reported, so a human has something true to work from.
  assert.equal(result.alternatives.length, 6);
});

test("a pet nobody could describe does not match a rule that constrains that attribute", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "long_coat_dogs", species: "dog", coatType: "long", packageCode: "grm_full_groom", priority: 10 });
  // Coat was never established on the call. A long-coat rule must not win by default.
  const noCoat = await recommend(w, { species: "dog", breed: "Shih Tzu" });
  assert.equal(noCoat.recommended, null);
  assert.equal(noCoat.reason, "no_rule_matched");
  assert.equal(noCoat.handToHuman, true);
  // Nor may a rule for dogs win for a caller whose pet species was never captured.
  const noSpecies = await recommend(w, { coatType: "long" });
  assert.equal(noSpecies.reason, "pet_details_incomplete");
});

// ---------------------------------------------------------------------------
// 2. A match quotes the catalogue's own package and price.
// ---------------------------------------------------------------------------
test("a matched rule quotes the live catalogue package and its real price", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "long_coat_dogs", species: "dog", coatType: "long", packageCode: "grm_full_groom", priority: 10 });
  const result = await recommend(w, { species: "dog", breed: "Shih Tzu", coatType: "long", ageMonths: 30 });
  assert.equal(result.handToHuman, false);
  assert.equal(result.matchedRule, "long_coat_dogs");
  assert.equal(result.recommended.packageCode, "grm_full_groom");
  assert.equal(result.recommended.name, "Full Groom");
  assert.equal(result.recommended.price, 1499, "the price comes from the catalogue, not from the rule");
  assert.equal(result.recommended.currency, "INR");
});

test("a price change in the catalogue changes what the bot quotes, with no rule edit", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "cats", species: "cat", packageCode: "grm_cat_groom", priority: 10 });
  const before = await recommend(w, { species: "cat", ageMonths: 24 });
  assert.equal(before.recommended.price, 1299);

  const row = w.sqlite.prepare("SELECT id FROM catalogue_packages WHERE package_code=?").get("grm_cat_groom");
  await w.catalogue.updateCataloguePackage(w.db, { id: row.id, changes: { base_price: 1399 }, reason: "annual revision", actorId: "ops@pawspace.in" });
  const after = await recommend(w, { species: "cat", ageMonths: 24 });
  assert.equal(after.recommended.price, 1399, "the bot follows the catalogue automatically");
});

// ---------------------------------------------------------------------------
// 3. Ordering: explicit priority first, then how much a rule actually pins down.
// ---------------------------------------------------------------------------
test("explicit priority decides between two matching rules", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "all_dogs", species: "dog", packageCode: "grm_basic_bath", priority: 50 });
  await rule(w, { ruleCode: "puppies", species: "dog", maxAgeMonths: 6, packageCode: "grm_puppy_intro", priority: 10 });
  const puppy = await recommend(w, { species: "dog", breed: "Beagle", ageMonths: 4 });
  assert.equal(puppy.matchedRule, "puppies");
  assert.equal(puppy.recommended.packageCode, "grm_puppy_intro");
  const adult = await recommend(w, { species: "dog", breed: "Beagle", ageMonths: 48 });
  assert.equal(adult.matchedRule, "all_dogs", "the puppy rule's age band excludes an adult");
});

test("at equal priority the more specific rule wins", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "a_all_dogs", species: "dog", packageCode: "grm_basic_bath", priority: 20 });
  await rule(w, { ruleCode: "b_double_coat", species: "dog", coatType: "double", packageCode: "grm_deshed", priority: 20 });
  const result = await recommend(w, { species: "dog", breed: "Husky", coatType: "double", ageMonths: 36 });
  assert.equal(result.matchedRule, "b_double_coat", "a coat-specific rule beats an any-coat rule at the same priority");
  assert.equal(result.recommended.packageCode, "grm_deshed");
});

test("a breed pattern matches any of its alternatives, case-insensitively", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "spa_breeds", species: "dog", breedPattern: "poodle|bichon|maltese", packageCode: "grm_premium_spa", priority: 5 });
  await rule(w, { ruleCode: "all_dogs", species: "dog", packageCode: "grm_basic_bath", priority: 50 });
  assert.equal((await recommend(w, { species: "dog", breed: "Standard POODLE", ageMonths: 24 })).recommended.packageCode, "grm_premium_spa");
  assert.equal((await recommend(w, { species: "dog", breed: "Maltese", ageMonths: 24 })).recommended.packageCode, "grm_premium_spa");
  assert.equal((await recommend(w, { species: "dog", breed: "Labrador", ageMonths: 24 })).recommended.packageCode, "grm_basic_bath");
});

test("age given in years is accepted as well as months", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "puppies", species: "dog", maxAgeMonths: 6, packageCode: "grm_puppy_intro", priority: 10 });
  await rule(w, { ruleCode: "all_dogs", species: "dog", packageCode: "grm_basic_bath", priority: 50 });
  assert.equal((await recommend(w, { species: "dog", ageYears: 0.4 })).recommended.packageCode, "grm_puppy_intro");
  assert.equal((await recommend(w, { species: "dog", ageYears: 3 })).recommended.packageCode, "grm_basic_bath");
});

// ---------------------------------------------------------------------------
// 4. A stale rule never becomes a stale quote.
// ---------------------------------------------------------------------------
test("a rule pointing at a withdrawn package is skipped in favour of the next valid match", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "a_withdrawn", species: "dog", packageCode: "grm_discontinued_2024", priority: 5 });
  await rule(w, { ruleCode: "b_current", species: "dog", packageCode: "grm_basic_bath", priority: 20 });
  const result = await recommend(w, { species: "dog", breed: "Indie", ageMonths: 24 });
  assert.equal(result.recommended.packageCode, "grm_basic_bath", "one stale rule must not silence a correct one behind it");
  assert.equal(result.matchedRule, "b_current");
});

test("when every matching rule is stale the bot says so instead of quoting a withdrawn package", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "withdrawn", species: "dog", packageCode: "grm_discontinued_2024", priority: 5 });
  const result = await recommend(w, { species: "dog", breed: "Indie", ageMonths: 24 });
  assert.equal(result.recommended, null);
  assert.equal(result.reason, "matched_package_not_in_catalogue");
  assert.equal(result.handToHuman, true);
});

test("a deactivated rule stops being used", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "cats", species: "cat", packageCode: "grm_cat_groom", priority: 10 });
  assert.equal((await recommend(w, { species: "cat", ageMonths: 24 })).recommended.packageCode, "grm_cat_groom");
  await rule(w, { ruleCode: "cats", species: "cat", packageCode: "grm_cat_groom", priority: 10, active: false });
  assert.equal((await recommend(w, { species: "cat", ageMonths: 24 })).reason, "rules_not_configured");
});

// ---------------------------------------------------------------------------
// 5. Rule writes are validated and audited.
// ---------------------------------------------------------------------------
test("a rule with an inverted age band is refused, and every write is audited", async () => {
  const w = await world();
  await assert.rejects(() => rule(w, { ruleCode: "bad_band", species: "dog", minAgeMonths: 24, maxAgeMonths: 6, packageCode: "grm_basic_bath" }), /minimum age cannot exceed/);
  await assert.rejects(() => rule(w, { ruleCode: "", packageCode: "grm_basic_bath" }), /rule code and a package code/);
  await rule(w, { ruleCode: "ok_rule", species: "dog", packageCode: "grm_basic_bath" });
  await rule(w, { ruleCode: "ok_rule", species: "dog", packageCode: "grm_full_groom" });
  const audit = w.sqlite.prepare("SELECT COUNT(*) c FROM grooming_package_rule_audit WHERE rule_code=?").get("ok_rule");
  assert.equal(Number(audit.c), 2, "an edit to what a customer is offered leaves a trail");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM grooming_package_rules").get().c), 1, "an upsert replaces rather than duplicates");
});

test("an unrecognised coat or size is stored as 'any' rather than as an unmatchable value", async () => {
  const w = await world();
  const stored = await rule(w, { ruleCode: "loose", species: "dog", coatType: "fluffy-ish", sizeClass: "enormous", packageCode: "grm_basic_bath" });
  assert.equal(stored.coatType, "any");
  assert.equal(stored.sizeClass, "any");
});

// ---------------------------------------------------------------------------
// 6. The briefing replaces the written document, and reports its own drift.
// ---------------------------------------------------------------------------
test("the briefing is generated from the live catalogue and reports both directions of drift", async () => {
  const w = await world();
  await sixPackages(w);
  await rule(w, { ruleCode: "cats", species: "cat", packageCode: "grm_cat_groom", priority: 10 });
  await rule(w, { ruleCode: "withdrawn", species: "dog", packageCode: "grm_discontinued_2024", priority: 20 });

  const briefing = await w.advisor.groomingPackageBriefing(w.db, { cityId: "blr" });
  assert.equal(briefing.packageCount, 6, "all six packages are described");
  assert.equal(briefing.ready, false);
  assert.deepEqual(briefing.rulesPointingAtMissingPackages, ["grm_discontinued_2024"]);
  assert.ok(briefing.packagesWithoutRules.includes("grm_basic_bath"), "a package no rule can reach is named");
  const cat = briefing.packages.find(p => p.packageCode === "grm_cat_groom");
  assert.equal(cat.price, 1299);
  assert.equal(cat.recommendedFor.length, 1);
  assert.equal(cat.recommendedFor[0].ruleCode, "cats");
});

test("the briefing is ready only when every rule points at a package that is still sold", async () => {
  const w = await world();
  await sixPackages(w);
  for (const [ruleCode, packageCode] of [["r1", "grm_basic_bath"], ["r2", "grm_full_groom"], ["r3", "grm_deshed"], ["r4", "grm_puppy_intro"], ["r5", "grm_cat_groom"], ["r6", "grm_premium_spa"]]) {
    await rule(w, { ruleCode, species: "dog", packageCode });
  }
  const briefing = await w.advisor.groomingPackageBriefing(w.db, { cityId: "blr" });
  assert.equal(briefing.ready, true);
  assert.deepEqual(briefing.packagesWithoutRules, []);
  assert.deepEqual(briefing.rulesPointingAtMissingPackages, []);
});

test("a city-specific package is still offered when no city is supplied", async () => {
  const w = await world();
  await sixPackages(w);
  // With no city given the whole active catalogue must be read - filtering to the global 'ALL' rows
  // would have hidden every city-priced package, which is all six of these.
  const briefing = await w.advisor.groomingPackageBriefing(w.db, {});
  assert.equal(briefing.packageCount, 6);
  assert.equal(briefing.cityId, "ALL");
});
