export type ContactEligibility = "Allowed" | "Suppressed" | "Review Required";

export type ContactSafetyReason =
  | "marketing_opt_out"
  | "channel_opt_out"
  | "open_complaint"
  | "unresolved_refund_or_payment_dispute"
  | "quiet_hours"
  | "identity_review_required"
  | "data_quality_review_required"
  | "opportunity_closed";

export interface QuietHoursContext {
  active: boolean;
  timezone?: string;
  nextEligibleAt?: number | null;
}

export interface ContactSafetyInput {
  marketingOptOut?: boolean;
  channelOptOut?: boolean;
  openComplaint?: boolean;
  unresolvedRefundOrPaymentDispute?: boolean;
  quietHours?: QuietHoursContext;
  identityReviewRequired?: boolean;
  dataQualityReviewRequired?: boolean;
  opportunityClosed?: boolean;
  policyVersion?: string;
}

export interface ContactSafetyDecision {
  eligibility: ContactEligibility;
  reasonCodes: ContactSafetyReason[];
  nextEligibleAt: number | null;
  policyVersion: string;
}

const DEFAULT_POLICY_VERSION = "v2-contact-safety-foundation-1";

export function evaluateContactEligibility(input: ContactSafetyInput): ContactSafetyDecision {
  const suppressed: ContactSafetyReason[] = [];
  const review: ContactSafetyReason[] = [];

  if (input.marketingOptOut) suppressed.push("marketing_opt_out");
  if (input.channelOptOut) suppressed.push("channel_opt_out");
  if (input.openComplaint) suppressed.push("open_complaint");
  if (input.unresolvedRefundOrPaymentDispute) suppressed.push("unresolved_refund_or_payment_dispute");
  if (input.opportunityClosed) suppressed.push("opportunity_closed");
  if (input.quietHours?.active) suppressed.push("quiet_hours");

  if (input.identityReviewRequired) review.push("identity_review_required");
  if (input.dataQualityReviewRequired) review.push("data_quality_review_required");

  const reasonCodes = [...suppressed, ...review];
  const eligibility: ContactEligibility = suppressed.length
    ? "Suppressed"
    : review.length
      ? "Review Required"
      : "Allowed";

  return {
    eligibility,
    reasonCodes,
    nextEligibleAt: input.quietHours?.active ? input.quietHours.nextEligibleAt ?? null : null,
    policyVersion: input.policyVersion?.trim() || DEFAULT_POLICY_VERSION,
  };
}
