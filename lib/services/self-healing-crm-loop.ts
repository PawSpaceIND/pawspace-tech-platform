import {
  evaluateContactEligibility,
  type ContactSafetyInput,
} from "./contact-safety-gate";

export type SelfHealingDealStage =
  | "new"
  | "qualified"
  | "proposal_sent"
  | "payment_ready"
  | "payment_link_sent"
  | "won"
  | "lost";

export interface SelfHealingDealSnapshot {
  dealId: string;
  customerId: string;
  stage: SelfHealingDealStage;
  updatedAt: number;
  lastActivityAt: number;
  profile: Record<string, unknown>;
  transcriptAvailable: boolean;
  contactSafety: ContactSafetyInput;
}

export interface SelfHealingPolicy {
  mandatoryProfileFields: string[];
  stagnantAfterMinutes: Partial<Record<SelfHealingDealStage, number>>;
  idempotencyWindowMinutes: number;
}

export interface SelfHealingCrmDependencies {
  listCandidateDeals(): SelfHealingDealSnapshot[] | Promise<SelfHealingDealSnapshot[]>;
  claimIdempotencyKey(key: string): boolean | Promise<boolean>;
  requestEntityExtraction(input: {
    dealId: string;
    customerId: string;
    missingFields: string[];
  }): void | Promise<void>;
  refreshPredictiveChurn(input: { customerId: string; dealId: string }): void | Promise<void>;
  queueGovernedRecovery(input: {
    customerId: string;
    dealId: string;
    reasonCode: "stagnant_deal";
    nextEligibleAt: number | null;
  }): void | Promise<void>;
  recordAudit?(input: {
    dealId: string;
    action: string;
    detail: Record<string, unknown>;
  }): void | Promise<void>;
}

export interface SelfHealingDealResult {
  dealId: string;
  missingFields: string[];
  stagnant: boolean;
  actions: string[];
}

export interface SelfHealingRunResult {
  scanned: number;
  repaired: number;
  actionsTriggered: number;
  deals: SelfHealingDealResult[];
}

export const DEFAULT_SELF_HEALING_POLICY: SelfHealingPolicy = {
  mandatoryProfileFields: ["petName", "petSpecies", "serviceIntent"],
  stagnantAfterMinutes: {
    new: 60,
    qualified: 180,
    proposal_sent: 240,
    payment_ready: 120,
    payment_link_sent: 360,
  },
  idempotencyWindowMinutes: 360,
};

function missingFields(profile: Record<string, unknown>, required: string[]): string[] {
  return required.filter((field) => {
    const value = profile[field];
    return value == null || value === "" || (Array.isArray(value) && value.length === 0);
  });
}

function isTerminal(stage: SelfHealingDealStage): boolean {
  return stage === "won" || stage === "lost";
}

function isStagnant(deal: SelfHealingDealSnapshot, policy: SelfHealingPolicy, now: number): boolean {
  if (isTerminal(deal.stage)) return false;
  const thresholdMinutes = policy.stagnantAfterMinutes[deal.stage];
  if (thresholdMinutes == null || thresholdMinutes <= 0) return false;
  return now - deal.lastActivityAt >= thresholdMinutes * 60_000;
}

function windowedKey(dealId: string, action: string, now: number, windowMinutes: number): string {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  return `self-heal:${dealId}:${action}:${Math.floor(now / windowMs)}`;
}

export async function runSelfHealingCrmLoop(
  dependencies: SelfHealingCrmDependencies,
  input?: { now?: number; policy?: SelfHealingPolicy },
): Promise<SelfHealingRunResult> {
  const now = input?.now ?? Date.now();
  const policy = input?.policy ?? DEFAULT_SELF_HEALING_POLICY;
  const deals = await dependencies.listCandidateDeals();
  const results: SelfHealingDealResult[] = [];
  let actionsTriggered = 0;

  for (const deal of deals) {
    const missing = missingFields(deal.profile, policy.mandatoryProfileFields);
    const stagnant = isStagnant(deal, policy, now);
    const actions: string[] = [];

    if (missing.length && deal.transcriptAvailable) {
      const key = windowedKey(deal.dealId, "entity_extraction", now, policy.idempotencyWindowMinutes);
      if (await dependencies.claimIdempotencyKey(key)) {
        await dependencies.requestEntityExtraction({
          dealId: deal.dealId,
          customerId: deal.customerId,
          missingFields: missing,
        });
        actions.push("entity_extraction_requested");
        actionsTriggered += 1;
      }
    }

    if (stagnant) {
      const churnKey = windowedKey(deal.dealId, "churn_refresh", now, policy.idempotencyWindowMinutes);
      if (await dependencies.claimIdempotencyKey(churnKey)) {
        await dependencies.refreshPredictiveChurn({ customerId: deal.customerId, dealId: deal.dealId });
        actions.push("predictive_churn_refresh_requested");
        actionsTriggered += 1;
      }

      const safety = evaluateContactEligibility(deal.contactSafety);
      if (safety.eligibility === "Allowed") {
        const recoveryKey = windowedKey(deal.dealId, "recovery", now, policy.idempotencyWindowMinutes);
        if (await dependencies.claimIdempotencyKey(recoveryKey)) {
          await dependencies.queueGovernedRecovery({
            customerId: deal.customerId,
            dealId: deal.dealId,
            reasonCode: "stagnant_deal",
            nextEligibleAt: safety.nextEligibleAt,
          });
          actions.push("governed_recovery_queued");
          actionsTriggered += 1;
        }
      } else {
        actions.push(`recovery_${safety.eligibility === "Suppressed" ? "suppressed" : "review_required"}`);
      }
    }

    if (actions.length) {
      await dependencies.recordAudit?.({
        dealId: deal.dealId,
        action: "self_healing_iteration",
        detail: { missingFields: missing, stagnant, actions },
      });
    }
    results.push({ dealId: deal.dealId, missingFields: missing, stagnant, actions });
  }

  return {
    scanned: deals.length,
    repaired: results.filter((result) => result.actions.length > 0).length,
    actionsTriggered,
    deals: results,
  };
}

export function createSelfHealingCrmWorker(dependencies: SelfHealingCrmDependencies, policy = DEFAULT_SELF_HEALING_POLICY) {
  return {
    runScheduled(now = Date.now()) {
      return runSelfHealingCrmLoop(dependencies, { now, policy });
    },
  };
}
