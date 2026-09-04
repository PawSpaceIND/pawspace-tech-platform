import type { CSSProperties } from "react";
import {
  unifiedRenewalJourneyTransitions,
  type UnifiedRenewalJourney,
  type UnifiedRenewalJourneyState,
} from "@/lib/types/subscription-renewal";

export interface SubscriptionEntitlementView {
  entitlementId: string;
  householdId: string;
  serviceCode: string;
  totalCredits: number;
  consumedCredits: number;
  status: string;
  expiryDate: string;
}

export interface SubscriptionRenewalCheckoutProps {
  journey: UnifiedRenewalJourney;
  householdName?: string;
  paymentLinkUrl?: string | null;
  entitlement?: SubscriptionEntitlementView | null;
}

const RENEWAL_STEPS: ReadonlyArray<{
  state: UnifiedRenewalJourneyState;
  label: string;
  detail: string;
}> = [
  { state: "message_sent", label: "Message Sent", detail: "Renewal message delivered through the governed retention workflow." },
  { state: "link_clicked", label: "Link Clicked", detail: "Customer opened the approved renewal payment link." },
  { state: "payment_verified", label: "Payment Verified", detail: "Payment has been verified before entitlement activation." },
  { state: "entitlement_active", label: "Entitlement Active", detail: "Renewed service entitlement is active and available for use." },
];

const shell: CSSProperties = {
  background: "#f7f4fb",
  color: "#24133f",
  fontFamily: "Arial, sans-serif",
  padding: 24,
};
const panel: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5dced",
  borderRadius: 18,
  boxShadow: "0 16px 42px rgba(54, 29, 85, 0.06)",
};
const muted: CSSProperties = { color: "#756c7e" };

function pretty(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Invalid expiry date";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
}

function safePaymentLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function stepState(index: number, currentIndex: number): "complete" | "current" | "pending" {
  if (index < currentIndex) return "complete";
  if (index === currentIndex) return "current";
  return "pending";
}

