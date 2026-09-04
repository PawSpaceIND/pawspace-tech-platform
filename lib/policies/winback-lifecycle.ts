export type WinBackLifecycleStage =
  | "repeat_due"
  | "at_risk"
  | "win_back"
  | "deep_win_back"
  | "dormant";

export interface ServiceWinBackLifecyclePolicy {
  repeatDueDays: number;
  atRiskDays: number;
  winBackDays: number;
  deepWinBackDays: number;
  dormantDays: number;
}

export interface WinBackLifecyclePolicyConfig {
  version: string;
  services: Record<string, ServiceWinBackLifecyclePolicy>;
}

/**
 * Epic #476 service-specific inactivity scaffold.
 * Values are configuration defaults for V2 design work and are not wired to V1 outreach.
 */
export const WINBACK_LIFECYCLE_POLICY: WinBackLifecyclePolicyConfig = {
  version: "v2-epic-476-scaffold-1",
  services: {
    Grooming: {
      repeatDueDays: 15,
      atRiskDays: 30,
      winBackDays: 45,
      deepWinBackDays: 90,
      dormantDays: 180,
    },
    Training: {
      repeatDueDays: 30,
      atRiskDays: 60,
      winBackDays: 90,
      deepWinBackDays: 180,
      dormantDays: 365,
    },
    Boarding: {
      repeatDueDays: 60,
      atRiskDays: 120,
      winBackDays: 180,
      deepWinBackDays: 270,
      dormantDays: 365,
    },
  },
};
