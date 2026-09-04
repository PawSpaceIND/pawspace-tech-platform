export type UnifiedWorkType =
  | "new_lead"
  | "sla_breach"
  | "callback"
  | "rnr_follow_up"
  | "repeat_due"
  | "subscription_renewal"
  | "payment_recovery"
  | "win_back"
  | "cross_sell"
  | "loyalty"
  | "service_recovery";

export type UnifiedWorkState = "ready" | "waiting" | "deferred" | "suppressed" | "completed";

export interface UnifiedWorkItem {
  id: string;
  workType: UnifiedWorkType;
  customerId: string;
  petId: string | null;
  serviceCode: string | null;
  opportunityId: string | null;
  ownerId: string | null;
  state: UnifiedWorkState;
  dueAt: number | null;
  priorityScore: number;
  priorityReasons: string[];
  safetyDecision: "Allowed" | "Suppressed" | "Review Required";
  expectedRevenue: number | null;
  expectedContribution: number | null;
  createdAt: number;
  updatedAt: number;
}

function normalized(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return Math.min(1, Math.max(0, value));
}

/**
 * All inputs are normalized 0..1 factors. The multiplicative contract intentionally
 * requires every dimension to contribute: urgency alone cannot outrank a zero-capacity
 * or zero-conversion opportunity. The returned score is 0..100.
 */
export function calculateQueuePriority(
  urgency: number,
  conversionProbability: number,
  contributionOpportunity: number,
  customerValue: number,
  capacity: number,
): number {
  const factors = [
    normalized(urgency, "urgency"),
    normalized(conversionProbability, "conversionProbability"),
    normalized(contributionOpportunity, "contributionOpportunity"),
    normalized(customerValue, "customerValue"),
    normalized(capacity, "capacity"),
  ];
  const score = factors.reduce((product, factor) => product * factor, 1) * 100;
  return Math.round(score * 100) / 100;
}
