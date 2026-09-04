export type GrowthServiceCode = "grooming" | "training" | "walking" | "boarding" | "sitting" | "taxi";

export interface PetProfile {
  petId: string;
  species: string;
  breed?: string | null;
  ageMonths?: number | null;
  size?: string | null;
  serviceSafetyEligibility?: Partial<Record<GrowthServiceCode, boolean>>;
}

export interface ServiceHistoryFact {
  serviceCode: GrowthServiceCode;
  completedCount: number;
  lastCompletedAt?: number | null;
  futureBookingAt?: number | null;
}

export interface ServiceEconomics {
  expectedRevenue: number;
  contributionMarginPct?: number | null;
}

export interface PetNextBestServiceInput {
  pet: PetProfile;
  serviceHistory: ServiceHistoryFact[];
  statedIntent?: GrowthServiceCode[];
  activeEntitlements?: Partial<Record<GrowthServiceCode, number>>;
  economics?: Partial<Record<GrowthServiceCode, ServiceEconomics>>;
  hasOpenComplaint?: boolean;
  hasUnresolvedRefund?: boolean;
  policyVersion?: string;
}

export interface PetNextBestServiceRecommendation {
  targetService: GrowthServiceCode;
  reasonCodes: string[];
  explanation: string;
  confidence: number;
  expectedRevenue: number;
  expectedContribution: number | null;
  policyVersion: string;
}

const POLICY_VERSION = "v2-next-best-service-foundation-1";

function historyFor(input: PetNextBestServiceInput, serviceCode: GrowthServiceCode) {
  return input.serviceHistory.find((fact) => fact.serviceCode === serviceCode);
}

function hasUsed(input: PetNextBestServiceInput, serviceCode: GrowthServiceCode) {
  return (historyFor(input, serviceCode)?.completedCount ?? 0) > 0;
}

function isSafe(input: PetNextBestServiceInput, serviceCode: GrowthServiceCode) {
  return input.pet.serviceSafetyEligibility?.[serviceCode] !== false;
}

function economicsFor(input: PetNextBestServiceInput, serviceCode: GrowthServiceCode) {
  const economics = input.economics?.[serviceCode];
  const expectedRevenue = Math.max(0, economics?.expectedRevenue ?? 0);
  const margin = economics?.contributionMarginPct;
  const expectedContribution = margin == null
    ? null
    : Math.round(expectedRevenue * Math.max(0, Math.min(1, margin)) * 100) / 100;
  return { expectedRevenue, expectedContribution };
}

function recommendation(
  input: PetNextBestServiceInput,
  targetService: GrowthServiceCode,
  reasonCodes: string[],
  explanation: string,
  confidence: number,
): PetNextBestServiceRecommendation {
  const economics = economicsFor(input, targetService);
  return {
    targetService,
    reasonCodes,
    explanation,
    confidence: Math.max(0, Math.min(1, confidence)),
    ...economics,
    policyVersion: input.policyVersion?.trim() || POLICY_VERSION,
  };
}

export function evaluatePetNextBestService(
  input: PetNextBestServiceInput,
): PetNextBestServiceRecommendation[] {
  if (input.hasOpenComplaint || input.hasUnresolvedRefund) return [];

  const recommendations: PetNextBestServiceRecommendation[] = [];
  const intent = new Set(input.statedIntent ?? []);
  const youngDog = input.pet.species.toLowerCase() === "dog"
    && input.pet.ageMonths != null
    && input.pet.ageMonths <= 24;

  if (youngDog && hasUsed(input, "training") && !hasUsed(input, "grooming") && isSafe(input, "grooming")) {
    recommendations.push(recommendation(
      input,
      "grooming",
      ["young_dog", "training_history", "no_grooming_history"],
      "Young dog with completed Training history and no completed Grooming service.",
      0.82,
    ));
  }

  if (hasUsed(input, "grooming")) {
    for (const target of ["boarding", "sitting", "taxi"] as const) {
      if (intent.has(target) && !hasUsed(input, target) && isSafe(input, target)) {
        recommendations.push(recommendation(
          input,
          target,
          ["grooming_history", `${target}_intent`, `no_${target}_history`],
          `Completed Grooming history plus stated ${target} intent with no completed ${target} service.`,
          0.88,
        ));
      }
    }
  }

  if (hasUsed(input, "boarding") && !hasUsed(input, "grooming") && isSafe(input, "grooming")) {
    recommendations.push(recommendation(
      input,
      "grooming",
      ["boarding_history", "no_grooming_history", "pre_stay_grooming_candidate"],
      "Completed Boarding history and no completed Grooming service indicate a pre-stay Grooming candidate.",
      0.74,
    ));
  }

  return recommendations
    .filter((item) => (input.activeEntitlements?.[item.targetService] ?? 0) <= 0)
    .sort((a, b) => b.confidence - a.confidence || b.expectedRevenue - a.expectedRevenue);
}
