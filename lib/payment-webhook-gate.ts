/**
 * Controlled unlock for the Razorpay webhook receiver. Provider-facing webhook processing uses the same
 * strict payment-environment parser as outbound order creation: missing or malformed declarations are a
 * configuration error and are refused before a webhook secret is selected.
 */
import{parsePaymentEnvironment}from"./payment-environment";

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();
const isTrue = (v: unknown) => String(v ?? "").trim().toLowerCase() === "true";

export type WebhookGate =
  | { ok: true; environment: "sandbox" | "live"; secret: string }
  | { ok: false; status: number; reason: string };

/** Legacy diagnostic helper; authorization is performed by resolvePaymentWebhookGate(). */
export function paymentMode(env: Env): "sandbox" | "live" {
  return val(env, "PAWSPACE_PAYMENT_ENV").toLowerCase() === "live" ? "live" : "sandbox";
}

export function resolvePaymentWebhookGate(env: Env): WebhookGate {
  let mode:"sandbox"|"live";
  try{mode=parsePaymentEnvironment(env);}catch(error){return{ok:false,status:503,reason:error instanceof Error?error.message:String(error)};}
  if (mode === "sandbox") {
    const secret = val(env, "RAZORPAY_WEBHOOK_SECRET_SANDBOX");
    if (!secret) return { ok: false, status: 503, reason: "Razorpay sandbox webhook secret is not configured (RAZORPAY_WEBHOOK_SECRET_SANDBOX)" };
    return { ok: true, environment: "sandbox", secret };
  }
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
