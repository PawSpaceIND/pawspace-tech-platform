export type GrowthOpportunityEligibility =
  | "eligible"
  | "ineligible"
  | "suppressed";

export type GrowthOpportunityPreferredChannel =
  | "whatsapp"
  | "sms"
  | "email"
  | "in_app"
  | "phone"
  | "none";

export interface RecommendedPet {
  petId: string;
  petName?: string | null;
}

/**
 * Explainable, assistive recommendation contract for Epic #475.
 *
 * This type does not authorize outreach or bypass consent/suppression controls.
 * `confidence` is expected to be normalized to the 0..1 range.
 */
export interface NextBestServiceRecommendation {
  recommendedService: string;
  recommendedPet: RecommendedPet | null;
  reason: string;
  confidence: number;
  eligibility: GrowthOpportunityEligibility;
  estimatedRevenue: number;
  preferredChannel: GrowthOpportunityPreferredChannel;
}
