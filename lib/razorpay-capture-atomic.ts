import { ACCT } from "./finance-accounts";
import { postCollectionEvent } from "./collection-ledger";
import { convertLeadOnPaymentCaptured } from "./lead-conversion-attribution";
import { cancelRecoveryEntitlements } from "./payment-recovery-governance";
import { activateSubscriptionOnCapture } from "./subscription-payment-activation";
import { tryQualifyLinkedReferral } from "./referral-booking-governance";

type Db = D1Database;
type Row = Record<string, unknown>;

export type AtomicRazorpayCaptureInput = {
  inboxId: string;
  eventId: string;
  environment: "sandbox" | "live";
  intentId?: string | null;
  bookingId: string;
  paymentId: string;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  amountPaise: number;
  currency: string;
  payloadHash: string;
  detail?: Record<string, unknown>;
};

const CAPTURE_TYPES = "('payment.captured','order.paid','payment_link.paid')";
const text = (value: unknown) => String(value ?? "").trim();
const round2 = (value: number) => Math.round(value * 100) / 100;

function captureKey(input: AtomicRazorpayCaptureInput) {
  return text(input.gatewayPaymentId) || text(input.gatewayOrderId) || input.eventId;
}

export async function commitRazorpayCaptureAtomic(db: Db, input: AtomicRazorpayCaptureInput) {
  if (!input.inboxId || !input.eventId || !input.bookingId || !input.paymentId) throw new Error("Atomic capture identity is incomplete");
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new Error("Captured Razorpay amount must be positive integer paise");

  const [intent, payment, current, schedule] = await Promise.all([
    input.intentId ? db.prepare("SELECT id,booking_id,payment_id,state,version,amount_paise,currency,gateway_order_id,gateway_payment_id FROM payment_intents WHERE id=?").bind(input.intentId).first<Row>() : Promise.resolve(null),
    db.prepare("SELECT id,booking_id,status,customer_id,amount,currency FROM booking_payments WHERE id=? AND booking_id=?").bind(input.paymentId, input.bookingId).first<Row>(),
    db.prepare("SELECT expected_amount,captured_amount,refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(input.paymentId).first<Row>(),
    db.prepare("SELECT paid_now_amount,balance_amount,status FROM stay_payment_schedules WHERE booking_id=?").bind(input.bookingId).first<Row>().catch(() => null),
  ]);
  if (!payment) throw new Error("Atomic capture could not resolve canonical payment state");
  if (intent) {
    if (text(intent.booking_id) !== input.bookingId || text(intent.payment_id) !== input.paymentId) throw new Error("Payment intent does not own the capture booking/payment");
    if (input.gatewayOrderId && text(intent.gateway_order_id) && text(intent.gateway_order_id) !== text(input.gatewayOrderId)) throw new Error("Razorpay order does not belong to the payment intent");
    if (Number(intent.amount_paise) !== input.amountPaise) throw new Error("Captured Razorpay amount does not match the payment intent");
    if (text(intent.currency || "INR") !== text(input.currency || "INR")) throw new Error("Captured Razorpay currency does not match the payment intent");
    if (!["AUTHORIZED", "CAPTURED"].includes(text(intent.state))) throw new Error(`Payment intent state ${text(intent.state)} cannot be captured atomically`);
  } else {
    const expectedPaise = Math.round(Number(current?.expected_amount ?? payment.amount ?? 0) * 100);
    if (expectedPaise !== input.amountPaise) throw new Error("Captured Razorpay amount does not match the linked payment expectation");
    if (text(payment.currency || "INR") !== text(input.currency || "INR")) throw new Error("Captured Razorpay currency does not match the linked payment");
  }

  const prior = await db.prepare(`SELECT id,event_id FROM payment_gateway_events
    WHERE payment_id=? AND event_type IN ${CAPTURE_TYPES} AND processing_status='processed'
      AND ((?<>'' AND gateway_payment_id=?) OR (?<>'' AND gateway_order_id=?))
    LIMIT 1`).bind(input.paymentId, text(input.gatewayPaymentId), text(input.gatewayPaymentId), text(input.gatewayOrderId), text(input.gatewayOrderId)).first<Row>();
  const now = Date.now();
  const effectsOutboxId = `FO-CAP-${crypto.randomUUID()}`;
  const effectsDedupe = `razorpay-capture-effects:${captureKey(input)}`;

  if (prior) {
    await db.batch([
      db.prepare(`INSERT INTO payment_gateway_events
        (id,provider,environment,event_id,event_type,booking_id,payment_id,gateway_order_id,gateway_payment_id,gateway_refund_id,amount_subunits,currency,signature_verified,payload_hash,processing_status,failure_reason,detail_json,received_at,processed_at)
        VALUES (?,'razorpay',?,?,?, ?,?,?,?,NULL,?,?,1,?,'processed','Repeat notification for a capture already collected',?,?,?)
        ON CONFLICT(provider,event_id) DO NOTHING`)
        .bind(`PAYEV-${crypto.randomUUID().slice(0,12).toUpperCase()}`, input.environment, input.eventId, "payment.captured", input.bookingId, input.paymentId, input.gatewayOrderId || null, input.gatewayPaymentId || null, input.amountPaise, input.currency, input.payloadHash, JSON.stringify({ ...(input.detail || {}), atomicCapture: true, duplicateCapture: true }), now, now),
      db.prepare("UPDATE gateway_webhook_events SET processing_status='PROCESSED',event_type='payment.captured',failure_reason=NULL,processed_at=? WHERE id=? AND processing_status='PROCESSING'").bind(now, input.inboxId),
    ]);
    const existingEffects = await db.prepare("SELECT id,status FROM financial_outbox WHERE dedupe_key=?").bind(effectsDedupe).first<Row>();
    return { duplicateCapture: true, effectsOutboxId: text(existingEffects?.id), effectsStatus: text(existingEffects?.status), capturedTotal: Number(current?.captured_amount || 0), collectedInFull: true };
  }

  const amount = input.amountPaise / 100;
  const capturedCurrent = Number(current?.captured_amount || 0);
  const refundedCurrent = Number(current?.refunded_amount || 0);
  const capturedTotal = round2(capturedCurrent + amount);
  const scheduleTotal = schedule ? round2(Number(schedule.paid_now_amount || 0) + Number(schedule.balance_amount || 0)) : 0;
  const collectedInFull = schedule ? capturedTotal + 0.009 >= scheduleTotal : true;
  const gateway = input.environment === "sandbox" ? "razorpay_sandbox" : "razorpay";
  const journalId = `JT-${crypto.randomUUID()}`;
  const journalEventId = `razorpay:capture:${captureKey(input)}`;
  const gatewayEventId = `PAYEV-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  const eventDetail = JSON.stringify({ ...(input.detail || {}), atomicCapture: true });
  const effectsPayload = JSON.stringify({
    inboxId: input.inboxId,
    eventId: input.eventId,
    bookingId: input.bookingId,
    paymentId: input.paymentId,
    intentId: input.intentId || null,
    gatewayOrderId: input.gatewayOrderId || null,
    gatewayPaymentId: input.gatewayPaymentId || null,
    amountPaise: input.amountPaise,
    currency: input.currency,
    captureKey: captureKey(input),
    collectedInFull,
  });

  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO payment_gateway_events
      (id,provider,environment,event_id,event_type,booking_id,payment_id,gateway_order_id,gateway_payment_id,gateway_refund_id,amount_subunits,currency,signature_verified,payload_hash,processing_status,failure_reason,detail_json,received_at,processed_at)
      VALUES (?,'razorpay',? ,?,'payment.captured',?,?,?,?,NULL,?,?,1,?,'processed',NULL,?,?,?)`)
      .bind(gatewayEventId, input.environment, input.eventId, input.bookingId, input.paymentId, input.gatewayOrderId || null, input.gatewayPaymentId || null, input.amountPaise, input.currency, input.payloadHash, eventDetail, now, now),
    db.prepare("UPDATE payment_gateway_links SET gateway_payment_id=COALESCE(?,gateway_payment_id),updated_at=? WHERE booking_id=? AND payment_id=?").bind(input.gatewayPaymentId || null, now, input.bookingId, input.paymentId),
    db.prepare("UPDATE booking_payments SET status='captured',gateway=?,detail_json=json_set(COALESCE(detail_json,'{}'),'$.gatewayPaymentId',?,'$.gatewayOrderId',?,'$.lastGatewayEventId',?,'$.atomicCapture',1),updated_at=? WHERE id=? AND booking_id=?")
      .bind(gateway, input.gatewayPaymentId || null, input.gatewayOrderId || null, input.eventId, now, input.paymentId, input.bookingId),
    db.prepare(`INSERT INTO payment_reconciliation_records
      (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'captured',?,0,?,?)
      ON CONFLICT(payment_id) DO UPDATE SET gateway=excluded.gateway,environment=excluded.environment,expected_amount=excluded.expected_amount,captured_amount=excluded.captured_amount,refunded_amount=excluded.refunded_amount,currency=excluded.currency,gateway_status='captured',reconciliation_status=excluded.reconciliation_status,variance_amount=0,last_event_id=excluded.last_event_id,updated_at=excluded.updated_at`)
      .bind(input.paymentId, input.bookingId, "razorpay", input.environment, amount, capturedTotal, refundedCurrent, input.currency, collectedInFull ? "matched" : "partially_captured", input.eventId, now),
    ...(input.intentId ? [db.prepare("UPDATE payment_intents SET state='CAPTURED',gateway_payment_id=COALESCE(?,gateway_payment_id),version=version+1,updated_at=? WHERE id=? AND state IN ('AUTHORIZED','CAPTURED') AND (gateway_payment_id IS NULL OR gateway_payment_id=?)")
      .bind(input.gatewayPaymentId || null, now, input.intentId, input.gatewayPaymentId || null)] : []),
    db.prepare("INSERT INTO journal_transactions (id,source_type,source_id,source_event_id,currency,status,narration,created_at) VALUES (?,?,?, ?,?,'DRAFT',?,?) ON CONFLICT(source_event_id) DO NOTHING")
      .bind(journalId, "razorpay_capture", input.intentId || input.paymentId, journalEventId, input.currency, `Razorpay capture ${captureKey(input)}`, now),
    db.prepare(`INSERT INTO journal_entries (id,transaction_id,account_code,direction,amount_paise,booking_id,partner_id,created_at)
      SELECT ?,?,?,?,?,?,NULL,? WHERE EXISTS (SELECT 1 FROM journal_transactions WHERE id=?)`)
      .bind(`JE-${crypto.randomUUID()}`, journalId, ACCT.GATEWAY_CLEARING, "DEBIT", input.amountPaise, input.bookingId, now, journalId),
    db.prepare(`INSERT INTO journal_entries (id,transaction_id,account_code,direction,amount_paise,booking_id,partner_id,created_at)
      SELECT ?,?,?,?,?,?,NULL,? WHERE EXISTS (SELECT 1 FROM journal_transactions WHERE id=?)`)
      .bind(`JE-${crypto.randomUUID()}`, journalId, ACCT.CUSTOMER_COLLECTIONS, "CREDIT", input.amountPaise, input.bookingId, now, journalId),
    db.prepare("UPDATE journal_transactions SET status='POSTED',posted_at=? WHERE id=? AND status='DRAFT'").bind(now, journalId),
    db.prepare(`INSERT INTO financial_outbox
      (id,aggregate_type,aggregate_id,event_type,dedupe_key,payload_json,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,'RAZORPAY_CAPTURE_POST_COMMIT',?,?,'PENDING',0,?,?,?)
      ON CONFLICT(dedupe_key) DO NOTHING`).bind(effectsOutboxId, input.intentId ? "payment_intent" : "booking_payment", input.intentId || input.paymentId, effectsDedupe, effectsPayload, now, now, now),
    db.prepare("UPDATE gateway_webhook_events SET processing_status='PROCESSED',event_type='payment.captured',failure_reason=NULL,processed_at=? WHERE id=? AND processing_status='PROCESSING'").bind(now, input.inboxId),
  ];
  if (schedule && collectedInFull && text(schedule.status) !== "paid") {
    statements.splice(4, 0, db.prepare("UPDATE stay_payment_schedules SET status='paid',paid_at=?,payment_ref=?,updated_at=? WHERE booking_id=? AND status IN ('pending_balance','overdue')")
      .bind(now, input.gatewayPaymentId || `GW-${input.eventId}`, now, input.bookingId));
  }

  await db.batch(statements);

  const [persistedIntent, persistedPayment, persistedInbox, postedJournal, persistedEffects] = await Promise.all([
    input.intentId ? db.prepare("SELECT state,gateway_payment_id FROM payment_intents WHERE id=?").bind(input.intentId).first<Row>() : Promise.resolve(null),
    db.prepare("SELECT status FROM booking_payments WHERE id=?").bind(input.paymentId).first<Row>(),
    db.prepare("SELECT processing_status FROM gateway_webhook_events WHERE id=?").bind(input.inboxId).first<Row>(),
    db.prepare("SELECT id,status FROM journal_transactions WHERE source_event_id=?").bind(journalEventId).first<Row>(),
    db.prepare("SELECT id,status FROM financial_outbox WHERE dedupe_key=?").bind(effectsDedupe).first<Row>(),
  ]);
  if ((input.intentId && text(persistedIntent?.state) !== "CAPTURED") || text(persistedPayment?.status) !== "captured" || text(persistedInbox?.processing_status) !== "PROCESSED" || !postedJournal || text(postedJournal.status) !== "POSTED" || !persistedEffects) {
    throw new Error("Atomic Razorpay capture commit verification failed");
  }
  return { duplicateCapture: false, effectsOutboxId: text(persistedEffects.id), effectsStatus: text(persistedEffects.status), journalId: text(postedJournal.id), capturedTotal, collectedInFull };
}

