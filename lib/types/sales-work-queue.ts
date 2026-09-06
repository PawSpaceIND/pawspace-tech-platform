export type UnifiedWorkType =
  | "new_lead"
  | "callback"
  | "sla_breach"
  | "rnr_follow_up"
  | "repeat_due"
  | "subscription_renewal"
  | "subscription_low_balance"
  | "payment_recovery"
  | "win_back"
  | "cross_sell"
  | "loyalty"
  | "service_recovery";

export type WorkContactEligibility = "Allowed" | "Suppressed" | "Review Required";

export interface UnifiedWorkItem {
  id: string;
  workType: UnifiedWorkType;
  customerId: string;
  petId?: string | null;
  opportunityId?: string | null;
  serviceCode?: string | null;
  ownerId?: string | null;
  dueAt?: number | null;
  expectedRevenue?: number | null;
  expectedContribution?: number | null;
  contactEligibility: WorkContactEligibility;
  sourceReasonCodes: string[];
  nextAction: string;
  createdAt: number;
}

export interface QueuePriorityInput {
  urgency: number;
  confidence: number;
  expectedRevenue: number;
  expectedContribution?: number | null;
  customerValue: number;
  lifecycleRisk: number;
  capacityAvailability: number;
  ageHours: number;
  managerEscalated?: boolean;
  contactEligibility: WorkContactEligibility;
}

export interface QueuePriorityResult {
  score: number;
  blocked: boolean;
  reasons: string[];
  policyVersion: string;
}

const POLICY_VERSION = "v2-sales-queue-foundation-1";
const clamp100 = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const normalizeMoney = (value: number, ceiling: number) => clamp100((Math.max(0, value) / ceiling) * 100);

export function calculateQueuePriority(input: QueuePriorityInput): QueuePriorityResult {
  if (input.contactEligibility === "Suppressed") {
    return { score: 0, blocked: true, reasons: ["contact_suppressed"], policyVersion: POLICY_VERSION };
  }

  const contribution = input.expectedContribution == null
    ? normalizeMoney(input.expectedRevenue, 10_000)
    : normalizeMoney(input.expectedContribution, 5_000);
  const factors = {
    urgency: clamp100(input.urgency),
    confidence: clamp100(input.confidence),
    expectedRevenue: normalizeMoney(input.expectedRevenue, 10_000),
    expectedContribution: contribution,
    customerValue: clamp100(input.customerValue),
    lifecycleRisk: clamp100(input.lifecycleRisk),
    capacityAvailability: clamp100(input.capacityAvailability),
    age: clamp100((Math.max(0, input.ageHours) / 72) * 100),
    escalation: input.managerEscalated ? 100 : 0,
  };

  const weighted =
    factors.urgency * 0.22
    + factors.confidence * 0.12
    + factors.expectedRevenue * 0.12
    + factors.expectedContribution * 0.12
    + factors.customerValue * 0.10
    + factors.lifecycleRisk * 0.12
    + factors.capacityAvailability * 0.08
    + factors.age * 0.07
    + factors.escalation * 0.05;

  const reviewCap = input.contactEligibility === "Review Required" ? 25 : 100;
  const score = Math.round(Math.min(reviewCap, weighted));
  const reasons = Object.entries(factors)
    .filter(([, value]) => value >= 70)
    .sort((a, b) => b[1] - a[1])
    .map(([factor]) => `high_${factor}`);

  if (input.contactEligibility === "Review Required") reasons.unshift("contact_review_required");

  return {
    score,
    blocked: input.contactEligibility === "Review Required",
    reasons,
    policyVersion: POLICY_VERSION,
  };
}
