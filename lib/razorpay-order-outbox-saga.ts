import { claimOutboxWork } from "./financial-lifecycle";
import { createPaymentOrderPaise } from "./razorpay-client";

type Db = D1Database;
type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();

function orderPersistenceStatements(db: Db, input: { intentId: string; outboxId: string; workerId: string; orderId: string; order: unknown; now: number }) {
  return [
    db.prepare(`UPDATE payment_intents SET gateway_order_id=?,order_request_state='ORDER_CREATED',version=version+1,updated_at=?
      WHERE id=? AND (gateway_order_id IS NULL OR gateway_order_id=?)
        AND order_request_state IN ('PAYMENT_ORDER_REQUESTED','PROCESSING','FAILED','RECONCILIATION_REQUIRED')
        AND NOT EXISTS (
          SELECT 1 FROM gateway_object_identities
          WHERE provider='razorpay' AND object_type='order' AND external_id=?
            AND (owner_type<>'payment_intent' OR owner_id<>?)
        )`)
      .bind(input.orderId, input.now, input.intentId, input.orderId, input.orderId, input.intentId),
    db.prepare("INSERT INTO gateway_object_identities (provider,object_type,external_id,owner_type,owner_id,created_at) VALUES ('razorpay','order',?,'payment_intent',?,?) ON CONFLICT DO NOTHING")
      .bind(input.orderId, input.intentId, input.now),
    db.prepare(`UPDATE financial_outbox SET status='SUCCEEDED',response_json=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND lease_owner=?
        AND EXISTS (SELECT 1 FROM payment_intents WHERE id=? AND gateway_order_id=?)
        AND EXISTS (SELECT 1 FROM gateway_object_identities WHERE provider='razorpay' AND object_type='order' AND external_id=? AND owner_type='payment_intent' AND owner_id=?)`)
      .bind(JSON.stringify(input.order), input.now, input.outboxId, input.workerId, input.intentId, input.orderId, input.orderId, input.intentId),
  ];
}

async function persistedOrderState(db: Db, input: { intentId: string; outboxId: string; orderId: string }) {
  const [intent, identity, outbox] = await Promise.all([
    db.prepare("SELECT gateway_order_id,order_request_state FROM payment_intents WHERE id=?").bind(input.intentId).first<Row>(),
    db.prepare("SELECT owner_type,owner_id FROM gateway_object_identities WHERE provider='razorpay' AND object_type='order' AND external_id=?").bind(input.orderId).first<Row>(),
    db.prepare("SELECT status,response_json FROM financial_outbox WHERE id=?").bind(input.outboxId).first<Row>(),
  ]);
  return {
    converged: text(intent?.gateway_order_id) === input.orderId
      && text(intent?.order_request_state) === "ORDER_CREATED"
      && text(identity?.owner_type) === "payment_intent"
      && text(identity?.owner_id) === input.intentId
      && text(outbox?.status) === "SUCCEEDED",
    intent,
    identity,
    outbox,
  };
}

async function markProviderSuccessForReconciliation(db: Db, input: { intentId: string; outboxId: string; workerId: string; orderId: string; order: unknown; error: unknown }) {
  const now = Date.now();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await db.batch([
    db.prepare("UPDATE payment_intents SET order_request_state='RECONCILIATION_REQUIRED',version=version+1,updated_at=? WHERE id=? AND gateway_order_id IS NULL")
      .bind(now, input.intentId),
    db.prepare(`UPDATE financial_outbox SET status='RECONCILIATION_REQUIRED',response_json=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND lease_owner=?`)
      .bind(JSON.stringify({ providerOrderCreated: true, orderId: input.orderId, order: input.order }), `provider_order_created_local_persistence_failed:${message}`, now, input.outboxId, input.workerId),
  ]);
}

/**
 * Durable Razorpay order saga.
 *
 * Provider creation is the irreversible side effect. Local persistence is retried atomically after any
 * database/runtime exception. If that recovery also fails, the exact provider order identity is written
 * into the durable outbox and the intent is moved to RECONCILIATION_REQUIRED. The provider is never
 * called a second time for the same claimed work item.
 */
