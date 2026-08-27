import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hasAll = (source, needles, label) => {
  for (const needle of needles) assert.match(source, needle, `${label} lost ${needle}`);
};

test("premium customer shell keeps the real signed-in service flows", () => {
  const shell = read("app/mobile-app/page.tsx");
  hasAll(shell, [
    /PremiumDiscoveryHome/,
    /GroomingFlow/,
    /TrainingFlow/,
    /StayFlow/,
    /WalkingFlow/,
    /TaxiFlow/,
    /FoodFlow/,
    /RelocationFlow/,
  ], "mobile shell");
});

test("grooming premium presentation preserves packages, live pricing and canonical booking", () => {
  const source = read("app/mobile-app/grooming-flow.tsx");
  hasAll(source, [
    /Essential Bath/,
    /Bath & Basic/,
    /Complete Makeover/,
    /Just Trim/,
    /Routine Grooming/,
    /groomingPricingPackageCode/,
    /\/api\/live-price-quote/,
    /CouponField/,
    /reserveUatSchedule/,
    /createCanonicalLifecycle/,
    /stableBookingInputKey/,
  ], "Grooming");
  assert.doesNotMatch(source, /customerId\s*:\s*["']TST-101["']/);
});

test("training premium presentation still loads catalogue, quote, trainer and programme governance", () => {
  const source = read("app/mobile-app/training-flow.tsx");
  hasAll(source, [
    /loadTrainingPackages/,
    /loadTrainingTrainers/,
    /quoteTraining/,
    /reserveUatSchedule/,
    /createCanonicalLifecycle/,
    /materializeTrainingProgramme/,
    /training-2-starter/,
    /training-4-puppy/,
    /training-8-basic/,
    /training-16-pro/,
  ], "Training");
  assert.doesNotMatch(source, /customerId\s*:\s*["']TST-101["']/);
});

test("boarding and sitting premium presentation still uses governed quotes, capacity and capture", () => {
  const source = read("app/mobile-app/stay-flow.tsx");
  hasAll(source, [
    /loadBoardingCommercial/,
    /quoteBoarding/,
    /createSittingQuote/,
    /captureSittingQuoteSandbox/,
    /createCanonicalSittingBooking/,
    /reserveUatSchedule/,
    /createCanonicalLifecycle/,
    /vaccinationStatus !== "verified"/,
  ], "Boarding\/Sitting");
  assert.doesNotMatch(source, /customerId\s*:\s*["']TST-101["']/);
});

test("walking and taxi premium presentation still prices from their commercial APIs", () => {
  const walking = read("app/mobile-app/walking-flow.tsx");
  hasAll(walking, [/loadWalkingCatalogue/, /createWalkingQuote/, /reserveWalkingSchedule/, /createCanonicalWalkingBooking/, /resolveServiceCoverage/], "Walking");
  const taxi = read("app/mobile-app/taxi-flow.tsx");
  hasAll(taxi, [/loadTaxiRouteClasses/, /createTaxiQuote/, /reserveTaxiSchedule/, /createCanonicalTaxiBooking/, /resolveServiceCoverage/], "Taxi");
  assert.doesNotMatch(walking, /customerId\s*:\s*["']TST-101["']/);
  assert.doesNotMatch(taxi, /customerId\s*:\s*["']TST-101["']/);
});

test("food premium presentation still uses catalogue quote order and subscription modules", () => {
  const source = read("app/mobile-app/food-flow.tsx");
  hasAll(source, [/loadFoodCatalogue/, /quoteFoodCart/, /placeQuotedFoodOrders/, /createFoodSubscription/, /resolveServiceCoverage/], "Food");
  assert.doesNotMatch(source, /customerId\s*:\s*["']TST-101["']/);
});
