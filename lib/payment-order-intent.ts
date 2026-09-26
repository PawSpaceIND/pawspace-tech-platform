/**
 * Verify-first customer payment entry. The customer app claims a durable payment intent + outbox
 * command before any provider HTTP is attempted. A single outbox worker wins the provider call;
 * concurrent retries reuse the same scoped intent instead of creating parallel Razorpay orders.
 *
 * The verified Razorpay webhook remains the only path that may mark booking money captured.
 */

import { publicKeyId, paymentEnvironment } from "./razorpay-client";
import { paymentStageAmount } from "./payment-stage-amount";
import { ensurePaymentReconciliationTables } from "./grooming-payment-reconciliation";
import { governedJsonError } from "./governed-http-error";
import { claimPaymentIntent, rupeesToPaiseExact } from "./financial-lifecycle";
import { executeRazorpayOrderOutbox } from "./razorpay-order-outbox-saga";

type Db = D1Database;
type Row = Record<string, unknown>;

/*
 * A booking that has ended cannot take new money. Customer checkout already refuses these
 * (lib/customer-checkout-server.ts); every other route into a gateway order for a booking's own due amount -
 * /api/payment-order, the AI checkout tool, the Sales/Atlas payment link and the taxi balance page - reaches
 * createBookingPaymentOrder, and it did not check. (A Grooming reschedule difference opens its own order
 * through openPaymentIntentOrder after its own gates, which require the booking's payment to be captured.)
 * An unpaid Dog Training booking that expired is the case that made it matter: an order opened on it could
 * still be paid. Deny-lists, so every payable state of every vertical is unchanged.
 */
const NOT_PAYABLE_BOOKING_STATUSES = new Set(["cancelled", "canceled", "refunded", "failed", "expired"]);
const NOT_PAYABLE_PAYMENT_STATUSES = new Set(["cancelled", "refunded", "partially_refunded", "refund_pending"]);

