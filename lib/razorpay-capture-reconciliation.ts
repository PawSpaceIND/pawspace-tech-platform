import { commitRazorpayCaptureAtomic, executeRazorpayCapturePostCommit } from "./razorpay-capture-atomic";
import { fetchPaymentOrderPayments, paymentEnvironment } from "./razorpay-client";
import { ensurePaymentReconciliationTables } from "./grooming-payment-reconciliation";

type Db = D1Database;
type Row = Record<string, unknown>;
type Env = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function capturedPaymentForIntent(intent: Row, payments: Record<string, unknown>[]) {
  const orderId = text(intent.gateway_order_id), amount = Number(intent.amount_paise), currency = text(intent.currency || "INR");
  const captured = payments.filter(payment => text(payment.order_id) === orderId && (text(payment.status) === "captured" || payment.captured === true));
  if (captured.length === 0) return null;
  if (captured.length !== 1) throw new Error(`Razorpay order ${orderId} has ${captured.length} captured payments; automatic reconciliation is ambiguous`);
  const payment = captured[0], paymentId = text(payment.id);
  if (!/^pay_[A-Za-z0-9_]{1,100}$/.test(paymentId)) throw new Error(`Razorpay order ${orderId} returned an invalid captured payment id`);
  if (!Number.isSafeInteger(Number(payment.amount)) || Number(payment.amount) !== amount) throw new Error(`Razorpay captured amount mismatch for ${orderId}`);
  if (text(payment.currency) !== currency) throw new Error(`Razorpay captured currency mismatch for ${orderId}`);
  const notes = payment.notes && typeof payment.notes === "object" && !Array.isArray(payment.notes) ? payment.notes as Row : {};
  if (text(notes.booking_id) && text(notes.booking_id) !== text(intent.booking_id)) throw new Error(`Razorpay captured booking ownership mismatch for ${orderId}`);
  if (text(notes.payment_id) && text(notes.payment_id) !== text(intent.payment_id)) throw new Error(`Razorpay captured payment ownership mismatch for ${orderId}`);
  return payment;
}

export async function reconcileRazorpayCaptureIntent(db: Db, env: Env, intent: Row, input: { asOf?: number } = {}) {
  await ensurePaymentReconciliationTables(db);
  const orderId = text(intent.gateway_order_id);
  const provider = await fetchPaymentOrderPayments(env, { orderId });
  if (!provider.connected) throw new Error(provider.reason);
  const payment = capturedPaymentForIntent(intent, provider.payments);
  if (!payment) return { status: "provider_not_captured" as const, orderId };
  const gatewayPaymentId = text(payment.id), raw = JSON.stringify(payment), eventId = `provider-api:capture:${gatewayPaymentId}`;
  const committed = await commitRazorpayCaptureAtomic(db, {
    authority: "provider_api", eventId, environment: provider.environment, intentId: text(intent.id), bookingId: text(intent.booking_id), paymentId: text(intent.payment_id),
    gatewayOrderId: orderId, gatewayPaymentId, amountPaise: Number(intent.amount_paise), currency: text(intent.currency || "INR"), payloadHash: await sha256(raw),
    detail: { source: "razorpay_provider_api", providerStatus: text(payment.status), providerCaptured: payment.captured === true || text(payment.status) === "captured", observedAt: input.asOf ?? Date.now() },
  });
  const effects = committed.effectsOutboxId
    ? await executeRazorpayCapturePostCommit(db, { outboxId: committed.effectsOutboxId, workerId: `provider-api-reconciliation:${text(intent.id)}:${crypto.randomUUID()}` })
    : null;
  return { status: committed.duplicateCapture ? "already_captured" as const : "captured" as const, orderId, gatewayPaymentId, committed, effects };
}

export async function runRazorpayCaptureReconciliationSweep(db: Db, env: Env, input: { asOf?: number; limit?: number; graceMs?: number } = {}) {
  await ensurePaymentReconciliationTables(db);
  const environment = paymentEnvironment(env);
  if (environment === "live" && env.PAWSPACE_PAYMENT_LIVE_APPROVED !== "true") {
    return { configured: true, environment, skipped: true, reason: "Live payments are not approved" };
  }
  const keyId = text(environment === "sandbox" ? env.RAZORPAY_KEY_ID_SANDBOX : env.RAZORPAY_KEY_ID);
  const keySecret = text(environment === "sandbox" ? env.RAZORPAY_KEY_SECRET_SANDBOX : env.RAZORPAY_KEY_SECRET);
  if (!keyId || !keySecret) return { configured: false, environment, skipped: true, reason: "Razorpay API credentials are not configured" };
  const asOf = Math.min(input.asOf ?? Date.now(), Date.now());
  const graceMs = Math.max(30_000, Math.min(input.graceMs ?? 120_000, 15 * 60_000));
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Math.trunc(input.limit!))) : 25;
  const due = await db.prepare(`SELECT id,booking_id,payment_id,state,environment,amount_paise,currency,gateway_order_id,updated_at
    FROM payment_intents WHERE provider='razorpay' AND environment=? AND state IN ('CREATED','AUTHORIZED')
      AND order_request_state='ORDER_CREATED' AND gateway_order_id IS NOT NULL AND updated_at<=?
    ORDER BY updated_at ASC,id ASC LIMIT ?`).bind(environment, asOf - graceMs, limit).all<Row>();
  const results: Array<Record<string, unknown>> = [];
  let captured = 0, pending = 0, failed = 0, effectsPending = 0;
  for (const intent of due.results) {
    const orderId = text(intent.gateway_order_id);
    try {
      const result = await reconcileRazorpayCaptureIntent(db, env, intent, { asOf });
      if (result.status === "provider_not_captured") pending += 1;
      else if (result.status === "captured") captured += 1;
      if ("effects" in result && result.effects && !result.effects.completed) effectsPending += 1;
      results.push({ intentId: text(intent.id), ...result });
    } catch (error) {
      failed += 1;
      results.push({ intentId: text(intent.id), orderId, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { configured: true, environment, skipped: false, processed: due.results.length, captured, pending, failed, effectsPending, results };
}
