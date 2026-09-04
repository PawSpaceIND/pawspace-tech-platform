"use client";

import { useMemo, useState } from "react";
import type { RenewalJourneyState } from "./renewal-journey";

export const UNIFIED_RENEWAL_JOURNEY_STAGES = [
  "message_sent",
  "link_clicked",
  "payment_verified",
  "entitlement_active",
] as const;

export type UnifiedRenewalJourneyStage = (typeof UNIFIED_RENEWAL_JOURNEY_STAGES)[number];
export type UnifiedRenewalStepStatus = "complete" | "current" | "pending";

export interface UnifiedRenewalJourneyStep {
  stage: UnifiedRenewalJourneyStage;
  label: "Message Sent" | "Link Clicked" | "Payment Verified" | "Entitlement Active";
  status: UnifiedRenewalStepStatus;
  at: number | null;
}

export interface UnifiedRenewalJourney {
  contractId: string;
  currentStage: UnifiedRenewalJourneyStage;
  steps: UnifiedRenewalJourneyStep[];
}

export type SubscriptionEntitlementStatus =
  | "pending"
  | "active"
  | "paused"
  | "exhausted"
  | "expired"
  | "suspended"
  | "cancelled";

export interface SubscriptionEntitlementSnapshot {
  id: string;
  serviceCode: string;
  planCode: string;
  planVersion: string;
  entitlementScope: "customer" | "pet" | "household";
  unitType: "session" | "visit" | "day" | "walk" | "credit" | "other";
  totalUnits: number;
  reservedUnits: number;
  consumedUnits: number;
  releasedUnits: number;
  status: SubscriptionEntitlementStatus;
  startedAt: number;
  expiresAt: number | null;
  graceEndsAt: number | null;
  renewalWindowStartsAt: number | null;
}

export interface SubscriptionRenewalCheckoutProps {
  journey: RenewalJourneyState;
  entitlement: SubscriptionEntitlementSnapshot | null;
  planLabel: string;
  renewalAmount: number | null;
  currency?: string;
  linkClickedAt?: number | null;
  onPaymentLinkClick?: (input: {
    contractId: string;
    providerReference: string;
    clickedAt: number;
  }) => void | Promise<void>;
}

const STAGE_LABELS: Record<UnifiedRenewalJourneyStage, UnifiedRenewalJourneyStep["label"]> = {
  message_sent: "Message Sent",
  link_clicked: "Link Clicked",
  payment_verified: "Payment Verified",
  entitlement_active: "Entitlement Active",
};

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatDate(value: number | null): string {
  if (value === null) return "Not recorded";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "Not configured";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Math.max(0, value));
}

export function buildUnifiedRenewalJourney(
  journey: RenewalJourneyState,
  linkClickedAt: number | null,
): UnifiedRenewalJourney {
  const messageComplete = Boolean(journey.messageId) || !["message_pending", "cancelled"].includes(journey.stage);
  const linkComplete =
    linkClickedAt !== null ||
    ["payment_pending", "payment_confirmed", "active"].includes(journey.stage);
  const paymentComplete =
    Boolean(journey.paymentId) && ["payment_confirmed", "active"].includes(journey.stage);
  const entitlementComplete = journey.stage === "active" && Boolean(journey.entitlementId);
  const completed = [messageComplete, linkComplete, paymentComplete, entitlementComplete];
  const firstIncomplete = completed.findIndex((value) => !value);
  const currentIndex = firstIncomplete === -1 ? completed.length - 1 : firstIncomplete;

  const eventTimes: Array<number | null> = [
    messageComplete ? timestamp(journey.updatedAt) : null,
    linkComplete ? linkClickedAt : null,
    paymentComplete ? timestamp(journey.updatedAt) : null,
    entitlementComplete ? timestamp(journey.updatedAt) : null,
  ];

  const steps = UNIFIED_RENEWAL_JOURNEY_STAGES.map((stage, index) => ({
    stage,
    label: STAGE_LABELS[stage],
    status: completed[index] ? "complete" : index === currentIndex ? "current" : "pending",
    at: eventTimes[index],
  })) satisfies UnifiedRenewalJourneyStep[];

  return { contractId: journey.contractId, currentStage: steps[currentIndex].stage, steps };
}

function balance(entitlement: SubscriptionEntitlementSnapshot): number {
  return Math.max(0, entitlement.totalUnits - entitlement.reservedUnits - entitlement.consumedUnits);
}

