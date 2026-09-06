import type { RenewalJourneyState } from "./renewal-journey";

interface RenewalCheckoutProps {
  journey: RenewalJourneyState;
  planLabel: string;
  renewalAmount: number;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Math.max(0, value));
}

function formatTime(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function dunningCopy(journey: RenewalJourneyState): string | null {
  switch (journey.dunningState) {
    case "retry_scheduled":
      return journey.nextRetryAt
        ? `Payment retry scheduled for ${formatTime(journey.nextRetryAt) ?? "the next retry window"}.`
        : "Payment is past due. The billing engine will schedule the next governed retry.";
    case "grace_period":
      return journey.graceEndsAt
        ? `Payment is past due. Service grace remains active until ${formatTime(journey.graceEndsAt) ?? "the configured grace deadline"}.`
        : "Payment is past due and the configured grace-period policy is active.";
    case "payment_link_resent":
      return "A fresh one-tap renewal link has been issued for payment recovery.";
    case "recovered":
      return "Past-due payment recovered. Entitlement activation is being finalized.";
    case "paused":
      return "Automatic collection is paused after dunning. Restore payment before reactivation.";
    case "not_required":
      return null;
  }
}

export function RenewalCheckout({
  journey,
  planLabel,
  renewalAmount,
}: RenewalCheckoutProps) {
  const recoveryMessage = dunningCopy(journey);
  const paymentLinkUsable =
    journey.paymentLink !== null &&
    !["active", "cancelled"].includes(journey.stage);

  return (
    <section className="mx-auto w-full max-w-3xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-col gap-2 border-b border-slate-100 pb-5">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
          Automated Subscription Renewal
        </span>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">{planLabel}</h1>
            <p className="mt-1 text-sm text-slate-600">
              Renewal amount {formatMoney(renewalAmount)}
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700">
            {journey.contractStatus.replaceAll("_", " ")}
          </span>
        </div>
      </header>

      <ol className="mt-6 grid gap-4 md:grid-cols-3" aria-label="Renewal progress">
        <li className="rounded-2xl border border-slate-200 p-4">
          <span className="text-xs font-semibold text-slate-500">1 · MESSAGE</span>
          <strong className="mt-2 block text-sm text-slate-900">
            {journey.messageId ? "Renewal message sent" : "Renewal message queued"}
          </strong>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Customer receives the governed renewal prompt before payment collection.
          </p>
        </li>

        <li className="rounded-2xl border border-slate-200 p-4">
          <span className="text-xs font-semibold text-slate-500">2 · ONE-TAP PAYMENT</span>
          <strong className="mt-2 block text-sm text-slate-900">
            {journey.paymentLink ? "Secure payment link ready" : "Awaiting payment link"}
          </strong>
          {paymentLinkUsable && journey.paymentLink ? (
            <a
              className="mt-3 inline-flex rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white"
              href={journey.paymentLink.url}
              rel="noopener noreferrer"
            >
              Renew in one tap
            </a>
          ) : (
            <p className="mt-1 text-xs leading-5 text-slate-600">
              No customer card data is stored in this UI contract.
            </p>
          )}
        </li>

        <li className="rounded-2xl border border-slate-200 p-4">
          <span className="text-xs font-semibold text-slate-500">3 · ENTITLEMENT</span>
          <strong className="mt-2 block text-sm text-slate-900">
            {journey.stage === "active"
              ? "Entitlement active"
              : journey.stage === "payment_confirmed"
                ? "Payment confirmed"
                : "Pending successful payment"}
          </strong>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {journey.entitlementId
              ? `Entitlement ${journey.entitlementId} is active.`
              : "Activation occurs only after confirmed payment and entitlement creation."}
          </p>
        </li>
      </ol>

      {recoveryMessage && (
        <aside
          className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4"
          aria-live="polite"
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            Payment recovery
          </span>
          <p className="mt-1 text-sm leading-6 text-amber-950">{recoveryMessage}</p>
        </aside>
      )}

      <footer className="mt-5 text-xs leading-5 text-slate-500">
        Contract {journey.contractId} · Journey updated {formatTime(journey.updatedAt) ?? journey.updatedAt}
      </footer>
    </section>
  );
}
