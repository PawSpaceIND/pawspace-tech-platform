import {
  unifiedRenewalJourneyTransitions,
  type UnifiedRenewalJourney,
  type UnifiedRenewalJourneyState,
} from "../types/subscription-renewal";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessageSentJourneyInput {
  householdId: string;
  entitlementId?: string | null;
  serviceCode: string;
}

export type DunningWalletStatus =
  | "active"
  | "past_due"
  | "grace"
  | "suspended"
  | "cancelled";

export interface PastDueSubscriptionWallet {
  entitlementId: string;
  householdId: string;
  serviceCode: string;
  status: DunningWalletStatus;
  expiryDate: string;
  retryCount: number;
}

export interface SubscriptionDunningPolicy {
  gracePeriodDays: number;
  retryOffsetsDays: readonly number[];
  maxRetries: number;
}

export type SubscriptionDunningTrigger =
  | "enter_grace_period"
  | "retry_payment"
  | "grace_period_expired";

export interface SubscriptionDunningEvaluation {
  triggers: readonly SubscriptionDunningTrigger[];
  graceEndsAt: number | null;
  nextRetryAt: number | null;
  reason: string;
}

export const defaultSubscriptionDunningPolicy: SubscriptionDunningPolicy = {
  gracePeriodDays: 7,
  retryOffsetsDays: [0, 2, 5],
  maxRetries: 3,
};

function transitionJourney(
  journey: UnifiedRenewalJourney,
  nextState: UnifiedRenewalJourneyState,
  updatedAt: number,
): UnifiedRenewalJourney {
  if (journey.state === nextState) return journey;

  const allowed = unifiedRenewalJourneyTransitions[journey.state];
  if (!allowed.includes(nextState)) {
    throw new Error(`Invalid renewal transition: ${journey.state} -> ${nextState}`);
  }

  return { ...journey, state: nextState, updatedAt };
}

export function handleRenewalMessageSent(
  input: MessageSentJourneyInput,
  updatedAt = Date.now(),
): UnifiedRenewalJourney {
  return { ...input, state: "message_sent", updatedAt };
}

export function handleRenewalLinkClicked(
  journey: UnifiedRenewalJourney,
  updatedAt = Date.now(),
): UnifiedRenewalJourney {
  return transitionJourney(journey, "link_clicked", updatedAt);
}

export function handleRenewalPaymentVerified(
  journey: UnifiedRenewalJourney,
  updatedAt = Date.now(),
): UnifiedRenewalJourney {
  return transitionJourney(journey, "payment_verified", updatedAt);
}

export function handleRenewalEntitlementActivated(
  journey: UnifiedRenewalJourney,
  entitlementId: string,
  updatedAt = Date.now(),
): UnifiedRenewalJourney {
  const next = transitionJourney(journey, "entitlement_active", updatedAt);
  return next.entitlementId === entitlementId ? next : { ...next, entitlementId };
}

function parseExpiry(expiryDate: string): number {
  const value = Date.parse(expiryDate);
  if (!Number.isFinite(value)) {
    throw new Error("Invalid subscription wallet expiryDate");
  }
  return value;
}

function validateDunningPolicy(policy: SubscriptionDunningPolicy): void {
  if (!Number.isInteger(policy.gracePeriodDays) || policy.gracePeriodDays < 0) {
    throw new Error("gracePeriodDays must be a non-negative integer");
  }
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer");
  }
  if (policy.retryOffsetsDays.some((offset) => !Number.isInteger(offset) || offset < 0)) {
    throw new Error("retryOffsetsDays must contain non-negative integers");
  }
}

export function evaluateSubscriptionDunning(
  wallet: PastDueSubscriptionWallet,
  policy: SubscriptionDunningPolicy = defaultSubscriptionDunningPolicy,
  now = Date.now(),
): SubscriptionDunningEvaluation {
  validateDunningPolicy(policy);

  if (wallet.retryCount < 0 || !Number.isInteger(wallet.retryCount)) {
    throw new Error("retryCount must be a non-negative integer");
  }

  if (wallet.status === "cancelled" || wallet.status === "suspended") {
    return {
      triggers: [],
      graceEndsAt: null,
      nextRetryAt: null,
      reason: `Wallet is ${wallet.status}; automated dunning is disabled`,
    };
  }

  const expiryAt = parseExpiry(wallet.expiryDate);
  if (now <= expiryAt) {
    return {
      triggers: [],
      graceEndsAt: expiryAt + policy.gracePeriodDays * DAY_MS,
      nextRetryAt: null,
      reason: "Wallet is not past due",
    };
  }

  const graceEndsAt = expiryAt + policy.gracePeriodDays * DAY_MS;
  if (now > graceEndsAt) {
    return {
      triggers: ["grace_period_expired"],
      graceEndsAt,
      nextRetryAt: null,
      reason: "Grace period has expired; entitlement should remain fail-closed",
    };
  }

  const triggers: SubscriptionDunningTrigger[] = [];
  if (wallet.status === "active" || wallet.status === "past_due") {
    triggers.push("enter_grace_period");
  }

  const retryLimit = Math.min(policy.maxRetries, policy.retryOffsetsDays.length);
  const retryOffset = wallet.retryCount < retryLimit
    ? policy.retryOffsetsDays[wallet.retryCount]
    : undefined;
  const scheduledRetryAt = retryOffset === undefined
    ? null
    : expiryAt + retryOffset * DAY_MS;

  if (scheduledRetryAt !== null && now >= scheduledRetryAt) {
    triggers.push("retry_payment");
  }

  const nextRetryOffset = wallet.retryCount + 1 < retryLimit
    ? policy.retryOffsetsDays[wallet.retryCount + 1]
    : undefined;
  const nextRetryAt = nextRetryOffset === undefined
    ? null
    : expiryAt + nextRetryOffset * DAY_MS;

  return {
    triggers,
    graceEndsAt,
    nextRetryAt,
    reason: triggers.length > 0
      ? "Past-due wallet requires governed grace/retry handling"
      : "Past-due wallet is inside grace period; no retry is due yet",
  };
}
