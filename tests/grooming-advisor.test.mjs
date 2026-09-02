import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROOMING_ADVISOR_RULES,
  STANDARD_GROOMING_PACKAGES,
  groomingAdvisoryForHaptik,
  groomingAdvisorInputFromHaptik,
  recommendGroomingPackage,
} from "../lib/grooming-advisor.ts";

test("grooming advisor exposes exactly the six standard LOE packages", () => {
  assert.equal(STANDARD_GROOMING_PACKAGES.length, 6);
  assert.deepEqual(
    STANDARD_GROOMING_PACKAGES.map(pkg => `${pkg.petType}:${pkg.tier}:${pkg.packageCode}`),
    [
      "dog:essential:dog-bath",
      "dog:basic:dog-basic",
      "dog:complete:dog-makeover",
      "cat:essential:cat-routine",
      "cat:basic:cat-basic",
      "cat:complete:cat-makeover",
    ],
  );
  assert.ok(GROOMING_ADVISOR_RULES.length >= 7);
});

test("short-coated standard pets map to the species entry package", () => {
  assert.equal(recommendGroomingPackage({ petType: "dog", breedSize: "small", coatCondition: "short", ageRequirement: "adult" }).packageCode, "dog-bath");
  assert.equal(recommendGroomingPackage({ petType: "cat", breedSize: "medium", coatCondition: "short", ageRequirement: "adult" }).packageCode, "cat-routine");
});

test("double coats and size escalate deterministically", () => {
  const medium = recommendGroomingPackage({ petType: "dog", breedSize: "medium", coatCondition: "double", ageRequirement: "adult" });
  assert.equal(medium.packageCode, "dog-basic");
  assert.deepEqual(medium.matchedRuleIds, ["double-coat-basic"]);

  const large = recommendGroomingPackage({ petType: "dog", breedSize: "large", coatCondition: "double", ageRequirement: "adult" });
  assert.equal(large.packageCode, "dog-makeover");
  assert.deepEqual(large.matchedRuleIds, ["large-double-coat-complete", "double-coat-basic"]);

  const giantShort = recommendGroomingPackage({ petType: "cat", breedSize: "giant", coatCondition: "short", ageRequirement: "adult" });
  assert.equal(giantShort.packageCode, "cat-basic");
});

test("matted coat always reaches Complete Makeover", () => {
  for (const petType of ["dog", "cat"]) {
    const result = recommendGroomingPackage({ petType, breedSize: "small", coatCondition: "matted", ageRequirement: "young" });
    assert.equal(result.packageName, "Complete Makeover");
    assert.equal(result.tier, "complete");
    assert.ok(result.advisories.includes("coat:matted"));
    assert.ok(result.advisories.some(note => note.startsWith("young_pet:")));
  }
});

test("senior and handling-sensitive requirements raise a short coat to Basic", () => {
  const senior = recommendGroomingPackage({ petType: "dog", breedSize: "small", coatCondition: "short", ageRequirement: "senior" });
  assert.equal(senior.packageCode, "dog-basic");
  assert.ok(senior.matchedRuleIds.includes("senior-support-basic"));

  const anxious = recommendGroomingPackage({ petType: "cat", breedSize: "small", coatCondition: "short", ageRequirement: "adult", behaviorRequirement: "anxious" });
  assert.equal(anxious.packageCode, "cat-basic");
  assert.ok(anxious.matchedRuleIds.includes("handling-support-basic"));
});

test("reactive handling raises to Complete and requires a human review", () => {
  const result = recommendGroomingPackage({
    petType: "dog",
    breedSize: "small",
    coatCondition: "short",
    ageRequirement: "adult",
    behaviorRequirement: "reactive",
  });
  assert.equal(result.packageCode, "dog-makeover");
  assert.equal(result.requiresHumanReview, true);
  assert.ok(result.matchedRuleIds.includes("reactive-handling-complete"));
});

test("requested tier can raise but never downgrade a stronger coat requirement", () => {
  assert.equal(
    recommendGroomingPackage({ petType: "cat", breedSize: "small", coatCondition: "short", ageRequirement: "adult", requestedTier: "complete" }).packageCode,
    "cat-makeover",
  );
  assert.equal(
    recommendGroomingPackage({ petType: "dog", breedSize: "small", coatCondition: "matted", ageRequirement: "adult", requestedTier: "essential" }).packageCode,
    "dog-makeover",
  );
});

test("Haptik helper accepts snake_case payloads and returns a compact governed response", () => {
  const input = groomingAdvisorInputFromHaptik({
    pet_type: "cat",
    breed_size: "large",
    coat_condition: "double",
    age_requirement: "adult",
    behavior_requirement: "standard",
  });
  assert.equal(input.petType, "cat");
  const response = groomingAdvisoryForHaptik({
    pet_type: "cat",
    breed_size: "large",
    coat_condition: "double",
    age_requirement: "adult",
  });
  assert.equal(response.action, "grooming_package_advice");
  assert.equal(response.package_code, "cat-makeover");
  assert.equal(response.requires_human_review, false);
});

test("Haptik helper fails clearly on unsupported enum values", () => {
  assert.throws(
    () => groomingAdvisorInputFromHaptik({ pet_type: "rabbit", breed_size: "small", coat_condition: "short", age_requirement: "adult" }),
    /petType: dog \| cat/,
  );
  assert.throws(
    () => groomingAdvisorInputFromHaptik({ pet_type: "dog", breed_size: "tiny", coat_condition: "short", age_requirement: "adult" }),
    /breedSize: small \| medium \| large \| giant/,
  );
});
