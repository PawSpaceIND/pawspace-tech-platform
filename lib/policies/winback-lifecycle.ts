export type WinbackLifecycleStage = "active" | "repeat_due" | "at_risk" | "win_back" | "dormant";
export type WinbackPolicyStatus = "draft_v2" | "configuration_required";

export interface WinbackLifecycleThresholds {
  repeatDueDays: number;
  atRiskDays: number;
  winBackDays: number;
  dormantDays: number | null;
}

export interface WinbackLifecyclePolicy {
  serviceCode: string;
  thresholds: WinbackLifecycleThresholds | null;
  policyStatus: WinbackPolicyStatus;
}

const configurationRequired = (serviceCode: string): WinbackLifecyclePolicy => ({
  serviceCode,
  thresholds: null,
  policyStatus: "configuration_required",
});

export const WINBACK_LIFECYCLE_POLICIES: Readonly<Record<string, WinbackLifecyclePolicy>> = {
  grooming: {
    serviceCode: "grooming",
    thresholds: {
      repeatDueDays: 15,
      atRiskDays: 30,
      winBackDays: 45,
      dormantDays: null,
    },
    policyStatus: "draft_v2",
  },
  dog_training: configurationRequired("dog_training"),
  dog_walking: configurationRequired("dog_walking"),
  boarding: configurationRequired("boarding"),
  pet_sitting: configurationRequired("pet_sitting"),
  pet_taxi: configurationRequired("pet_taxi"),
  food: configurationRequired("food"),
  relocation: configurationRequired("relocation"),
};

export function lifecyclePolicyForService(serviceCode: string): WinbackLifecyclePolicy | null {
  return WINBACK_LIFECYCLE_POLICIES[serviceCode.trim().toLowerCase()] ?? null;
}

export function classifyWinbackLifecycle(serviceCode: string, daysInactive: number): WinbackLifecycleStage | null {
  if (!Number.isFinite(daysInactive) || daysInactive < 0) throw new Error("daysInactive must be non-negative");
  const policy = lifecyclePolicyForService(serviceCode);
  if (!policy?.thresholds) return null;

  const { repeatDueDays, atRiskDays, winBackDays, dormantDays } = policy.thresholds;
  if (dormantDays !== null && daysInactive >= dormantDays) return "dormant";
  if (daysInactive >= winBackDays) return "win_back";
  if (daysInactive >= atRiskDays) return "at_risk";
  if (daysInactive >= repeatDueDays) return "repeat_due";
  return "active";
}
