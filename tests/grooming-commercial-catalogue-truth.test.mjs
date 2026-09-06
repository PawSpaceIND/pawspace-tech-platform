import test from "node:test";
import assert from "node:assert/strict";
import {
  freshGroomingWorld,
  groomingCatalogue,
  groomingCommercialPackages,
  groomingCommercialAddOns,
  groomingCommercialPromotions,
  groomingSubscriptionCommercialTruth,
  governGroomingBooking,
  resolveGroomingSubscriptionPlan,
} from "./helpers/grooming-harness.mjs";

const packageTruth = [
  ["dog-bath", 1349, 1149, 2298],
  ["dog-basic", 1899, 1649, 3298],
  ["dog-makeover", 2399, 2149, 4298],
  ["cat-routine", 1149, 999, 1998],
  ["cat-basic", 1899, 1649, 3298],
  ["cat-makeover", 2399, 2149, 4298],
];

test("Grooming commercial catalogue executes approved single and two-pet pricing", async () => {
  for (const [code, single, multiUnit, twoPet] of packageTruth) {
    const governed = groomingCatalogue.find((item) => item.code === code);
    const creative = groomingCommercialPackages.find((item) => item.code === code);
    assert.ok(governed && creative, `${code} must exist in both governed and customer catalogue truth`);
    assert.equal(governed.singlePrice, single);
    assert.equal(governed.multiPetPrice, multiUnit);
    assert.equal(creative.price, single);
    assert.equal(creative.twoPetPrice, twoPet);
    assert.equal(multiUnit * 2, twoPet);

    const world = freshGroomingWorld();
    const species = code.startsWith("cat-") ? "cat" : "dog";
    const result = await governGroomingBooking(world.db, {
      packageCode: code,
      pets: [{ species }, { species }],
      submittedTotal: twoPet,
      submittedAmountDueNow: 0,
      paymentMode: "pay_after_service",
      cityId: "blr",
      zoneId: "blr-east",
    });
    assert.equal(result.totalAmount, twoPet, `${code} two-pet total comes from the server catalogue`);
  }
});

test("Grooming price and eligibility sabotage fail closed at runtime", async () => {
  const world = freshGroomingWorld();
  await assert.rejects(() => governGroomingBooking(world.db, {
    packageCode: "dog-basic",
    pets: [{ species: "dog" }],
    submittedTotal: 1,
    submittedAmountDueNow: 0,
    paymentMode: "pay_after_service",
    cityId: "blr",
    zoneId: "blr-east",
  }), /Submitted Grooming total does not match governed catalogue/);

  await assert.rejects(() => governGroomingBooking(world.db, {
    packageCode: "dog-basic",
    pets: [{ species: "cat" }],
    submittedTotal: 1899,
    submittedAmountDueNow: 0,
    paymentMode: "pay_after_service",
    cityId: "blr",
    zoneId: "blr-east",
  }), /not eligible for cat/);

  const phantom = await governGroomingBooking(world.db, {
    packageCode: "dog-basic",
    pets: [{ species: "dog" }],
    submittedTotal: 1899,
    submittedAmountDueNow: 0,
    paymentMode: "pay_after_service",
    cityId: "blr",
    zoneId: "blr-east",
  });
  assert.equal(phantom.totalAmount, 1899, "a valid server quote still executes after sabotage attempts");
});

test("Puppy, kitten, trim and add-on commercial truth is executable data", () => {
  assert.equal(groomingCatalogue.find((item) => item.code === "young-basic")?.singlePrice, 999);
  assert.equal(groomingCatalogue.find((item) => item.code === "young-makeover")?.singlePrice, 1399);
  assert.equal(groomingCatalogue.find((item) => item.code === "dog-trim")?.singlePrice, 1599);
  assert.equal(groomingCatalogue.find((item) => item.code === "cat-trim")?.singlePrice, 1599);

  const tick = groomingCommercialAddOns.find((item) => item.code === "tick-flea-treatment");
  const oil = groomingCommercialAddOns.find((item) => item.code === "full-body-oil-massage");
  assert.deepEqual({ price: tick?.price, pets: tick?.eligiblePetTypes }, { price: 499, pets: ["dog", "cat"] });
  assert.deepEqual({ price: oil?.price, pets: oil?.eligiblePetTypes }, { price: 299, pets: ["dog", "cat"] });
  assert.equal(groomingCatalogue.some((item) => item.code === "tick-flea-treatment"), false, "add-ons cannot silently become base packages");
});

test("Creative discounts stay fail-closed until an operator-controlled activation path exists", () => {
  for (const promotion of groomingCommercialPromotions) {
    assert.equal(promotion.activeByDefault, false);
    assert.equal(promotion.activation, "operator_controlled");
    const base = groomingCommercialPackages.find((item) => item.code === promotion.packageCode);
    assert.equal(base?.price, promotion.regularPrice, `${promotion.packageCode} booking default remains regular price`);
    assert.ok(promotion.offerPrice < promotion.regularPrice);
  }
});

test("Grooming subscription truth resolves from real D1 configuration", async () => {
  const world = freshGroomingWorld();
  const semiannual = await resolveGroomingSubscriptionPlan(world.db, "sub-6", "blr", "blr-east");
  const annual = await resolveGroomingSubscriptionPlan(world.db, "sub-12", "blr", "blr-east");
  assert.deepEqual(
    { sessions: semiannual?.sessions, price: semiannual?.singlePrice, validity: semiannual?.validityValue },
    { sessions: 6, price: 6594, validity: 6 },
  );
  assert.deepEqual(
    { sessions: annual?.sessions, price: annual?.singlePrice, validity: annual?.validityValue },
    { sessions: 12, price: 11988, validity: 12 },
  );
  assert.equal(groomingSubscriptionCommercialTruth.semiannual.perSession, 1099);
  assert.equal(groomingSubscriptionCommercialTruth.annual.perSession, 999);
});