export default function SubscriptionRenewalCheckout({
  journey,
  entitlement,
  planLabel,
  renewalAmount,
  currency = "INR",
  linkClickedAt = null,
  onPaymentLinkClick,
}: SubscriptionRenewalCheckoutProps) {
  const [localClickedAt, setLocalClickedAt] = useState<number | null>(linkClickedAt);
  const [rejectedPaymentLink, setRejectedPaymentLink] = useState<string | null>(null);
  const effectiveClickedAt = linkClickedAt ?? localClickedAt;
  const unified = useMemo(
    () => buildUnifiedRenewalJourney(journey, effectiveClickedAt),
    [effectiveClickedAt, journey],
  );
  const paymentLinkRejected =
    journey.paymentLink !== null &&
    journey.paymentLink.providerReference === rejectedPaymentLink;
  const paymentLinkEnabled =
    journey.paymentLink !== null &&
    !paymentLinkRejected &&
    !["active", "cancelled"].includes(journey.stage);

  async function recordLinkClick(clickedAt: number) {
    if (!journey.paymentLink) return;
    setLocalClickedAt(clickedAt);
    await onPaymentLinkClick?.({
      contractId: journey.contractId,
      providerReference: journey.paymentLink.providerReference,
      clickedAt,
    });
  }

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
        <div>
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">V2 Subscription Renewal</span>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">{planLabel}</h1>
          <p className="mt-1 text-sm text-slate-600">One-tap renewal with payment and entitlement truth kept separate.</p>
        </div>
        <div className="text-right">
          <strong className="text-xl text-slate-950">{formatMoney(renewalAmount, currency)}</strong>
          <span className="block text-xs uppercase tracking-wide text-slate-500">Renewal amount</span>
        </div>
      </header>

      <ol className="grid gap-3 md:grid-cols-4" aria-label="UnifiedRenewalJourney">
        {unified.steps.map((step, index) => (
          <li
            key={step.stage}
            aria-current={step.status === "current" ? "step" : undefined}
            className={`rounded-2xl border p-4 ${step.status === "complete" ? "border-emerald-200 bg-emerald-50" : step.status === "current" ? "border-violet-300 bg-violet-50" : "border-slate-200 bg-slate-50"}`}
          >
            <span className="text-xs font-semibold text-slate-500">{index + 1}</span>
            <strong className="mt-2 block text-sm text-slate-950">{step.label}</strong>
            <small className="mt-1 block text-slate-600">{step.status === "complete" ? formatDate(step.at) : step.status === "current" ? "In progress" : "Pending"}</small>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-2xl border border-slate-200 p-5">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">One-tap payment</span>
          <h2 className="mt-2 text-lg font-semibold text-slate-950">{paymentLinkEnabled ? "Secure link ready" : journey.stage === "active" ? "Renewal complete" : "Payment link unavailable"}</h2>
          {paymentLinkEnabled && journey.paymentLink ? (
            <a
              className="mt-4 inline-flex rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white"
              href={journey.paymentLink.url}
              rel="noopener noreferrer"
              onClick={(event) => {
                const clickedAt = Date.now();
                const expiresAt = Date.parse(journey.paymentLink!.expiresAt);
                if (Number.isNaN(expiresAt) || expiresAt <= clickedAt) {
                  event.preventDefault();
                  setRejectedPaymentLink(journey.paymentLink!.providerReference);
                  return;
                }
                setRejectedPaymentLink(null);
                void recordLinkClick(clickedAt);
              }}
            >
              Renew in one tap
            </a>
          ) : (
            <p className="mt-2 text-sm text-slate-600">{paymentLinkRejected ? "The current payment link is expired or invalid; request a governed replacement." : "A verified payment link will appear here when issued."}</p>
          )}
          <p className="mt-3 text-xs leading-5 text-slate-500">Opening the link records customer interaction only. Payment Verified is shown only when the upstream renewal journey reports confirmed payment.</p>
        </article>

        <article className="rounded-2xl border border-slate-200 p-5">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active entitlement</span>
          {entitlement ? (
            <>
              <div className="mt-2 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-950">{entitlement.serviceCode.replaceAll("_", " ")}</h2>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase text-slate-700">{entitlement.status}</span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 p-3"><strong className="block text-lg">{balance(entitlement)}</strong><small>Available</small></div>
                <div className="rounded-xl bg-slate-50 p-3"><strong className="block text-lg">{entitlement.reservedUnits}</strong><small>Reserved</small></div>
                <div className="rounded-xl bg-slate-50 p-3"><strong className="block text-lg">{entitlement.consumedUnits}</strong><small>Consumed</small></div>
              </div>
              <p className="mt-3 text-xs text-slate-500">Plan {entitlement.planCode} v{entitlement.planVersion} · Expires {formatDate(entitlement.expiresAt)}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-600">No entitlement snapshot is active yet. Activation must follow verified payment.</p>
          )}
        </article>
      </div>
    </section>
  );
}
