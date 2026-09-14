import test from "node:test";
import assert from "node:assert/strict";
import {
  freshGroomingWorld,
  GROOMING_COMMERCIAL_TRUTH_VERSION,
  groomingCatalogue,
  groomingCommercialPackages,
  groomingCommercialAddOns,
  groomingCommercialPromotions,
  groomingSubscriptionCommercialTruth,
  governGroomingBooking,
  resolveGroomingSubscriptionPlan,
} from "./helpers/grooming-harness.mjs";

// Imported directly as well as through the harness: the household quote and the customer-facing
// catalogue module are exercised below as executable pricing, not only as re-exported constants.
const { calculateGroomingHouseholdQuote } = await import("../lib/grooming-governance.ts");
const commercialTruth = await import("../lib/grooming-commercial-catalogue.ts");

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

test("Household quote executes multi-pet pricing and the GST breakdown for a mixed household", () => {
  const quote = calculateGroomingHouseholdQuote({ lines: [{ packageCode: "dog-basic", petType: "dog" }, { packageCode: "cat-basic", petType: "cat" }] });
  assert.deepEqual(
    { base: quote.baseAmount, subtotal: quote.subtotal, discount: quote.multiPetDiscount, total: quote.totalAmount, mode: quote.taxMode, rate: quote.taxRate },
    { base: 3798, subtotal: 3298, discount: 500, total: 3298, mode: "inclusive", rate: 18 },
    "two pets pay the multi-pet unit price each, GST inclusive",
  );
  assert.equal(quote.gstAmount, Math.round((3298 - 3298 / 1.18) * 100) / 100);
  assert.deepEqual(quote.lines.map((line) => line.chargedPrice), [1649, 1649]);

  const single = calculateGroomingHouseholdQuote({ lines: [{ packageCode: "dog-basic", petType: "dog" }], taxMode: "exclusive" });
  assert.deepEqual({ subtotal: single.subtotal, gst: single.gstAmount, total: single.totalAmount }, { subtotal: 1899, gst: 341.82, total: 2240.82 }, "a single pet pays the single price; exclusive GST is added on top");

  assert.throws(() => calculateGroomingHouseholdQuote({ lines: Array.from({ length: 5 }, () => ({ packageCode: "dog-basic", petType: "dog" })) }), /supports 1-4 pets/);
  assert.throws(() => calculateGroomingHouseholdQuote({ lines: [{ packageCode: "dog-basic", petType: "cat" }] }), /not eligible for cat/);
  assert.throws(() => calculateGroomingHouseholdQuote({ lines: [{ packageCode: "sub-6", petType: "dog" }] }), /Active Grooming package not found: sub-6/, "subscriptions are not household lines");
  assert.throws(() => calculateGroomingHouseholdQuote({ lines: [{ packageCode: "dog-basic", petType: "dog" }], taxRate: 41 }), /GST rate must be between 0 and 40/);
});

test("Subscription purchases reserve one credit per pet against the governed plan, and the per-session truth reconciles", async () => {
  const world = freshGroomingWorld();
  const twoPets = await governGroomingBooking(world.db, { packageCode: "sub-6", pets: [{ species: "dog" }, { species: "cat" }], submittedTotal: 6594, submittedAmountDueNow: 6594, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" });
  assert.deepEqual({ reserve: twoPets.subscriptionPlan?.reserveSessions, total: twoPets.totalAmount, petCount: twoPets.petCount }, { reserve: 2, total: 6594, petCount: 2 }, "the wallet price is not multiplied by pet count; credits are");

  await assert.rejects(
    governGroomingBooking(world.db, { packageCode: "sub-6", pets: Array.from({ length: 5 }, () => ({ species: "dog" })), submittedTotal: 6594, submittedAmountDueNow: 6594, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" }),
    /Grooming supports between 1 and 4 pets/,
  );
  await assert.rejects(
    governGroomingBooking(world.db, { packageCode: "sub-6", pets: [{ species: "dog" }], submittedTotal: 6594, submittedAmountDueNow: 0, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" }),
    /Submitted amount due now does not match the governed payment mode/,
    "a prepaid subscription owes its full price now",
  );
  await assert.rejects(
    governGroomingBooking(world.db, { packageCode: "sub-6", pets: [{ species: "dog" }], submittedTotal: 6594, submittedAmountDueNow: 6594, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east", existingSubscriptionId: "SUB-EXISTING" }),
    /cannot also consume an existing subscription/,
  );

  const { semiannual, annual } = commercialTruth.groomingSubscriptionCommercialTruth;
  assert.equal(semiannual.perSession * 6, 6594, "the marketed per-session price is the plan price divided by its sessions");
  assert.equal(annual.perSession * 12, 11988);
  assert.equal(commercialTruth.GROOMING_COMMERCIAL_TRUTH_VERSION, GROOMING_COMMERCIAL_TRUTH_VERSION);
});
