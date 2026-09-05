export type RenewalContractStatus =
  | "active"
  | "past_due"
  | "paused"
  | "cancelled";

export type RenewalJourneyStage =
  | "message_pending"
  | "message_sent"
  | "payment_link_ready"
  | "payment_pending"
  | "payment_confirmed"
  | "past_due"
  | "active"
  | "cancelled";

export type RenewalDunningState =
  | "not_required"
  | "retry_scheduled"
  | "grace_period"
  | "payment_link_resent"
  | "recovered"
  | "paused";

export type SubscriptionDunningCategory =
  | "payment_retry_failed"
  | "payment_failed_grace_period"
  | "subscription_paused";

export interface OneTapPaymentLink {
  url: string;
  providerReference: string;
  expiresAt: string;
}

export interface RenewalJourneyState {
  contractId: string;
  customerId: string;
  stage: RenewalJourneyStage;
  contractStatus: RenewalContractStatus;
  dunningState: RenewalDunningState;
  messageId: string | null;
  paymentLink: OneTapPaymentLink | null;
  paymentId: string | null;
  entitlementId: string | null;
  nextRetryAt: string | null;
  graceEndsAt: string | null;
  updatedAt: string;
}

export interface SubscriptionDunningNotification {
  category: SubscriptionDunningCategory;
  nextAttemptAt?: string | null;
  gracePeriodEndsAt?: string | null;
}