export default function SubscriptionRenewalCheckout({
  journey,
  householdName,
  paymentLinkUrl,
  entitlement,
}: SubscriptionRenewalCheckoutProps) {
  const currentIndex = RENEWAL_STEPS.findIndex((step) => step.state === journey.state);
  const nextState = unifiedRenewalJourneyTransitions[journey.state][0] ?? null;
  const paymentHref = safePaymentLink(paymentLinkUrl);
  const remainingCredits = entitlement
    ? Math.max(0, entitlement.totalCredits - entitlement.consumedCredits)
    : null;

  return (
    <section style={shell} aria-labelledby="subscription-renewal-title">
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ marginBottom: 18 }}>
          <span style={{ color: "#6c39a8", fontSize: 12, fontWeight: 800, letterSpacing: "0.08em" }}>
            V2 · SUBSCRIPTION RETENTION
          </span>
          <h1 id="subscription-renewal-title" style={{ fontSize: 36, margin: "7px 0 8px" }}>
            Subscription Renewal Checkout
          </h1>
          <p style={{ ...muted, margin: 0, lineHeight: 1.5 }}>
            Messaging-to-payment-link renewal with verified entitlement activation. Payment completion alone never implies an active entitlement.
          </p>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.45fr) minmax(300px, 0.8fr)", gap: 16 }}>
          <article style={{ ...panel, padding: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 20 }}>
              <div>
                <small style={muted}>HOUSEHOLD</small>
                <h2 style={{ margin: "4px 0 3px", fontSize: 22 }}>{householdName || journey.householdId}</h2>
                <span style={{ ...muted, fontSize: 13 }}>{pretty(journey.serviceCode)}</span>
              </div>
              <span style={{ background: "#f1eafa", borderRadius: 999, color: "#5f2d97", fontSize: 12, fontWeight: 800, padding: "7px 10px" }}>
                {pretty(journey.state)}
              </span>
            </div>

            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {RENEWAL_STEPS.map((step, index) => {
                const status = stepState(index, currentIndex);
                const complete = status === "complete";
                const current = status === "current";
                return (
                  <li key={step.state} aria-current={current ? "step" : undefined} style={{ display: "grid", gridTemplateColumns: "42px 1fr", gap: 12, alignItems: "start", border: current ? "1px solid #bca4d8" : "1px solid #ece5f1", background: complete ? "#f4fbf7" : current ? "#faf7fd" : "#ffffff", borderRadius: 13, padding: 13 }}>
                    <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: "50%", display: "grid", placeItems: "center", background: complete ? "#dff5e8" : current ? "#5c2396" : "#eee8f2", color: complete ? "#176238" : current ? "#ffffff" : "#766d7f", fontWeight: 800 }}>
                      {complete ? "✓" : index + 1}
                    </span>
                    <div>
                      <strong>{step.label}</strong>
                      <p style={{ ...muted, fontSize: 13, lineHeight: 1.45, margin: "4px 0 0" }}>{step.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div style={{ borderTop: "1px solid #eee8f2", marginTop: 18, paddingTop: 16, display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <small style={muted}>NEXT GOVERNED STATE</small>
                <strong style={{ display: "block", marginTop: 3 }}>{nextState ? pretty(nextState) : "Journey complete"}</strong>
              </div>
              {paymentHref && (journey.state === "message_sent" || journey.state === "link_clicked") ? (
                <a href={paymentHref} target="_blank" rel="noreferrer" style={{ background: "#4b168c", borderRadius: 10, color: "#ffffff", fontWeight: 800, padding: "11px 14px", textDecoration: "none" }}>
                  Open renewal payment link
                </a>
              ) : journey.state === "message_sent" || journey.state === "link_clicked" ? (
                <span style={{ background: "#fff4df", borderRadius: 10, color: "#8a5907", fontSize: 12, fontWeight: 700, padding: "10px 12px" }}>
                  Approved HTTPS payment link not available
                </span>
              ) : null}
            </div>
          </article>

          <aside style={{ ...panel, padding: 22 }} aria-label="Active entitlement state">
            <span style={{ color: "#6c39a8", fontSize: 12, fontWeight: 800 }}>ACTIVE ENTITLEMENT</span>
            {!entitlement ? (
              <div style={{ border: "1px dashed #d9cde4", borderRadius: 12, marginTop: 14, padding: 18 }}>
                <strong>{journey.state === "entitlement_active" ? "Entitlement record pending reconciliation" : "Not active yet"}</strong>
                <p style={{ ...muted, fontSize: 13, lineHeight: 1.45, margin: "6px 0 0" }}>
                  The UI does not infer credits or activation from the payment journey. A canonical entitlement record must be supplied.
                </p>
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <h2 style={{ margin: "0 0 4px", fontSize: 24 }}>{pretty(entitlement.serviceCode)}</h2>
                <span style={{ display: "inline-block", background: entitlement.status === "active" ? "#e7f7ed" : "#f1edf3", borderRadius: 999, color: entitlement.status === "active" ? "#176238" : "#655b6d", fontSize: 11, fontWeight: 800, padding: "6px 8px" }}>
                  {pretty(entitlement.status)}
                </span>
                <dl style={{ display: "grid", gap: 12, margin: "20px 0 0" }}>
                  <div><dt style={{ ...muted, fontSize: 11 }}>Remaining credits</dt><dd style={{ fontSize: 28, fontWeight: 800, margin: "3px 0 0" }}>{remainingCredits}</dd></div>
                  <div><dt style={{ ...muted, fontSize: 11 }}>Credit usage</dt><dd style={{ margin: "3px 0 0" }}>{entitlement.consumedCredits} consumed of {entitlement.totalCredits}</dd></div>
                  <div><dt style={{ ...muted, fontSize: 11 }}>Expiry</dt><dd style={{ margin: "3px 0 0" }}>{formatDate(entitlement.expiryDate)}</dd></div>
                  <div><dt style={{ ...muted, fontSize: 11 }}>Entitlement ID</dt><dd style={{ margin: "3px 0 0", overflowWrap: "anywhere" }}>{entitlement.entitlementId}</dd></div>
                </dl>
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}
