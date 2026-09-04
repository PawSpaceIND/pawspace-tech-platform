export type UnifiedWorkType =
  | "new_lead"
  | "sla_breach"
  | "callback"
  | "rnr_follow_up"
  | "repeat_due"
  | "subscription_renewal"
  | "subscription_low_balance"
  | "payment_recovery"
  | "win_back"
  | "cross_sell"
  | "loyalty"
  | "service_recovery";

export type UnifiedWorkState = "ready" | "waiting" | "deferred" | "suppressed" | "completed";
export type QueueSafetyDecision = "Allowed" | "Suppressed" | "Review Required";

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
  safetyDecision: QueueSafetyDecision;
  expectedRevenue: number | null;
  expectedContribution: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface QueuePriorityFactors {
  urgency: number;
  conversionConfidence: number;
  expectedRevenue: number;
  expectedContribution: number;
  customerValue: number;
  lifecycleRisk: number;
  capacityAvailability: number;
  workAge: number;
  managerEscalation: number;
}

export type QueuePriorityWeights = Readonly<Record<keyof QueuePriorityFactors, number>>;

export interface QueuePriorityInput {
  factors: QueuePriorityFactors;
  weights: QueuePriorityWeights;
  safetyDecision: QueueSafetyDecision;
}

function normalizeUnit(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return Math.min(1, Math.max(0, value));
}

export function calculateQueuePriority(input: QueuePriorityInput): number {
  if (input.safetyDecision !== "Allowed") return 0;

  const entries = Object.entries(input.factors) as Array<[keyof QueuePriorityFactors, number]>;
  let weightedScore = 0;
  let totalWeight = 0;

  for (const [factor, rawValue] of entries) {
    const weight = input.weights[factor];
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`${factor} weight must be a non-negative finite number`);
    weightedScore += normalizeUnit(rawValue, factor) * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) throw new Error("At least one queue-priority weight must be greater than zero");
  return Math.round((weightedScore / totalWeight) * 10_000) / 100;
}
