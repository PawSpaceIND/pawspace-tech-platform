/**
 * Verify-first customer payment entry. The customer app claims a durable payment intent + outbox
 * command before any provider HTTP is attempted. A single outbox worker wins the provider call;
 * concurrent retries reuse the same scoped intent instead of creating parallel Razorpay orders.
 *
 * The verified Razorpay webhook remains the only path that may mark booking money captured.
 */

import { publicKeyId, paymentEnvironment } from "./razorpay-client";
import { paymentStageAmount } from "./payment-stage-amount";
import { governedJsonError } from "./governed-http-error";
import { claimPaymentIntent, rupeesToPaiseExact } from "./financial-lifecycle";
import { executeRazorpayOrderOutbox } from "./razorpay-order-outbox-saga";

type Db = D1Database;
type Row = Record<string, unknown>;

export async function createBookingPaymentOrder(db: Db, env: Record<string, unknown>, input: { bookingId: string; customerId: string; actorId: string }) {
  const bookingId = String(input.bookingId || "").trim(), customerId = String(input.customerId || "").trim();
  if (!bookingId || !customerId) throw new Error("A booking and customer are required");
  const row = await db.prepare("SELECT b.customer_id customer_id,p.id payment_id FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").bind(bookingId).first<Row>();
  if (!row) throw new Error("Booking or its payment record was not found");
  if (String(row.customer_id) !== customerId) throw governedJsonError({ error: "You can only pay for your own booking" }, 403);

  const stage = await paymentStageAmount(db, bookingId);
  if (!stage) throw new Error("Booking or its payment record was not found");
  if (stage.stage === "settled" || stage.dueNow <= 0) throw new Error("This booking is already paid");

  const amount = stage.dueNow, currency = stage.currency, paymentId = stage.paymentId;
  const amountPaise = rupeesToPaiseExact(amount);
  const environment = paymentEnvironment(env);
  const idempotencyKey = `payment-order:${paymentId}:${stage.stage}:${amountPaise}`;
  const intent = await claimPaymentIntent(db, {
    bookingId,
    customerId,
    paymentId,
    idempotencyKey,
    amountPaise,
    currency,
    environment,
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

  const intentId = String(intent.id);
  const outbox = await db.prepare("SELECT id,status FROM financial_outbox WHERE aggregate_type='payment_intent' AND aggregate_id=? AND event_type='CREATE_RAZORPAY_ORDER'").bind(intentId).first<Row>();
  if (!outbox) throw new Error("Payment order outbox command is missing");

  let orderId = String(intent.gateway_order_id || "");
  if (!orderId) {
    const execution = await executeRazorpayOrderOutbox(db, env, { outboxId: String(outbox.id), workerId: `checkout:${crypto.randomUUID()}` });
    if (execution.claimed && !execution.connected) {
      return { connected: false, environment, reason: execution.reason, reconciliationRequired: Boolean(execution.reconciliationRequired) };
    }
    if (execution.claimed && execution.connected) {
      if (execution.reconciliationRequired) {
        return { connected: false, environment, reason: execution.reason || "Razorpay order requires reconciliation before checkout may continue", reconciliationRequired: true };
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

  // The durable payment intent is the authoritative order mapping. Do not block the customer
  // response on secondary reconciliation-table DDL/DML after Razorpay has already created an order.
  // Webhook and receipt verification both resolve the order through payment_intents.gateway_order_id.
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
