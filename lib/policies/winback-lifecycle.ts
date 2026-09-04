export type WinbackLifecycleStage = "active" | "repeat_due" | "at_risk" | "win_back" | "dormant";
export type WinbackCadenceModel = "inactivity_threshold" | "event_driven";

export interface WinbackLifecyclePolicy {
  serviceCode: string;
  cadenceModel: WinbackCadenceModel;
  repeatDueDays: number | null;
  atRiskDays: number | null;
  winBackDays: number | null;
  dormantDays: number | null;
  policyStatus: "draft_v2";
}

function eventDrivenPolicy(serviceCode: string): WinbackLifecyclePolicy {
  return {
    serviceCode,
    cadenceModel: "event_driven",
    repeatDueDays: null,
    atRiskDays: null,
    winBackDays: null,
    dormantDays: null,
    policyStatus: "draft_v2",
  };
}

export const WINBACK_LIFECYCLE_POLICIES: Readonly<Record<string, WinbackLifecyclePolicy>> = {
  grooming: {
    serviceCode: "grooming",
    cadenceModel: "inactivity_threshold",
    repeatDueDays: 15,
    atRiskDays: 30,
    winBackDays: 45,
    dormantDays: 90,
    policyStatus: "draft_v2",
  },
  dog_training: {
    serviceCode: "dog_training",
    cadenceModel: "inactivity_threshold",
    repeatDueDays: 30,
    atRiskDays: 45,
    winBackDays: 60,
    dormantDays: 120,
    policyStatus: "draft_v2",
  },
  dog_walking: {
    serviceCode: "dog_walking",
    cadenceModel: "inactivity_threshold",
    repeatDueDays: 7,
    atRiskDays: 14,
    winBackDays: 30,
    dormantDays: 60,
    policyStatus: "draft_v2",
  },
  boarding: eventDrivenPolicy("boarding"),
  pet_sitting: eventDrivenPolicy("pet_sitting"),
  pet_taxi: eventDrivenPolicy("pet_taxi"),
  relocation: eventDrivenPolicy("relocation"),
  funeral: eventDrivenPolicy("funeral"),
};

export function lifecyclePolicyForService(serviceCode: string): WinbackLifecyclePolicy | null {
  return WINBACK_LIFECYCLE_POLICIES[serviceCode.trim().toLowerCase()] ?? null;
}

export function classifyWinbackLifecycle(serviceCode: string, daysInactive: number): WinbackLifecycleStage | null {
  if (!Number.isFinite(daysInactive) || daysInactive < 0) throw new Error("daysInactive must be non-negative");
  const policy = lifecyclePolicyForService(serviceCode);
  if (!policy || policy.cadenceModel === "event_driven") return null;

  const repeatDueDays = policy.repeatDueDays ?? Number.POSITIVE_INFINITY;
  const atRiskDays = policy.atRiskDays ?? Number.POSITIVE_INFINITY;
  const winBackDays = policy.winBackDays ?? Number.POSITIVE_INFINITY;
  const dormantDays = policy.dormantDays ?? Number.POSITIVE_INFINITY;

  if (daysInactive >= dormantDays) return "dormant";
  if (daysInactive >= winBackDays) return "win_back";
  if (daysInactive >= atRiskDays) return "at_risk";
  if (daysInactive >= repeatDueDays) return "repeat_due";
  return "active";
}
