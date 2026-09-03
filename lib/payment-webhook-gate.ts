/**
 * Controlled unlock for the Razorpay webhook receiver. The receiver defaults to SANDBOX and refuses to
 * process live events until live mode is deliberately unlocked - in an isolated, approved environment
 * first, never by accident.
 *
 * Resolution (fail-closed at every step):
 *   PAWSPACE_PAYMENT_ENV=sandbox (default) -> needs RAZORPAY_WEBHOOK_SECRET_SANDBOX. Uses the sandbox
 *     secret and stamps events environment="sandbox".
 *   PAWSPACE_PAYMENT_ENV=live               -> DOUBLE-gated. Needs BOTH an explicit approval flag
 *     (PAWSPACE_PAYMENT_LIVE_APPROVED="true") AND a distinct live secret (RAZORPAY_WEBHOOK_SECRET_LIVE).
 *     Either missing -> 503, nothing processed. Uses the live secret and stamps events environment="live".
 *
 * Live and sandbox secrets are separate keys, so unlocking live never reuses a sandbox credential, and
 * the approval flag makes "go live" a conscious, auditable switch you flip in staging before production.
 */

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();
const isTrue = (v: unknown) => String(v ?? "").trim().toLowerCase() === "true";

export type WebhookGate =
  | { ok: true; environment: "sandbox" | "live"; secret: string }
  | { ok: false; status: number; reason: string };

export function paymentMode(env: Env): "sandbox" | "live" {
  return val(env, "PAWSPACE_PAYMENT_ENV").toLowerCase() === "live" ? "live" : "sandbox";
}

export function resolvePaymentWebhookGate(env: Env): WebhookGate {
  if (paymentMode(env) === "sandbox") {
    const secret = val(env, "RAZORPAY_WEBHOOK_SECRET_SANDBOX");
    if (!secret) return { ok: false, status: 503, reason: "Razorpay sandbox webhook secret is not configured (RAZORPAY_WEBHOOK_SECRET_SANDBOX)" };
    return { ok: true, environment: "sandbox", secret };
  }
  // live: double-gated
  if (!isTrue(env?.PAWSPACE_PAYMENT_LIVE_APPROVED)) return { ok: false, status: 503, reason: "Live payments are not approved (set PAWSPACE_PAYMENT_LIVE_APPROVED=\"true\"). Unlock and verify in isolated staging first." };
  const secret = val(env, "RAZORPAY_WEBHOOK_SECRET_LIVE");
  if (!secret) return { ok: false, status: 503, reason: "Razorpay LIVE webhook secret is not configured (RAZORPAY_WEBHOOK_SECRET_LIVE)" };
  return { ok: true, environment: "live", secret };
}

/**
 * How far from now a signed webhook's own timestamp may sit before the receiver refuses it.
 *
 * WHY A WINDOW IS NEEDED AT ALL. The HMAC covers the request BODY. The replay key is the
 * `x-razorpay-event-id` HEADER, which both idempotency layers key on and which the signature does not
 * cover - so anyone holding one captured (body, signature) pair mints unlimited "new" events from it by
 * changing a header. The money paths survive that (capture and refund idempotency match on the gateway
 * payment/order/refund ids, which ARE inside the signed body), but nothing bounded the AGE of a replay:
 * created_at was parsed into the event and never compared to now, so a body captured once stayed
 * replayable forever, inflating the event log and re-running every side effect keyed on the event id.
 * A timestamp window is the standard bound, and it was the one control this receiver had no version of.
 *
 * Symmetric, because a clock ahead of ours is as unverifiable as one behind, and a far-future timestamp
 * would otherwise park an event that never expires.
 */
export const WEBHOOK_FRESHNESS_TOLERANCE_MS = 5 * 60_000;

export type WebhookFreshness = { fresh: true } | { fresh: false; reason: string; skewSeconds: number | null };

/**
 * Is this signed payload recent enough to act on?
 *
 * FAILS CLOSED ON AN ABSENT OR UNREADABLE TIMESTAMP, deliberately. Treating "no timestamp" as fresh
 * would make the window opt-out: a body with the field missing would be replayable forever, which is
 * the exact exposure being closed. Razorpay always sends created_at, so in practice this rejects only
 * a malformed delivery - and a malformed delivery is not something to act on either.
 *
 * `createdAtSeconds` is SECONDS since the epoch, which is what Razorpay sends.
 */
export function webhookEventFreshness(createdAtSeconds: unknown, now = Date.now()): WebhookFreshness {
  const seconds = Number(createdAtSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return { fresh: false, reason: "missing_event_timestamp", skewSeconds: null };
  const skew = now - seconds * 1000;
  if (Math.abs(skew) <= WEBHOOK_FRESHNESS_TOLERANCE_MS) return { fresh: true };
  return { fresh: false, reason: skew > 0 ? "stale_event_timestamp" : "future_event_timestamp", skewSeconds: Math.round(skew / 1000) };
}

/** Readiness for the ops/payments dashboard - reports what's configured WITHOUT exposing any secret. */
export function paymentWebhookReadiness(env: Env) {
  const mode = paymentMode(env), gate = resolvePaymentWebhookGate(env);
  return {
    environment: mode,
    sandboxSecretConfigured: Boolean(val(env, "RAZORPAY_WEBHOOK_SECRET_SANDBOX")),
    liveApproved: isTrue(env?.PAWSPACE_PAYMENT_LIVE_APPROVED),
    liveSecretConfigured: Boolean(val(env, "RAZORPAY_WEBHOOK_SECRET_LIVE")),
    receiverReady: gate.ok,
    activeEnvironment: gate.ok ? gate.environment : null,
    blockedReason: gate.ok ? null : gate.reason,
  };
}