export async function executeRazorpayOrderOutbox(db: Db, env: Record<string, unknown>, input: { outboxId: string; workerId: string }) {
  const work = await claimOutboxWork(db, input);
  if (!work) return { claimed: false as const };
  if (text(work.status) === "RECONCILIATION_REQUIRED") {
    return { claimed: true as const, connected: false as const, reason: "A previous Razorpay order attempt ended ambiguously; reconciliation is required before retry", reconciliationRequired: true };
  }
  const intent = await db.prepare("SELECT * FROM payment_intents WHERE id=?").bind(text(work.aggregate_id)).first<Row>();
  if (!intent) throw new Error("Outbox payment intent is missing");
  const intentId = text(intent.id);
  if (text(intent.gateway_order_id)) {
    await db.prepare("UPDATE financial_outbox SET status='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
      .bind(Date.now(), input.outboxId, input.workerId).run();
    return { claimed: true as const, connected: true as const, orderId: text(intent.gateway_order_id), replay: true, recoveredFromPersistenceFailure: false };
  }

  const request = { bookingId: text(intent.booking_id), paymentId: text(intent.payment_id), amountPaise: Number(intent.amount_paise), currency: text(intent.currency) };
  await db.prepare("UPDATE financial_outbox SET request_json=?,updated_at=? WHERE id=? AND lease_owner=?")
    .bind(JSON.stringify(request), Date.now(), input.outboxId, input.workerId).run();
  const created = await createPaymentOrderPaise(env, request);
  const now = Date.now();
  if (!created.connected) {
    const ambiguous = /timed out|request failed|network|fetch/i.test(created.reason);
    await db.batch([
      db.prepare("UPDATE financial_outbox SET status=?,response_json=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
        .bind(ambiguous ? "RECONCILIATION_REQUIRED" : "RETRY", JSON.stringify(created), created.reason, now, input.outboxId, input.workerId),
      db.prepare("UPDATE payment_intents SET order_request_state=?,version=version+1,updated_at=? WHERE id=? AND gateway_order_id IS NULL")
        .bind(ambiguous ? "RECONCILIATION_REQUIRED" : "FAILED", now, intentId),
    ]);
    return { claimed: true as const, connected: false as const, reason: created.reason, reconciliationRequired: ambiguous };
  }

  const orderId = text(created.order.id);
  if (!orderId) throw new Error("Razorpay order response has no id");
  let recoveredFromPersistenceFailure = false;
  try {
    await db.batch(orderPersistenceStatements(db, { intentId, outboxId: input.outboxId, workerId: input.workerId, orderId, order: created.order, now }));
  } catch (firstError) {
    recoveredFromPersistenceFailure = true;
    try {
      await db.batch(orderPersistenceStatements(db, { intentId, outboxId: input.outboxId, workerId: input.workerId, orderId, order: created.order, now: Date.now() }));
    } catch (recoveryError) {
      await markProviderSuccessForReconciliation(db, { intentId, outboxId: input.outboxId, workerId: input.workerId, orderId, order: created.order, error: recoveryError });
      return {
        claimed: true as const,
        connected: true as const,
        orderId,
        replay: false,
        recoveredFromPersistenceFailure: false,
        reconciliationRequired: true,
        reason: `Razorpay order exists but local persistence requires reconciliation: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
      };
    }
  }

  const persisted = await persistedOrderState(db, { intentId, outboxId: input.outboxId, orderId });
  if (!persisted.converged) {
    await markProviderSuccessForReconciliation(db, { intentId, outboxId: input.outboxId, workerId: input.workerId, orderId, order: created.order, error: new Error("gateway order persistence verification failed") });
    return { claimed: true as const, connected: true as const, orderId, replay: false, recoveredFromPersistenceFailure, reconciliationRequired: true, reason: "Razorpay order exists but local persistence requires reconciliation" };
  }
  return { claimed: true as const, connected: true as const, orderId, replay: false, recoveredFromPersistenceFailure, reconciliationRequired: false };
}
