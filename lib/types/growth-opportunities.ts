export type GrowthOpportunityEligibility =
  | "eligible"
  | "ineligible"
  | "suppressed"
  | "review_required";

export type GrowthOpportunityPreferredChannel =
  | "whatsapp"
  | "sms"
  | "email"
  | "in_app"
  | "phone"
  | "call"
  | "none";

export interface RecommendedPet {
  petId: string;
  petName?: string | null;
}

/**
 * Explainable, assistive recommendation contract for Growth OS Epic #475.
 *
 * This is a recommendation only. It does not authorize customer contact or
 * bypass canonical consent, suppression, quiet-hour, complaint, payment, or
 * data-quality controls. `confidence` is normalized to the 0..1 range.
 */
export interface NextBestServiceRecommendation {
  customerId: string;
  recommendedService: string;
  recommendedPet: RecommendedPet | null;
  reason: string;
  confidence: number;
  eligibility: GrowthOpportunityEligibility;
  estimatedRevenue: number;
  preferredChannel: GrowthOpportunityPreferredChannel;
  sourceKey: string;
  signalSnapshot: Record<string, unknown>;
}
