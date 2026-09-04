export type PetSpecies = "dog" | "cat" | "other";
export type VaccinationStatus = "current" | "due" | "unknown";

export interface PetProfileSignal {
  petId: string;
  customerId: string;
  species: PetSpecies;
  breed: string | null;
  ageMonths: number | null;
  vaccinationStatus: VaccinationStatus;
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
    vaccinationStatus: VaccinationStatus;
    completedServices: string[];
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
  confidence: number;
}

const ACTIVE_OPPORTUNITY_STATES = new Set(["ready", "suppressed", "review_required"]);

function completedServices(history: PetServiceHistoryItem[]): Set<string> {
  return new Set(
    history
      .filter((item) => item.status === "completed")
      .map((item) => item.serviceCode.trim().toLowerCase())
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
      .map((opportunity) => opportunity.serviceCode!.trim().toLowerCase()),
  );
}

function eligibleAge(ageMonths: number | null, minimumMonths: number): boolean {
  return ageMonths !== null && Number.isFinite(ageMonths) && ageMonths >= minimumMonths;
}

function isYoungDog(pet: PetProfileSignal): boolean {
  return pet.species === "dog" && pet.ageMonths !== null && pet.ageMonths >= 6 && pet.ageMonths <= 24;
}

function ruleCandidates(pet: PetProfileSignal, completed: Set<string>): RuleCandidate[] {
  if (pet.species !== "dog") return [];

  const candidates: RuleCandidate[] = [];
  const hasTraining = completed.has("dog_training") || completed.has("training");
  const hasWalking = completed.has("dog_walking") || completed.has("walking");
  const hasBoarding = completed.has("boarding");
  const hasGrooming = completed.has("grooming");

  if (hasTraining && isYoungDog(pet) && !hasWalking) {
    candidates.push({
      serviceCode: "dog_walking",
      reasonCodes: ["training_completed", "young_dog", "walking_service_gap"],
      explanation: "Training is complete and this young dog has no completed Walking history.",
      confidence: 0.82,
    });
  }

  if (
    hasTraining &&
    eligibleAge(pet.ageMonths, 6) &&
    pet.vaccinationStatus === "current" &&
    !hasBoarding
  ) {
    candidates.push({
      serviceCode: "boarding",
      reasonCodes: ["training_completed", "vaccination_current", "boarding_service_gap"],
      explanation: "Training is complete, vaccination is current, and there is no completed Boarding history.",
      confidence: 0.74,
    });
  }

  if (hasGrooming && isYoungDog(pet) && !hasTraining) {
    candidates.push({
      serviceCode: "dog_training",
      reasonCodes: ["grooming_completed", "young_dog", "training_service_gap"],
      explanation: "This young dog has completed Grooming but has no completed Training history.",
      confidence: 0.78,
    });
  }

  if (hasBoarding && !hasGrooming) {
    candidates.push({
      serviceCode: "grooming",
      reasonCodes: ["boarding_completed", "grooming_service_gap"],
      explanation: "Boarding has been completed and there is no completed Grooming history.",
      confidence: 0.68,
    });
  }

  return candidates;
}

function stableSignalKey(petId: string, serviceCode: string): string {
  return `pet-next-best-service:${petId}:${serviceCode}`;
}

/**
 * Generates explainable cross-sell candidates only. Contact eligibility remains the
 * responsibility of the central safety gate. Breed is retained as an explanation/signal
 * input but is never used alone to infer medical, behavioural, or service eligibility.
 */
export function recommendNextBestServices(input: NextBestServiceInput): NextBestServiceRecommendation[] {
  if (!input.pet.petId || !input.pet.customerId) throw new Error("Canonical pet and customer identity are required");
  if (input.pet.ageMonths !== null && (!Number.isFinite(input.pet.ageMonths) || input.pet.ageMonths < 0)) {
    throw new Error("Pet ageMonths must be non-negative when provided");
  }

  const completed = completedServices(input.serviceHistory);
  const existingTargets = existingTargetServices(input.existingOpportunities ?? []);
  const sourceFeatures = {
    species: input.pet.species,
    breed: input.pet.breed?.trim() || null,
    ageMonths: input.pet.ageMonths,
    vaccinationStatus: input.pet.vaccinationStatus,
    completedServices: [...completed].sort(),
  };

  return ruleCandidates(input.pet, completed)
    .filter((candidate) => !completed.has(candidate.serviceCode) && !existingTargets.has(candidate.serviceCode))
    .sort((left, right) => right.confidence - left.confidence)
    .map((candidate) => {
      const sourceKey = stableSignalKey(input.pet.petId, candidate.serviceCode);
      const reason = `${candidate.explanation}${sourceFeatures.breed ? ` Pet profile breed: ${sourceFeatures.breed}.` : ""}`;
      return {
        petId: input.pet.petId,
        targetServiceCode: candidate.serviceCode,
        reasonCodes: candidate.reasonCodes,
        explanation: reason,
        confidence: candidate.confidence,
        sourceFeatures,
        canonicalOpportunity: {
          customerId: input.pet.customerId,
          opportunityType: "cross_sell",
          serviceCode: candidate.serviceCode,
          reason,
          estimatedValue: 0,
          valueStatus: "configuration_required",
          confidence: candidate.confidence,
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
