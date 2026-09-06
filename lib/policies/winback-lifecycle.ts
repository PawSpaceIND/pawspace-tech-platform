export type WinBackServiceCode =
  | "grooming"
  | "training"
  | "walking"
  | "boarding"
  | "sitting"
  | "taxi"
  | "food";

export type WinBackLifecycleState =
  | "active"
  | "repeat_due"
  | "at_risk"
  | "win_back_eligible"
  | "deep_win_back"
  | "dormant";

export interface WinBackLifecycleThresholds {
  repeatDueDays: number;
  atRiskDays: number;
  winBackEligibleDays: number;
  deepWinBackDays: number;
  dormantDays: number;
}

export interface WinBackLifecyclePolicy {
  serviceCode: WinBackServiceCode;
  version: string;
  requiresApproval: boolean;
  thresholds: WinBackLifecycleThresholds;
}

const VERSION = "v2-foundation-draft-1";

export const WINBACK_LIFECYCLE_POLICIES: Readonly<Record<WinBackServiceCode, WinBackLifecyclePolicy>> = {
  grooming: {
    serviceCode: "grooming",
    version: VERSION,
    requiresApproval: true,
    thresholds: { repeatDueDays: 15, atRiskDays: 30, winBackEligibleDays: 45, deepWinBackDays: 60, dormantDays: 90 },
  },
  training: {
    serviceCode: "training",
    version: VERSION,
    requiresApproval: true,
    thresholds: { repeatDueDays: 30, atRiskDays: 60, winBackEligibleDays: 90, deepWinBackDays: 120, dormantDays: 180 },
  },
  walking: {
    serviceCode: "walking",
    version: VERSION,
    requiresApproval: true,
    thresholds: { repeatDueDays: 7, atRiskDays: 14, winBackEligibleDays: 21, deepWinBackDays: 30, dormantDays: 60 },
  },
  boarding: {
    serviceCode: "boarding",
    version: VERSION,
    requiresApproval: true,
    thresholds: { repeatDueDays: 60, atRiskDays: 90, winBackEligibleDays: 120, deepWinBackDays: 180, dormantDays: 365 },
  },
  sitting: {
    serviceCode: "sitting",
    version: VERSION,
    requiresApproval: true,
    thresholds: { repeatDueDays: 30, atRiskDays: 60, winBackEligibleDays: 90, deepWinBackDays: 120, dormantDays: 180 },
  },
  taxi: {
    serviceCode: "taxi",
    version: VERSION,
    requiresApproval: true,
    thresholds: { repeatDueDays: 30, atRiskDays: 60, winBackEligibleDays: 90, deepWinBackDays: 120, dormantDays: 180 },
  },
  food: {
    serviceCode: "food",
    version: VERSION,
    requiresApproval: true,
    thresholds: { repeatDueDays: 14, atRiskDays: 21, winBackEligibleDays: 30, deepWinBackDays: 45, dormantDays: 60 },
  },
};

export function evaluateWinBackLifecycle(
  serviceCode: WinBackServiceCode,
  daysSinceLastCompletedService: number,
): WinBackLifecycleState {
  const days = Math.max(0, Math.floor(daysSinceLastCompletedService));
  const thresholds = WINBACK_LIFECYCLE_POLICIES[serviceCode].thresholds;

  if (days >= thresholds.dormantDays) return "dormant";
  if (days >= thresholds.deepWinBackDays) return "deep_win_back";
  if (days >= thresholds.winBackEligibleDays) return "win_back_eligible";
  if (days >= thresholds.atRiskDays) return "at_risk";
  if (days >= thresholds.repeatDueDays) return "repeat_due";
  return "active";
}
