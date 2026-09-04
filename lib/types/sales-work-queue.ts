export type UnifiedWorkItemType =
  | "new_lead"
  | "sla"
  | "rnr"
  | "renewal"
  | "win_back"
  | "cross_sell";

export interface UnifiedWorkItem {
  workItemId: string;
  type: UnifiedWorkItemType;
  householdId: string;
  customerId?: string | null;
  petId?: string | null;
  serviceCode?: string | null;
  ownerId?: string | null;
  sourceId: string;
  title: string;
  reason: string;
  dueAt?: number | null;
  status: "open" | "waiting" | "deferred" | "completed" | "suppressed";
  urgency: number;
  conversionProbability: number;
  contributionOpportunity: number;
  customerValue: number;
  capacity: number;
}

export interface QueuePriorityInputs {
  urgency: number;
  conversionProbability: number;
  contributionOpportunity: number;
  customerValue: number;
  capacity: number;
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Deterministic V2 queue-priority contract. Inputs are normalized to 0..1 before
 * weighting so callers cannot accidentally dominate the score with raw units.
 */
export function calculateQueuePriority(
  urgency: number,
  conversionProbability: number,
  contributionOpportunity: number,
  customerValue: number,
  capacity: number,
): number {
  const weightedScore =
    clampUnit(urgency) * 0.3 +
    clampUnit(conversionProbability) * 0.25 +
    clampUnit(contributionOpportunity) * 0.2 +
    clampUnit(customerValue) * 0.15 +
    clampUnit(capacity) * 0.1;

  return Number(weightedScore.toFixed(4));
}