async function persistGatewayOrderLink(db: Db, input: {
  bookingId: string; paymentId: string; gatewayOrderId: string; environment: "sandbox" | "live"; expectedAmount: number; currency: string;
}) {
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO payment_gateway_links
      (id,booking_id,payment_id,provider,environment,gateway_order_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'active',?,?)
      ON CONFLICT(booking_id) DO UPDATE SET gateway_order_id=excluded.gateway_order_id,provider=excluded.provider,environment=excluded.environment,status='active',updated_at=excluded.updated_at`)
      .bind(`PAYLINK-${crypto.randomUUID().slice(0,10).toUpperCase()}`, input.bookingId, input.paymentId, "razorpay", input.environment, input.gatewayOrderId, now, now),
    db.prepare(`INSERT INTO payment_reconciliation_records
      (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at)
      VALUES (?,?,?,?,?,0,0,?,'order_linked','pending',0,NULL,?)
      ON CONFLICT(payment_id) DO UPDATE SET gateway=excluded.gateway,environment=excluded.environment,expected_amount=excluded.expected_amount,currency=excluded.currency,gateway_status=CASE WHEN payment_reconciliation_records.gateway_status IN ('captured','refunded','partially_refunded') THEN payment_reconciliation_records.gateway_status ELSE 'order_linked' END,updated_at=excluded.updated_at`)
      .bind(input.paymentId, input.bookingId, "razorpay", input.environment, input.expectedAmount, input.currency, now),
  ]);
}

/**
 * Claims the durable intent for an EXPLICIT amount and purpose and opens its Razorpay order through the
 * outbox saga: one provider call however often the customer retries, because the idempotency key names
 * the intent. It never touches payment_gateway_links - that row belongs to the booking's first payment,
 * so an additional amount (a reschedule difference) keeps its order on its own intent only.
 */
export async function openPaymentIntentOrder(db: Db, env: Record<string, unknown>, input: {
  bookingId: string; customerId: string; paymentId: string; idempotencyKey: string; amountPaise: number; currency: string; commercialSnapshot: Record<string, unknown>;
}) {
  // Initialize reconciliation schema before any irreversible Razorpay provider call. This keeps
  // lazy DDL out of the post-provider response path while preserving webhook/reconciliation tables.
  await ensurePaymentReconciliationTables(db);
  const environment = paymentEnvironment(env);
  const intent = await claimPaymentIntent(db, {
    bookingId: input.bookingId,
    customerId: input.customerId,
    paymentId: input.paymentId,
    idempotencyKey: input.idempotencyKey,
    amountPaise: input.amountPaise,
    currency: input.currency,
    environment,
    commercialSnapshot: input.commercialSnapshot,
  });

  const intentId = String(intent.id);
  const outbox = await db.prepare("SELECT id,status FROM financial_outbox WHERE aggregate_type='payment_intent' AND aggregate_id=? AND event_type='CREATE_RAZORPAY_ORDER'").bind(intentId).first<Row>();
  if (!outbox) throw new Error("Payment order outbox command is missing");

  let orderId = String(intent.gateway_order_id || "");
  if (!orderId) {
    const execution = await executeRazorpayOrderOutbox(db, env, { outboxId: String(outbox.id), workerId: `checkout:${crypto.randomUUID()}` });
    if (execution.claimed && !execution.connected) {
      return { connected: false as const, environment, intentId, reason: execution.reason, reconciliationRequired: Boolean(execution.reconciliationRequired) };
    }
    if (execution.claimed && execution.connected) {
      if (execution.reconciliationRequired) {
        return { connected: false as const, environment, intentId, reason: execution.reason || "Razorpay order requires reconciliation before checkout may continue", reconciliationRequired: true };
      }
      orderId = execution.orderId;
    }
    if (!execution.claimed) {
      const winner = await db.prepare("SELECT gateway_order_id,order_request_state FROM payment_intents WHERE id=?").bind(intentId).first<Row>();
      orderId = String(winner?.gateway_order_id || "");
      if (!orderId) {
        throw governedJsonError({ error: "Payment order creation is already in progress; retry shortly", code: "payment_order_in_progress" }, 409);
      }
    }
  }
  return { connected: true as const, environment, intentId, orderId, amountPaise: input.amountPaise, currency: input.currency };
}

export async function createBookingPaymentOrder(db: Db, env: Record<string, unknown>, input: { bookingId: string; customerId: string; actorId: string }) {
  const bookingId = String(input.bookingId || "").trim(), customerId = String(input.customerId || "").trim();
  if (!bookingId || !customerId) throw new Error("A booking and customer are required");
  const row = await db.prepare("SELECT b.customer_id customer_id,b.status booking_status,p.id payment_id,p.status payment_status FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").bind(bookingId).first<Row>();
  if (!row) throw new Error("Booking or its payment record was not found");
  if (String(row.customer_id) !== customerId) throw governedJsonError({ error: "You can only pay for your own booking" }, 403);
  if (NOT_PAYABLE_BOOKING_STATUSES.has(String(row.booking_status)) || NOT_PAYABLE_PAYMENT_STATUSES.has(String(row.payment_status))) {
    throw governedJsonError({ error: "This booking cannot accept a new payment. Contact billing support.", code: "booking_not_payable" }, 409);
  }

  const stage = await paymentStageAmount(db, bookingId);
  if (!stage) throw new Error("Booking or its payment record was not found");
  if (stage.stage === "settled" || stage.dueNow <= 0) throw new Error("This booking is already paid");

  const amount = stage.dueNow, currency = stage.currency, paymentId = stage.paymentId;
  const amountPaise = rupeesToPaiseExact(amount);
  const opened = await openPaymentIntentOrder(db, env, {
    bookingId,
    customerId,
    paymentId,
    idempotencyKey: `payment-order:${paymentId}:${stage.stage}:${amountPaise}`,
    amountPaise,
    currency,
    commercialSnapshot: {
      paymentStage: stage.stage,
      bookingTotal: stage.bookingTotal,
      dueNow: amount,
      outstandingBalance: stage.outstandingBalance,
      creditsApplied: stage.creditsApplied,
      walletCreditApplied: stage.walletCreditApplied,
      pawPointsCreditApplied: stage.pawPointsCreditApplied,
    },
  });
  if (!opened.connected) return { connected: false, environment: opened.environment, reason: opened.reason, reconciliationRequired: opened.reconciliationRequired };
  const { environment, orderId } = opened;

  // Schema is already ready before the provider call, so this is DML-only reconciliation metadata.
  // The authoritative order identity remains payment_intents.gateway_order_id.
  await persistGatewayOrderLink(db, { bookingId, paymentId, gatewayOrderId: orderId, environment, expectedAmount: amount, currency });
  return {
    connected: true,
    environment,
    bookingId,
    paymentId,
    orderId,
    amount,
    amountPaise,
    currency,
    keyId: publicKeyId(env),
    status: "awaiting_payment",
    stage: stage.stage,
    bookingTotal: stage.bookingTotal,
    outstandingBalance: stage.outstandingBalance,
    creditsApplied: stage.creditsApplied,
    walletCreditApplied: stage.walletCreditApplied,
    pawPointsCreditApplied: stage.pawPointsCreditApplied,
  };
}

export { paymentEnvironment };
