"use client";

import { useEffect, useMemo, useState } from "react";
import type { RenewalJourneyState } from "../renewal-journey";
import type { SubscriptionEntitlementSnapshot } from "../SubscriptionRenewalCheckout";

export interface DunningWalletView {
  id: string;
  customerId: string;
  customerName: string;
  planLabel: string;
  journey: RenewalJourneyState;
  entitlement: SubscriptionEntitlementSnapshot | null;
  amountDue: number | null;
  currency?: string;
  retryAttempt: number;
  maxRetryAttempts: number;
  autoRetryEnabled: boolean;
  lastFailureReason?: string | null;
}

export interface DunningManagementViewProps {
  wallets: DunningWalletView[];
  onRetryNow?: (wallet: DunningWalletView) => void | Promise<void>;
  onResendPaymentLink?: (wallet: DunningWalletView) => void | Promise<void>;
  onScheduleAutomaticRetry?: (wallet: DunningWalletView) => void | Promise<void>;
}

type DunningAction = "retry" | "resend" | "schedule";

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "Not configured";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(Math.max(0, value));
}

function formatDate(value: string | null): string {
  const parsed = parseTime(value);
  if (parsed === null) return "Not scheduled";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function formatCountdown(deadline: string | null, now: number): string {
  const target = parseTime(deadline);
  if (target === null) return "No grace deadline";
  const remaining = target - now;
  if (remaining <= 0) return "Grace expired";
  const totalMinutes = Math.floor(remaining / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${hours}h ${minutes}m remaining`;
}

function pastDue(wallet: DunningWalletView): boolean {
  return ["past_due", "paused"].includes(wallet.journey.contractStatus) && wallet.journey.stage !== "cancelled";
}

export default function DunningManagementView({
  wallets,
  onRetryNow,
  onResendPaymentLink,
  onScheduleAutomaticRetry,
}: DunningManagementViewProps) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const pastDueWallets = useMemo(
    () => wallets.filter(pastDue).sort((left, right) => {
      const leftGrace = parseTime(left.journey.graceEndsAt) ?? Number.MAX_SAFE_INTEGER;
      const rightGrace = parseTime(right.journey.graceEndsAt) ?? Number.MAX_SAFE_INTEGER;
      return leftGrace - rightGrace || (right.amountDue ?? 0) - (left.amountDue ?? 0);
    }),
    [wallets],
  );

  async function runAction(action: DunningAction, wallet: DunningWalletView) {
    const handler = action === "retry" ? onRetryNow : action === "resend" ? onResendPaymentLink : onScheduleAutomaticRetry;
    if (!handler) return;
    const key = `${action}:${wallet.id}`;
    setBusy(key);
    try { await handler(wallet); } finally { setBusy(null); }
  }

  return (
    <section className="mx-auto w-full max-w-6xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-5">
        <div>
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">V2 Subscription Dunning</span>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">Past-due wallet management</h1>
          <p className="mt-1 text-sm text-slate-600">Grace windows and governed retry actions. UI actions never fabricate payment success.</p>
        </div>
        <div className="rounded-2xl bg-amber-50 px-4 py-3 text-right">
          <strong className="block text-2xl text-amber-950">{pastDueWallets.length}</strong>
          <small className="text-amber-800">Past due / paused</small>
        </div>
      </header>

      {pastDueWallets.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-600">No past-due subscription wallets require action.</div>
      ) : (
        <div className="mt-6 space-y-4">
          {pastDueWallets.map((wallet) => {
            const exhausted = wallet.retryAttempt >= wallet.maxRetryAttempts;
            const grace = formatCountdown(wallet.journey.graceEndsAt, now);
            return (
              <article key={wallet.id} className="rounded-2xl border border-slate-200 p-5">
                <div className="flex flex-wrap justify-between gap-4">
                  <div>
                    <span className="text-xs font-semibold uppercase text-slate-500">{wallet.customerId}</span>
                    <h2 className="mt-1 text-lg font-semibold text-slate-950">{wallet.customerName} · {wallet.planLabel}</h2>
                    <p className="mt-1 text-sm text-slate-600">{wallet.entitlement?.serviceCode.replaceAll("_", " ") ?? "Subscription"} · {wallet.journey.dunningState.replaceAll("_", " ")}</p>
                  </div>
                  <div className="text-right">
                    <strong className="block text-lg text-slate-950">{formatMoney(wallet.amountDue, wallet.currency ?? "INR")}</strong>
                    <small className="text-slate-500">Amount due</small>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl bg-amber-50 p-3"><small className="font-semibold text-amber-800">Grace period</small><strong className="mt-1 block text-sm text-amber-950">{grace}</strong></div>
                  <div className="rounded-xl bg-slate-50 p-3"><small className="font-semibold text-slate-600">Next automatic retry</small><strong className="mt-1 block text-sm text-slate-950">{wallet.autoRetryEnabled ? formatDate(wallet.journey.nextRetryAt) : "Automatic retry disabled"}</strong></div>
                  <div className="rounded-xl bg-slate-50 p-3"><small className="font-semibold text-slate-600">Retry attempts</small><strong className="mt-1 block text-sm text-slate-950">{wallet.retryAttempt} / {wallet.maxRetryAttempts}</strong></div>
                </div>

                {wallet.lastFailureReason && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">Last failure: {wallet.lastFailureReason}</p>}

                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" disabled={!onRetryNow || exhausted || busy !== null} onClick={() => void runAction("retry", wallet)} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{busy === `retry:${wallet.id}` ? "Retrying..." : "Retry now"}</button>
                  <button type="button" disabled={!onResendPaymentLink || busy !== null} onClick={() => void runAction("resend", wallet)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-40">{busy === `resend:${wallet.id}` ? "Sending..." : "Resend payment link"}</button>
                  <button type="button" disabled={!onScheduleAutomaticRetry || exhausted || wallet.autoRetryEnabled || busy !== null} onClick={() => void runAction("schedule", wallet)} className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-950 disabled:cursor-not-allowed disabled:opacity-40">{busy === `schedule:${wallet.id}` ? "Scheduling..." : wallet.autoRetryEnabled ? "Automatic retry scheduled" : "Schedule automatic retry"}</button>
                </div>

                <p className="mt-3 text-xs leading-5 text-slate-500">Retry controls delegate to the billing owner through callbacks. The view never marks payment verified or entitlement active on its own.</p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