export type RenewalJourneyEvent =
  | { type: "message_sent"; messageId: string; at: string }
  | { type: "payment_link_created"; paymentLink: OneTapPaymentLink; at: string }
  | { type: "payment_started"; paymentId: string; at: string }
  | { type: "payment_succeeded"; paymentId: string; at: string }
  | { type: "entitlement_activated"; entitlementId: string; at: string }
  | {
      type: "payment_failed";
      nextRetryAt?: string | null;
      graceEndsAt?: string | null;
      at: string;
    }
  | { type: "payment_link_resent"; paymentLink: OneTapPaymentLink; at: string }
  | { type: "contract_paused"; at: string }
  | { type: "contract_cancelled"; at: string };

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function requireIsoTimestamp(value: string, field: string): string {
  requireNonEmpty(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-compatible timestamp`);
  }
  return value;
}

function validatePaymentLink(link: OneTapPaymentLink): OneTapPaymentLink {
  requireNonEmpty(link.providerReference, "providerReference");
  requireIsoTimestamp(link.expiresAt, "expiresAt");

  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    throw new Error("payment link must be an absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("payment link must use HTTPS");
  }
  return link;
}

function stamp(state: RenewalJourneyState, updatedAt: string): RenewalJourneyState {
  requireIsoTimestamp(updatedAt, "updatedAt");
  return { ...state, updatedAt };
}

export function createRenewalJourney(input: {
  contractId: string;
  customerId: string;
  updatedAt: string;
  contractStatus?: RenewalContractStatus;
}): RenewalJourneyState {
  const contractStatus = input.contractStatus ?? "active";
  requireNonEmpty(input.contractId, "contractId");
  requireNonEmpty(input.customerId, "customerId");
  requireIsoTimestamp(input.updatedAt, "updatedAt");

  return {
    contractId: input.contractId,
    customerId: input.customerId,
    stage: contractStatus === "cancelled" ? "cancelled" : "message_pending",
    contractStatus,
    dunningState:
      contractStatus === "past_due"
        ? "retry_scheduled"
        : contractStatus === "paused"
          ? "paused"
          : "not_required",
    messageId: null,
    paymentLink: null,
    paymentId: null,
    entitlementId: null,
    nextRetryAt: null,
    graceEndsAt: null,
    updatedAt: input.updatedAt,
  };
}

export const dunningStateHandlers = {
  paymentRetryFailed(
    state: RenewalJourneyState,
    nextRetryAt: string | null | undefined,
    at: string,
  ): RenewalJourneyState {
    if (nextRetryAt) requireIsoTimestamp(nextRetryAt, "nextRetryAt");
    return stamp(
      {
        ...state,
        stage: "past_due",
        contractStatus: "past_due",
        dunningState: "retry_scheduled",
        nextRetryAt: nextRetryAt ?? null,
      },
      at,
    );
  },

  gracePeriodStarted(
    state: RenewalJourneyState,
    graceEndsAt: string | null | undefined,
    at: string,
  ): RenewalJourneyState {
    if (graceEndsAt) requireIsoTimestamp(graceEndsAt, "graceEndsAt");
    return stamp(
      {
        ...state,
        stage: "past_due",
        contractStatus: "past_due",
        dunningState: "grace_period",
        graceEndsAt: graceEndsAt ?? null,
      },
      at,
    );
  },

  paymentLinkResent(
    state: RenewalJourneyState,
    paymentLink: OneTapPaymentLink,
    at: string,
  ): RenewalJourneyState {
    return stamp(
      {
        ...state,
        stage: "past_due",
        contractStatus: "past_due",
        dunningState: "payment_link_resent",
        paymentLink: validatePaymentLink(paymentLink),
      },
      at,
    );
  },

  contractPaused(state: RenewalJourneyState, at: string): RenewalJourneyState {
    return stamp(
      {
        ...state,
        stage: "past_due",
        contractStatus: "paused",
        dunningState: "paused",
      },
      at,
    );
  },
};

export function applyDunningNotification(
  state: RenewalJourneyState,
  notification: SubscriptionDunningNotification,
  at: string,
): RenewalJourneyState {
  switch (notification.category) {
    case "payment_retry_failed":
      return dunningStateHandlers.paymentRetryFailed(
        state,
        notification.nextAttemptAt,
        at,
      );
    case "payment_failed_grace_period":
      return dunningStateHandlers.gracePeriodStarted(
        state,
        notification.gracePeriodEndsAt,
        at,
      );
    case "subscription_paused":
      return dunningStateHandlers.contractPaused(state, at);
  }
}

export function advanceRenewalJourney(
  state: RenewalJourneyState,
  event: RenewalJourneyEvent,
): RenewalJourneyState {
  if (state.contractStatus === "cancelled" && event.type !== "contract_cancelled") {
    throw new Error("cancelled renewal contracts cannot advance");
  }

  switch (event.type) {
    case "message_sent":
      return stamp(
        {
          ...state,
          stage: "message_sent",
          messageId: requireNonEmpty(event.messageId, "messageId"),
        },
        event.at,
      );

    case "payment_link_created":
      if (!state.messageId) {
        throw new Error("renewal message must be sent before creating a payment link");
      }
      return stamp(
        {
          ...state,
          stage: "payment_link_ready",
          paymentLink: validatePaymentLink(event.paymentLink),
        },
        event.at,
      );

    case "payment_started":
      if (!state.paymentLink) {
        throw new Error("payment link must exist before payment starts");
      }
      return stamp(
        {
          ...state,
          stage: "payment_pending",
          paymentId: requireNonEmpty(event.paymentId, "paymentId"),
        },
        event.at,
      );

    case "payment_succeeded":
      return stamp(
        {
          ...state,
          stage: "payment_confirmed",
          contractStatus: "active",
          dunningState:
            state.contractStatus === "past_due" || state.contractStatus === "paused"
              ? "recovered"
              : "not_required",
          paymentId: requireNonEmpty(event.paymentId, "paymentId"),
          nextRetryAt: null,
          graceEndsAt: null,
        },
        event.at,
      );

    case "entitlement_activated":
      if (state.stage !== "payment_confirmed") {
        throw new Error("payment must be confirmed before entitlement activation");
      }
      return stamp(
        {
          ...state,
          stage: "active",
          contractStatus: "active",
          entitlementId: requireNonEmpty(event.entitlementId, "entitlementId"),
        },
        event.at,
      );

    case "payment_failed":
      if (event.graceEndsAt) {
        return dunningStateHandlers.gracePeriodStarted(
          state,
          event.graceEndsAt,
          event.at,
        );
      }
      return dunningStateHandlers.paymentRetryFailed(
        state,
        event.nextRetryAt,
        event.at,
      );

    case "payment_link_resent":
      return dunningStateHandlers.paymentLinkResent(
        state,
        event.paymentLink,
        event.at,
      );

    case "contract_paused":
      return dunningStateHandlers.contractPaused(state, event.at);

    case "contract_cancelled":
      return stamp(
        {
          ...state,
          stage: "cancelled",
          contractStatus: "cancelled",
          dunningState: "not_required",
          nextRetryAt: null,
          graceEndsAt: null,
        },
        event.at,
      );
  }
}