export async function executeRazorpayCapturePostCommit(db: Db, input: { outboxId: string; workerId: string; leaseMs?: number }) {
  const now = Date.now();
  const leaseMs = Math.max(5_000, Math.min(input.leaseMs || 30_000, 120_000));
  await db.prepare("UPDATE financial_outbox SET status='RETRY',lease_owner=NULL,lease_expires_at=NULL,last_error=COALESCE(last_error,'stale_capture_effects_lease'),next_attempt_at=?,updated_at=? WHERE id=? AND event_type='RAZORPAY_CAPTURE_POST_COMMIT' AND status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<?")
    .bind(now, now, input.outboxId, now).run();
  const claim = await db.prepare("UPDATE financial_outbox SET status='PROCESSING',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND event_type='RAZORPAY_CAPTURE_POST_COMMIT' AND status IN ('PENDING','RETRY') AND next_attempt_at<=?")
    .bind(input.workerId, now + leaseMs, now, input.outboxId, now).run();
  if (Number(claim.meta?.changes || 0) !== 1) {
    const current = await db.prepare("SELECT status,last_error FROM financial_outbox WHERE id=?").bind(input.outboxId).first<Row>();
    return { claimed: false as const, completed: text(current?.status) === "SUCCEEDED", status: text(current?.status), reason: text(current?.last_error) || undefined };
  }
  const work = await db.prepare("SELECT * FROM financial_outbox WHERE id=? AND lease_owner=?").bind(input.outboxId, input.workerId).first<Row>();
  if (!work) throw new Error("Capture post-commit outbox claim disappeared");
  const payload = JSON.parse(text(work.payload_json) || "{}") as Record<string, unknown>;
  try {
    const bookingId = text(payload.bookingId), paymentId = text(payload.paymentId), eventId = text(payload.eventId), captureReference = text(payload.gatewayPaymentId) || text(payload.gatewayOrderId) || text(payload.captureKey) || eventId;
    const payment = await db.prepare("SELECT customer_id FROM booking_payments WHERE id=? AND booking_id=?").bind(paymentId, bookingId).first<Row>();
    if (!payment) throw new Error("Capture post-commit payment is missing");
    const booking = await db.prepare("SELECT city_id,service_code FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>().catch(() => null);
    await postCollectionEvent(db, {
      event: "online_payment_captured",
      bookingId,
      customerId: payment.customer_id ? text(payment.customer_id) : null,
      cityId: booking?.city_id ? text(booking.city_id) : null,
      serviceCode: booking?.service_code ? text(booking.service_code) : null,
      paymentId,
      settlementId: captureReference,
      amount: Number(payload.amountPaise || 0) / 100,
      paymentMethod: "razorpay",
      entryDate: new Date().toISOString().slice(0, 10),
      transactionAt: now,
      actorId: "razorpay_capture_saga",
    });
    if (payload.collectedInFull === true) {
      await db.prepare("UPDATE provider_settlement_readiness SET status=CASE WHEN payout_amount IS NULL THEN 'payment_verified_rule_pending' ELSE 'eligible' END,reason=CASE WHEN payout_amount IS NULL THEN reason ELSE 'Verified gateway capture reconciled; eligible after the recorded hold period' END,updated_at=? WHERE booking_id=?")
        .bind(now, bookingId).run().catch(() => null);
    }
    await activateSubscriptionOnCapture(db, { bookingId, eventId, at: now });
    await tryQualifyLinkedReferral(db, { bookingId, actorId: "razorpay_webhook" });
    const customerId = text(payment.customer_id);
    if (customerId) {
      await convertLeadOnPaymentCaptured(db, { customerId, bookingId });
      await cancelRecoveryEntitlements(db, { customerId, bookingId, reason: "payment_captured", at: now });
    }
    await db.prepare("UPDATE financial_outbox SET status='SUCCEEDED',last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,response_json=?,updated_at=? WHERE id=? AND lease_owner=?")
      .bind(JSON.stringify({ completedAt: now, captureReference }), now, input.outboxId, input.workerId).run();
    return { claimed: true as const, completed: true as const, status: "SUCCEEDED" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryAt = Date.now() + 60_000;
    await db.prepare("UPDATE financial_outbox SET status='RETRY',last_error=?,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND lease_owner=?")
      .bind(message, retryAt, Date.now(), input.outboxId, input.workerId).run().catch(() => null);
    return { claimed: true as const, completed: false as const, status: "RETRY", reason: message };
  }
}

export async function captureEffectsOutboxForEvent(db: Db, eventId: string) {
  return db.prepare("SELECT id,status,last_error FROM financial_outbox WHERE event_type='RAZORPAY_CAPTURE_POST_COMMIT' AND json_extract(payload_json,'$.eventId')=? ORDER BY created_at DESC LIMIT 1")
    .bind(eventId).first<Row>();
}
