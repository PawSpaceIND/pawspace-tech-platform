export type PetSpecies = "dog" | "cat" | "other";

export interface PetProfileSignal {
  petId: string;
  customerId: string;
  species: PetSpecies;
  breed: string | null;
  ageMonths: number | null;
}

export interface PetServiceHistoryItem {
  serviceCode: string;
  status: "completed" | "cancelled" | "refunded" | "other";
  completedAt?: number | null;
}

export interface ExistingCanonicalOpportunity {
  id: string;
  opportunityType: string;
  serviceCode: string | null;
  status: "ready" | "suppressed" | "review_required" | "converted" | "closed" | string;
}

export interface NextBestServiceInput {
  pet: PetProfileSignal;
  serviceHistory: PetServiceHistoryItem[];
  travelIntent?: boolean;
  existingOpportunities?: ExistingCanonicalOpportunity[];
}

export interface CanonicalCrossSellOpportunitySeed {
  customerId: string;
  opportunityType: "cross_sell";
  serviceCode: string;
  reason: string;
  estimatedValue: 0;
  valueStatus: "configuration_required";
  confidence: number;
  sourceKey: string;
  idempotencyKey: string;
}

export interface NextBestServiceRecommendation {
  petId: string;
  targetServiceCode: string;
  reasonCodes: string[];
  explanation: string;
  confidence: number;
  sourceFeatures: {
    species: PetSpecies;
    breed: string | null;
    ageMonths: number | null;
    completedServices: string[];
    travelIntent: boolean;
  };
  canonicalOpportunity: CanonicalCrossSellOpportunitySeed;
  canonicalContext: {
    normalizedOpportunityType: "cross_sell";
    targetServiceCode: string;
    petId: string;
    reasonCodes: string[];
    expectedContribution: null;
  };
}

interface RuleCandidate {
  serviceCode: string;
  reasonCodes: string[];
  explanation: string;
}

const ACTIVE_OPPORTUNITY_STATES = new Set(["ready", "suppressed", "review_required"]);
const SERVICE_ALIASES: Readonly<Record<string, string>> = {
  training: "dog_training",
  dog_training: "dog_training",
  walking: "dog_walking",
  dog_walking: "dog_walking",
  sitting: "pet_sitting",
  pet_sitting: "pet_sitting",
  taxi: "pet_taxi",
  pet_taxi: "pet_taxi",
  grooming: "grooming",
  boarding: "boarding",
};

function normalizeServiceCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  return SERVICE_ALIASES[normalized] ?? normalized;
}

function completedServices(history: PetServiceHistoryItem[]): Set<string> {
  return new Set(
    history
      .filter((item) => item.status === "completed")
      .map((item) => normalizeServiceCode(item.serviceCode))
      .filter(Boolean),
  );
}

function existingTargetServices(opportunities: ExistingCanonicalOpportunity[]): Set<string> {
  return new Set(
    opportunities
      .filter(
        (opportunity) =>
          opportunity.opportunityType === "cross_sell" &&
          opportunity.serviceCode &&
          ACTIVE_OPPORTUNITY_STATES.has(opportunity.status),
      )
      .map((opportunity) => normalizeServiceCode(opportunity.serviceCode!)),
  );
}

function isYoungDog(pet: PetProfileSignal): boolean {
  return pet.species === "dog" && pet.ageMonths !== null && pet.ageMonths >= 6 && pet.ageMonths <= 24;
}

function ruleCandidates(pet: PetProfileSignal, completed: Set<string>, travelIntent: boolean): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];
  const hasTraining = completed.has("dog_training");
  const hasGrooming = completed.has("grooming");
  const hasBoarding = completed.has("boarding");

  if (hasTraining && isYoungDog(pet) && !hasGrooming) {
    candidates.push({
      serviceCode: "grooming",
      reasonCodes: ["training_completed", "young_dog", "grooming_service_gap"],
      explanation: "Training is complete for a young dog and there is no completed Grooming history.",
    });
  }

  if (hasGrooming && travelIntent) {
    for (const serviceCode of ["boarding", "pet_sitting", "pet_taxi"] as const) {
      if (!completed.has(serviceCode)) {
        candidates.push({
          serviceCode,
          reasonCodes: ["grooming_completed", "travel_intent", `${serviceCode}_service_gap`],
          explanation: `Grooming is established, travel intent is present, and there is no completed ${serviceCode} history.`,
        });
      }
    }
  }

  if (hasBoarding && !hasGrooming) {
    candidates.push({
      serviceCode: "grooming",
      reasonCodes: ["boarding_completed", "grooming_service_gap"],
      explanation: "Boarding has been completed and there is no completed Grooming history.",
    });
  }

  return candidates;
}

function stableSignalKey(petId: string, serviceCode: string): string {
  return `pet-next-best-service:${petId}:${serviceCode}`;
}

/**
 * Produces deterministic, explainable cross-sell seeds from canonical pet/service facts.
 * It does not infer medical suitability and it never bypasses the central contact safety gate.
 */
export function recommendNextBestServices(input: NextBestServiceInput): NextBestServiceRecommendation[] {
  if (!input.pet.petId || !input.pet.customerId) throw new Error("Canonical pet and customer identity are required");
  if (input.pet.ageMonths !== null && (!Number.isFinite(input.pet.ageMonths) || input.pet.ageMonths < 0)) {
    throw new Error("Pet ageMonths must be non-negative when provided");
  }

  const completed = completedServices(input.serviceHistory);
  const existingTargets = existingTargetServices(input.existingOpportunities ?? []);
  const travelIntent = input.travelIntent === true;
  const sourceFeatures = {
    species: input.pet.species,
    breed: input.pet.breed?.trim() || null,
    ageMonths: input.pet.ageMonths,
    completedServices: [...completed].sort(),
    travelIntent,
  };

  return ruleCandidates(input.pet, completed, travelIntent)
    .filter((candidate) => !completed.has(candidate.serviceCode) && !existingTargets.has(candidate.serviceCode))
    .map((candidate) => {
      const sourceKey = stableSignalKey(input.pet.petId, candidate.serviceCode);
      return {
        petId: input.pet.petId,
        targetServiceCode: candidate.serviceCode,
        reasonCodes: candidate.reasonCodes,
        explanation: candidate.explanation,
        confidence: 1,
        sourceFeatures,
        canonicalOpportunity: {
          customerId: input.pet.customerId,
          opportunityType: "cross_sell",
          serviceCode: candidate.serviceCode,
          reason: candidate.explanation,
          estimatedValue: 0,
          valueStatus: "configuration_required",
          confidence: 1,
          sourceKey,
          idempotencyKey: sourceKey,
        },
        canonicalContext: {
          normalizedOpportunityType: "cross_sell",
          targetServiceCode: candidate.serviceCode,
          petId: input.pet.petId,
          reasonCodes: candidate.reasonCodes,
          expectedContribution: null,
        },
      } satisfies NextBestServiceRecommendation;
    });
}
