import assert from "node:assert/strict";
import test from "node:test";

import { evaluateContactEligibility } from "../lib/services/contact-safety-gate.ts";
import { classifyWinbackLifecycle } from "../lib/policies/winback-lifecycle.ts";
import { calculateQueuePriority } from "../lib/types/sales-work-queue.ts";
import { recommendNextBestServices } from "../lib/services/pet-next-best-service.ts";

test("contact safety gate fails closed for opt-outs, complaints and quiet hours", () => {
  assert.equal(evaluateContactEligibility({ optedOut: true, openComplaint: false }).decision, "Suppressed");
  assert.equal(evaluateContactEligibility({ optedOut: false, openComplaint: true }).decision, "Suppressed");
  const quiet = evaluateContactEligibility({
    optedOut: false,
    openComplaint: false,
    evaluatedAt: new Date("2026-09-04T00:00:00.000Z"),
    quietHours: { timezone: "Asia/Kolkata", startMinute: 21 * 60, endMinute: 9 * 60 },
  });
  assert.equal(quiet.decision, "Suppressed");
  assert.deepEqual(quiet.reasons, ["quiet_hours"]);
});

test("contact safety gate requires review for invalid quiet-hours configuration", () => {
  assert.equal(
    evaluateContactEligibility({
      optedOut: false,
      openComplaint: false,
      quietHours: { timezone: "Not/AZone", startMinute: 0, endMinute: 60 },
    }).decision,
    "Review Required",
  );
});

test("grooming lifecycle uses V2 15/30/45 day thresholds", () => {
  assert.equal(classifyWinbackLifecycle("grooming", 14), "active");
  assert.equal(classifyWinbackLifecycle("grooming", 15), "repeat_due");
  assert.equal(classifyWinbackLifecycle("grooming", 30), "at_risk");
  assert.equal(classifyWinbackLifecycle("grooming", 45), "win_back");
});

test("unified work queue priority is multiplicative and normalized", () => {
  assert.equal(calculateQueuePriority(1, 1, 1, 1, 1), 100);
  assert.equal(calculateQueuePriority(1, 0.5, 1, 1, 1), 50);
  assert.equal(calculateQueuePriority(2, 1, 1, 1, 1), 100);
});

test("young trained dog gets explainable walking and boarding cross-sell candidates", () => {
  const recommendations = recommendNextBestServices({
    pet: {
      petId: "PET-1",
      customerId: "CUS-1",
      species: "dog",
      breed: "Labrador Retriever",
      ageMonths: 12,
      vaccinationStatus: "current",
    },
    serviceHistory: [{ serviceCode: "dog_training", status: "completed", completedAt: 1 }],
  });
  assert.deepEqual(
    recommendations.map((item) => item.targetServiceCode),
    ["dog_walking", "boarding"],
  );
  assert.equal(recommendations[0].canonicalOpportunity.opportunityType, "cross_sell");
  assert.equal(recommendations[0].canonicalOpportunity.valueStatus, "configuration_required");
});

test("repeat grooming customer with travel intent gets boarding recommendation", () => {
  const recommendations = recommendNextBestServices({
    pet: {
      petId: "PET-TRAVEL-1",
      customerId: "CUS-TRAVEL-1",
      species: "dog",
      breed: "Golden Retriever",
      ageMonths: 36,
      vaccinationStatus: "current",
    },
    serviceHistory: [
      { serviceCode: "grooming", status: "completed", completedAt: 1 },
      { serviceCode: "grooming", status: "completed", completedAt: 2 },
    ],
    travelIntent: true,
  });

  assert.deepEqual(recommendations.map((item) => item.targetServiceCode), ["boarding"]);
  assert.deepEqual(recommendations[0].reasonCodes, [
    "repeat_grooming_customer",
    "travel_intent",
    "boarding_service_gap",
  ]);
  assert.equal(recommendations[0].sourceFeatures.travelIntent, true);
});

test("existing canonical cross-sell opportunity prevents duplicate target recommendation", () => {
  const recommendations = recommendNextBestServices({
    pet: {
      petId: "PET-2",
      customerId: "CUS-2",
      species: "dog",
      breed: null,
      ageMonths: 10,
      vaccinationStatus: "current",
    },
    serviceHistory: [{ serviceCode: "dog_training", status: "completed" }],
    existingOpportunities: [
      { id: "OPP-1", opportunityType: "cross_sell", serviceCode: "dog_walking", status: "ready" },
    ],
  });
  assert.deepEqual(recommendations.map((item) => item.targetServiceCode), ["boarding"]);
});
