import assert from "node:assert/strict";
import test from "node:test";

import { evaluateContactEligibility } from "../lib/services/contact-safety-gate.ts";
import { classifyWinbackLifecycle } from "../lib/policies/winback-lifecycle.ts";
import { calculateQueuePriority } from "../lib/types/sales-work-queue.ts";
import { recommendNextBestServices } from "../lib/services/pet-next-best-service.ts";

test("contact safety gate suppresses marketing opt-outs, complaints and quiet hours", () => {
  assert.equal(
    evaluateContactEligibility({ marketingOptOut: true, openComplaint: false }).decision,
    "Suppressed",
  );
  assert.equal(
    evaluateContactEligibility({ marketingOptOut: false, openComplaint: true }).decision,
    "Suppressed",
  );
  const quiet = evaluateContactEligibility({
    marketingOptOut: false,
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
      marketingOptOut: false,
      openComplaint: false,
      quietHours: { timezone: "Not/AZone", startMinute: 0, endMinute: 60 },
    }).decision,
    "Review Required",
  );
});

test("grooming lifecycle uses the directed V2 15/30/45 day thresholds", () => {
  assert.equal(classifyWinbackLifecycle("grooming", 14), "active");
  assert.equal(classifyWinbackLifecycle("grooming", 15), "repeat_due");
  assert.equal(classifyWinbackLifecycle("grooming", 30), "at_risk");
  assert.equal(classifyWinbackLifecycle("grooming", 45), "win_back");
});

test("unapproved service lifecycle thresholds remain configuration-required", () => {
  assert.equal(classifyWinbackLifecycle("dog_training", 90), null);
});

test("unified work queue scoring is policy-weighted and safety-gated", () => {
  const factors = {
    urgency: 1,
    conversionConfidence: 0,
    expectedRevenue: 0,
    expectedContribution: 0,
    customerValue: 0,
    lifecycleRisk: 0,
    capacityAvailability: 0,
    workAge: 0,
    managerEscalation: 0,
  };
  const weights = {
    urgency: 1,
    conversionConfidence: 0,
    expectedRevenue: 0,
    expectedContribution: 0,
    customerValue: 0,
    lifecycleRisk: 0,
    capacityAvailability: 0,
    workAge: 0,
    managerEscalation: 0,
  };
  assert.equal(calculateQueuePriority({ factors, weights, safetyDecision: "Allowed" }), 100);
  assert.equal(
    calculateQueuePriority({ factors: { ...factors, urgency: 0.5 }, weights, safetyDecision: "Allowed" }),
    50,
  );
  assert.equal(calculateQueuePriority({ factors, weights, safetyDecision: "Suppressed" }), 0);
});

test("young trained dog gets explainable Grooming cross-sell candidate", () => {
  const recommendations = recommendNextBestServices({
    pet: {
      petId: "PET-1",
      customerId: "CUS-1",
      species: "dog",
      breed: "Labrador Retriever",
      ageMonths: 12,
    },
    serviceHistory: [{ serviceCode: "dog_training", status: "completed", completedAt: 1 }],
  });
  assert.deepEqual(recommendations.map((item) => item.targetServiceCode), ["grooming"]);
  assert.deepEqual(recommendations[0].reasonCodes, [
    "training_completed",
    "young_dog",
    "grooming_service_gap",
  ]);
  assert.equal(recommendations[0].canonicalOpportunity.valueStatus, "configuration_required");
});

test("Grooming customer with travel intent gets Boarding, Sitting and Taxi candidates", () => {
  const recommendations = recommendNextBestServices({
    pet: {
      petId: "PET-TRAVEL-1",
      customerId: "CUS-TRAVEL-1",
      species: "dog",
      breed: "Golden Retriever",
      ageMonths: 36,
    },
    serviceHistory: [{ serviceCode: "grooming", status: "completed", completedAt: 1 }],
    travelIntent: true,
  });
  assert.deepEqual(
    recommendations.map((item) => item.targetServiceCode),
    ["boarding", "pet_sitting", "pet_taxi"],
  );
});

test("Boarding customer with no Grooming history gets pre-stay Grooming candidate", () => {
  const recommendations = recommendNextBestServices({
    pet: {
      petId: "PET-BOARD-1",
      customerId: "CUS-BOARD-1",
      species: "dog",
      breed: null,
      ageMonths: 48,
    },
    serviceHistory: [{ serviceCode: "boarding", status: "completed" }],
  });
  assert.deepEqual(recommendations.map((item) => item.targetServiceCode), ["grooming"]);
});

test("existing canonical cross-sell opportunity prevents duplicate target recommendation", () => {
  const recommendations = recommendNextBestServices({
    pet: {
      petId: "PET-2",
      customerId: "CUS-2",
      species: "dog",
      breed: null,
      ageMonths: 10,
    },
    serviceHistory: [{ serviceCode: "training", status: "completed" }],
    existingOpportunities: [
      { id: "OPP-1", opportunityType: "cross_sell", serviceCode: "grooming", status: "ready" },
    ],
  });
  assert.deepEqual(recommendations, []);
});
