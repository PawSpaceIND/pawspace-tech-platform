/**
 * Controlled unlock for the Razorpay webhook receiver. Provider-facing webhook processing uses the same
 * strict payment-environment parser as outbound order creation: missing or malformed declarations are a
 * configuration error and are refused before a webhook secret is selected.
 */
import{parsePaymentEnvironment,type PaymentEnvironment}from"./payment-environment";

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();
const liveApproved = (env: Env) => env?.PAWSPACE_PAYMENT_LIVE_APPROVED === "true";

export type WebhookGate =
  | { ok: true; environment: PaymentEnvironment; secret: string }
  | { ok: false; status: number; reason: string };

export function paymentMode(env: Env): PaymentEnvironment {
  return parsePaymentEnvironment(env);
}

export function resolvePaymentWebhookGate(env: Env): WebhookGate {
  let mode:PaymentEnvironment;
  try{mode=parsePaymentEnvironment(env);}catch(error){return{ok:false,status:503,reason:error instanceof Error?error.message:String(error)};}
  if (mode === "sandbox") {
    const secret = val(env, "RAZORPAY_WEBHOOK_SECRET_SANDBOX");
    if (!secret) return { ok: false, status: 503, reason: "Razorpay sandbox webhook secret is not configured (RAZORPAY_WEBHOOK_SECRET_SANDBOX)" };
    return { ok: true, environment: "sandbox", secret };
  }
  if (!liveApproved(env)) return { ok: false, status: 503, reason: "Live payments are not approved (PAWSPACE_PAYMENT_LIVE_APPROVED must equal exactly \"true\"). Unlock and verify in isolated staging first." };
  const secret = val(env, "RAZORPAY_WEBHOOK_SECRET_LIVE");
  if (!secret) return { ok: false, status: 503, reason: "Razorpay LIVE webhook secret is not configured (RAZORPAY_WEBHOOK_SECRET_LIVE)" };
  return { ok: true, environment: "live", secret };
}

/** Readiness for the ops/payments dashboard - reports what's configured WITHOUT exposing any secret. */
export function paymentWebhookReadiness(env: Env) {
  const gate = resolvePaymentWebhookGate(env);
  let mode:PaymentEnvironment|null=null;
  try{mode=parsePaymentEnvironment(env);}catch{}
  return {
    environment: mode,
    sandboxSecretConfigured: Boolean(val(env, "RAZORPAY_WEBHOOK_SECRET_SANDBOX")),
    liveApproved: liveApproved(env),
    liveSecretConfigured: Boolean(val(env, "RAZORPAY_WEBHOOK_SECRET_LIVE")),
    receiverReady: gate.ok,
    activeEnvironment: gate.ok ? gate.environment : null,
    blockedReason: gate.ok ? null : gate.reason,
  };
}
