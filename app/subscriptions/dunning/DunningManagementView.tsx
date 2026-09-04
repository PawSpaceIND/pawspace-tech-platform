"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  defaultSubscriptionDunningPolicy,
  evaluateSubscriptionDunning,
  type PastDueSubscriptionWallet,
  type SubscriptionDunningEvaluation,
  type SubscriptionDunningPolicy,
} from "@/lib/services/subscription-dunning-engine";

export interface DunningWalletView extends PastDueSubscriptionWallet {
  householdName?: string;
  serviceLabel?: string;
}

export interface DunningManagementViewProps {
  wallets: DunningWalletView[];
  policy?: SubscriptionDunningPolicy;
}

type EvaluatedWallet = {
  wallet: DunningWalletView;
  evaluation: SubscriptionDunningEvaluation | null;
  error: string | null;
};

const shell: CSSProperties = {
  background: "#f7f4fb",
  color: "#24133f",
  fontFamily: "Arial, sans-serif",
  padding: 24,
};
const card: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5dced",
  borderRadius: 16,
};
const muted: CSSProperties = { color: "#756c7e" };

function pretty(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value: number | null): string {
  if (value == null) return "Not scheduled";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function countdown(target: number | null, now: number): string {
  if (target == null) return "No active grace timer";
  const remaining = target - now;
  if (remaining <= 0) return "Expired";
  const totalMinutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function evaluateWallet(
  wallet: DunningWalletView,
  policy: SubscriptionDunningPolicy,
  now: number,
): EvaluatedWallet {
  try {
    return { wallet, evaluation: evaluateSubscriptionDunning(wallet, policy, now), error: null };
  } catch (cause) {
    return {
      wallet,
      evaluation: null,
      error: cause instanceof Error ? cause.message : "Dunning evaluation failed",
    };
  }
}

function retryStatus(evaluation: SubscriptionDunningEvaluation | null, error: string | null): string {
  if (error) return "Review required";
  if (!evaluation) return "Calculating";
  if (evaluation.triggers.includes("grace_period_expired")) return "Fail-closed";
  if (evaluation.triggers.includes("retry_payment")) return "Retry due";
  if (evaluation.nextRetryAt != null) return "Retry scheduled";
  return "No retry due";
}

function statusStyle(status: string): CSSProperties {
  if (status === "active") return { background: "#e7f7ed", color: "#176238" };
  if (status === "past_due" || status === "grace") return { background: "#fff1d9", color: "#8b5908" };
  return { background: "#f5e7e9", color: "#8c2f39" };
}

export default function DunningManagementView({
  wallets,
  policy = defaultSubscriptionDunningPolicy,
}: DunningManagementViewProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    const initial = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  const evaluated = useMemo<EvaluatedWallet[]>(() => {
    if (now == null) return wallets.map((wallet) => ({ wallet, evaluation: null, error: null }));
    return wallets.map((wallet) => evaluateWallet(wallet, policy, now));
  }, [now, policy, wallets]);

  const pastDueCount = wallets.filter((wallet) => wallet.status === "past_due" || wallet.status === "grace").length;
  const retryDueCount = evaluated.filter(({ evaluation }) => evaluation?.triggers.includes("retry_payment")).length;
  const failClosedCount = evaluated.filter(({ evaluation }) => evaluation?.triggers.includes("grace_period_expired")).length;

  return (
    <section style={shell} aria-labelledby="dunning-management-title">
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 18 }}>
          <div>
            <span style={{ color: "#6c39a8", fontSize: 12, fontWeight: 800, letterSpacing: "0.08em" }}>
              V2 · RETENTION OPERATIONS
            </span>
            <h1 id="dunning-management-title" style={{ fontSize: 36, margin: "7px 0 8px" }}>
              Dunning & Past-Due Management
            </h1>
            <p style={{ ...muted, margin: 0, lineHeight: 1.5 }}>
              Governed grace periods and retry timing are calculated by the shared subscription dunning engine; the UI does not maintain a parallel policy.
            </p>
          </div>
          <small style={muted}>Clock refreshes every minute</small>
        </header>

        <section aria-label="Dunning summary" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
          {[
            ["Past-due / grace wallets", pastDueCount],
            ["Retries due now", retryDueCount],
            ["Fail-closed after grace", failClosedCount],
          ].map(([label, value]) => (
            <article key={String(label)} style={{ ...card, padding: 18 }}>
              <span style={{ ...muted, fontSize: 12, fontWeight: 700 }}>{label}</span>
              <strong style={{ display: "block", fontSize: 32, marginTop: 6 }}>{value}</strong>
            </article>
          ))}
        </section>

        <article style={{ ...card, overflow: "hidden" }}>
          <header style={{ borderBottom: "1px solid #eee8f2", padding: "18px 20px" }}>
            <strong>Subscription wallets</strong>
            <span style={{ ...muted, display: "block", fontSize: 12, marginTop: 4 }}>
              Grace policy: {policy.gracePeriodDays} days · retry offsets {policy.retryOffsetsDays.join(", ")} day(s) · maximum {policy.maxRetries} retries
            </span>
          </header>

          {evaluated.map(({ wallet, evaluation, error }) => {
            const automation = retryStatus(evaluation, error);
            const isFailClosed = evaluation?.triggers.includes("grace_period_expired") ?? false;
            return (
              <section key={wallet.entitlementId} style={{ borderBottom: "1px solid #f0ebf4", padding: 18 }} aria-label={`${wallet.householdName || wallet.householdId} ${wallet.serviceLabel || wallet.serviceCode}`}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1.1fr) minmax(120px, 0.7fr) minmax(190px, 1fr) minmax(170px, 0.9fr) minmax(170px, 0.9fr)", gap: 16, alignItems: "center" }}>
                  <div>
                    <strong>{wallet.householdName || wallet.householdId}</strong>
                    <span style={{ ...muted, display: "block", fontSize: 12, marginTop: 4 }}>{wallet.serviceLabel || pretty(wallet.serviceCode)}</span>
                    <small style={{ ...muted, display: "block", marginTop: 3 }}>{wallet.entitlementId}</small>
                  </div>

                  <div>
                    <span style={{ ...statusStyle(wallet.status), display: "inline-block", borderRadius: 999, fontSize: 11, fontWeight: 800, padding: "6px 8px" }}>
                      {pretty(wallet.status)}
                    </span>
                    <small style={{ ...muted, display: "block", marginTop: 5 }}>Expired {wallet.expiryDate}</small>
                  </div>

                  <div>
                    <small style={muted}>GRACE PERIOD TIMER</small>
                    <strong style={{ display: "block", marginTop: 4, color: isFailClosed ? "#8c2f39" : undefined }}>
                      {now == null ? "Initializing timer…" : countdown(evaluation?.graceEndsAt ?? null, now)}
                    </strong>
                    {evaluation?.graceEndsAt != null && <small style={{ ...muted, display: "block", marginTop: 3 }}>Ends {formatDateTime(evaluation.graceEndsAt)}</small>}
                  </div>

                  <div>
                    <small style={muted}>AUTOMATED RETRY</small>
                    <strong style={{ display: "block", marginTop: 4 }}>{automation}</strong>
                    <span style={{ ...muted, display: "block", fontSize: 12, marginTop: 3 }}>Attempt {wallet.retryCount} of {policy.maxRetries}</span>
                    <small style={{ ...muted, display: "block", marginTop: 3 }}>Next: {formatDateTime(evaluation?.nextRetryAt ?? null)}</small>
                  </div>

                  <div>
                    <small style={muted}>GOVERNED ACTION</small>
                    <strong style={{ display: "block", marginTop: 4, color: isFailClosed ? "#8c2f39" : undefined }}>
                      {evaluation?.triggers.length ? evaluation.triggers.map(pretty).join(" · ") : "No action due"}
                    </strong>
                    <span style={{ ...muted, display: "block", fontSize: 12, lineHeight: 1.4, marginTop: 4 }}>
                      {error || evaluation?.reason || "Waiting for the dunning clock."}
                    </span>
                  </div>
                </div>
              </section>
            );
          })}

          {evaluated.length === 0 && (
            <div style={{ padding: 28, textAlign: "center" }}>
              <strong>No subscription wallets require dunning review.</strong>
              <p style={{ ...muted, fontSize: 13, margin: "6px 0 0" }}>Past-due, grace, suspended, or cancelled wallets will appear when supplied by the retention data source.</p>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
