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

/*
 * NO FRESHNESS WINDOW LIVES HERE, AND THAT IS DELIBERATE.
 *
 * An earlier version of this file rejected any signed body whose own created_at was more than five
 * minutes old. It closed the replay exposure and it was the wrong instrument for a payments receiver:
 * Razorpay retries a failed delivery for up to 24 hours, so a single 500 on our side during a capture
 * would have turned every subsequent retry into a 400 and lost the money event permanently. Trading a
 * dropped payment for a bounded replay window is the wrong trade in this pipeline.
 *
 * The replay exposure is closed by IDENTITY instead of by time, in acceptRazorpayWebhook: the inbox now
 * also recognises a body it has already accepted, by the SHA-256 of the signature-verified payload. A
 * genuine 20-hour-late retry carries a byte-identical body, is recognised as a redelivery of the
 * original event and is acknowledged; a replay carries the same byte-identical body and is recognised
 * the same way, whatever event id the caller puts in the header. Both are handled correctly, with no
 * clock involved and nothing to tune. See lib/financial-lifecycle.ts.
 */

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
