export type ContactSafetyStatus = "Allowed" | "Suppressed" | "Review Required";

export type ContactSafetyReason =
  | "marketing_opt_out"
  | "channel_opt_out"
  | "quiet_hours"
  | "frequency_cap"
  | "open_complaint"
  | "unresolved_refund";

export type ContactChannel = "whatsapp" | "sms" | "email" | "push" | "voice" | "phone" | "in_app";

export interface ContactEligibilityInput {
  householdId: string;
  intendedChannel: ContactChannel;
}

export interface ContactEligibilityDecision {
  status: ContactSafetyStatus;
  reasons: ContactSafetyReason[];
  nextEligibleAt?: number | null;
  policyVersion?: string | null;
}

/**
 * Epic #476 contract for the universal commercial-contact safety decision.
 * Implementations must fail closed when canonical consent or safety state is unavailable.
 */
export interface ContactSafetyGate {
  evaluateContactEligibility(
    input: ContactEligibilityInput,
  ): Promise<ContactEligibilityDecision> | ContactEligibilityDecision;
}
