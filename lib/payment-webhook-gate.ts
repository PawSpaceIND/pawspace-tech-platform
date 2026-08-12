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
