import { enqueueCommunication } from "./communication-engine";
import { ensurePaymentReconciliationTables } from "./grooming-payment-reconciliation";
import { createPaymentRefund, paymentEnvironment } from "./razorpay-client";

type Db = D1Database;
type Row = Record<string, unknown>;
type Env = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const money = (value: unknown) => Math.round(Math.max(0, Number(value || 0)) * 100) / 100;

/** A refund of the difference a customer paid for a reschedule that could not be applied. */
export const RESCHEDULE_DIFFERENCE_REFUND_PURPOSE = "reschedule_difference";

function refundPolicy(row: Row) {
  try {
    const value = JSON.parse(text(row.policy_json) || "{}") as Record<string, unknown>;
    return {
      automatic: value.automatic === true,
      requiresApproval: value.requiresApproval === true,
      policyVersion: text(value.policyVersion),
    };
  } catch {
    return { automatic: false, requiresApproval: true, policyVersion: "" };
  }
}

async function tableExists(db: Db, name: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());
}

const refundTargetColumnsReady = new WeakSet<Db>();
/**
 * A refund case names what it is for and WHICH captured gateway payment it returns money to. A booking
 * can hold more than one capture (a split balance, a reschedule difference), and a Razorpay refund is
 * made against one payment and can never exceed it. Both columns are additive and nullable: a case
 * without a payment is a booking-level refund the sweep allocates across the captures.
 */
export async function ensureBookingRefundCaseTargets(db: Db) {
  if (refundTargetColumnsReady.has(db)) return;
  const columns = new Set((await db.prepare("PRAGMA table_info(booking_refund_cases)").all<Row>()).results.map(row => text(row.name)));
  if (!columns.size) return;
  for (const [name, ddl] of [["purpose", "ALTER TABLE booking_refund_cases ADD COLUMN purpose TEXT"], ["gateway_payment_id", "ALTER TABLE booking_refund_cases ADD COLUMN gateway_payment_id TEXT"]] as const) {
    if (columns.has(name)) continue;
    await db.prepare(ddl).run().catch((error: unknown) => { if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error; });
  }
  refundTargetColumnsReady.add(db);
}

/**
 * Every gateway payment captured against this booking payment, newest first, from the verified capture
 * events (one row per payment however many notifications it arrived as).
 */
export async function capturedGatewayPayments(db: Db, paymentId: string) {
  const rows = await db.prepare(`SELECT gateway_payment_id,MAX(amount_subunits) amount_subunits,MIN(received_at) first_seen,MIN(rowid) first_row
    FROM payment_gateway_events
    WHERE provider='razorpay' AND payment_id=? AND event_type IN ('payment.captured','order.paid','payment_link.paid') AND processing_status='processed'
      AND (signature_verified=1 OR json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.captureAuthority')='provider_api')
      AND substr(gateway_payment_id,1,4)='pay_'
    GROUP BY gateway_payment_id ORDER BY first_seen DESC,first_row DESC`).bind(paymentId).all<Row>().catch(() => ({ results: [] as Row[] }));
  return rows.results.map(row => ({ gatewayPaymentId: text(row.gateway_payment_id), amount: money(Number(row.amount_subunits || 0) / 100) })).filter(item => item.amount > 0);
}

/**
 * Difference payments for a reschedule that has not moved the booking. That money is not part of the
 * booking price: its own refund case returns it, so a booking-level refund must not be spread onto it.
 */
async function unappliedDifferencePayments(db: Db, bookingId: string) {
  if (!(await tableExists(db, "grooming_reschedule_requests"))) return new Set<string>();
  const rows = await db.prepare("SELECT i.gateway_payment_id FROM grooming_reschedule_requests q JOIN payment_intents i ON i.id=q.intent_id WHERE q.booking_id=? AND q.status<>'applied' AND i.gateway_payment_id IS NOT NULL")
    .bind(bookingId).all<Row>().catch(() => ({ results: [] as Row[] }));
  return new Set(rows.results.map(row => text(row.gateway_payment_id)));
}

/**
 * What other cases have already claimed from each captured payment. A case naming a payment reserves it
 * as soon as it is requested; an older case with no payment was refunded against the booking's first
 * captured payment (the linked one), so it counts there once it reached the gateway.
 */
async function committedByGatewayPayment(db: Db, bookingId: string, exceptCaseId: string, linkedPaymentId: string) {
  const rows = await db.prepare(`SELECT COALESCE(NULLIF(gateway_payment_id,''),?) target,COALESCE(SUM(amount),0) total
    FROM booking_refund_cases
    WHERE booking_id=? AND id<>? AND (
      (COALESCE(gateway_payment_id,'')<>'' AND status IN ('requested','approved','processing','processed','completed'))
      OR (COALESCE(gateway_payment_id,'')='' AND status IN ('processing','processed','completed')))
    GROUP BY target`).bind(linkedPaymentId, bookingId, exceptCaseId).all<Row>();
  return new Map(rows.results.map(row => [text(row.target), money(row.total)]));
}

async function ensureRefundMessage(db: Db, row: Row) {
  const bookingId = text(row.booking_id), refundCaseId = text(row.refund_case_id);
  if (!bookingId || !refundCaseId) return { generated: false, reason: "missing_identity" };
  const amount = money(row.refund_amount);
  const difference = text(row.purpose) === RESCHEDULE_DIFFERENCE_REFUND_PURPOSE;
  const result = await enqueueCommunication(db, {
    customerId: text(row.customer_id),
    cityId: text(row.city_id),
    channel: "whatsapp",
    purpose: "service_recovery",
    idempotencyKey: `BOOKING-REFUND-PROCESSING-${refundCaseId}`,
    templateKey: difference ? "reschedule_difference_refund_processing" : "booking_cancelled_refund_processing",
    payload: {
      bookingId,
      refundCaseId,
      amount,
      currency: text(row.currency) || "INR",
      gatewayRefundId: text(row.gateway_reference) || null,
      body: difference
        ? `We could not move your PawSpace booking to the new time. The INR ${amount.toFixed(2)} you paid for the new time is being refunded to your original payment method.`
        : `Your PawSpace booking has been cancelled. A refund of INR ${amount.toFixed(2)} is being processed to your original payment method.`,
    },
    createdBy: "system:automatic-refund",
    bookingId,
  });
  return { generated: !(result as Row).duplicatePrevented, result };
}

const CANDIDATE_SELECT = `SELECT
      r.id refund_case_id,r.booking_id,r.payment_id,r.amount refund_amount,r.reason,r.status refund_status,
      r.policy_json,r.gateway_reference,r.created_at,r.purpose,r.gateway_payment_id target_payment_id,
      b.customer_id,b.city_id,b.service_code,b.status booking_status,
      p.status payment_status,p.amount payment_amount,p.currency,p.method,
      l.gateway_payment_id,l.environment gateway_environment,
      rec.captured_amount,rec.refunded_amount
    FROM booking_refund_cases r
    JOIN canonical_bookings b ON b.id=r.booking_id
    JOIN booking_payments p ON p.id=r.payment_id AND p.booking_id=r.booking_id
    LEFT JOIN payment_gateway_links l ON l.booking_id=r.booking_id AND l.payment_id=r.payment_id
    LEFT JOIN payment_reconciliation_records rec ON rec.payment_id=r.payment_id`;

/**
 * Processes only booking refund cases whose stored policy explicitly allows automatic refunding.
 * Human-review cases remain untouched. Provider submission is idempotent on refundCaseId, and a
 * persisted gateway reference is treated as proof that Razorpay must not be called again for that case.
 *
 * A booking with several captured payments has its refund split across them, newest first, each part
 * capped at what is left of that payment: the case keeps the newest part and each further part becomes
 * its own case (id `<case>-P2`, `-P3`, ...), so every Razorpay refund has one case and one payment.
 * A reschedule-difference case is refunded against the difference payment it names, also on a booking
 * that is not cancelled.
 */
export async function runAutomaticBookingRefundSweep(
  db: Db,
  env: Env,
  input: { asOf?: number; limit?: number } = {},
) {
  const asOf = input.asOf ?? Date.now();
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
  if (!(await tableExists(db, "booking_refund_cases"))) {
    return { processed: 0, initiated: 0, notified: 0, skipped: 0, failed: 0, errors: [] as string[], tableMissing: true };
  }
  await ensurePaymentReconciliationTables(db);
  await ensureBookingRefundCaseTargets(db);

  let runtimeEnvironment: "sandbox" | "live";
  try { runtimeEnvironment = paymentEnvironment(env); }
  catch (error) {
    return { processed: 0, initiated: 0, notified: 0, skipped: 0, failed: 1, errors: [error instanceof Error ? error.message : String(error)], blocked: true };
  }

  const candidates = await db.prepare(`${CANDIDATE_SELECT}
    WHERE r.status IN ('requested','approved','processing','processed')
      AND (b.status='cancelled' OR r.purpose=?) AND r.amount>0
    ORDER BY r.created_at ASC
    LIMIT ?`).bind(RESCHEDULE_DIFFERENCE_REFUND_PURPOSE, limit).all<Row>();

  const report = { processed: 0, initiated: 0, notified: 0, skipped: 0, failed: 0, errors: [] as string[] };
  const queue = [...candidates.results];
  for (let index = 0; index < queue.length; index++) {
    const row = queue[index];
    const refundCaseId = text(row.refund_case_id), bookingId = text(row.booking_id), paymentId = text(row.payment_id);
    const policy = refundPolicy(row);
    if (!policy.automatic || policy.requiresApproval) { report.skipped++; continue; }
    report.processed++;

    try {
      if (text(row.gateway_reference)) {
        const message = await ensureRefundMessage(db, row);
        if (message.generated) report.notified++;
        continue;
      }

      const linkedEnvironment = text(row.gateway_environment);
      if (linkedEnvironment && linkedEnvironment !== runtimeEnvironment) {
        throw new Error(`payment environment mismatch (${linkedEnvironment} payment, ${runtimeEnvironment} runtime)`);
      }
      const captured = Number(row.captured_amount) > 0
        ? money(row.captured_amount)
        : ["captured", "refund_pending", "partially_refunded", "refunded"].includes(text(row.payment_status))
          ? money(row.payment_amount)
          : 0;
      if (captured <= 0) throw new Error("no verified captured funds are available to refund");

      let requested = money(row.refund_amount);
      const status = text(row.refund_status);
      if (status !== "requested" && status !== "approved") { report.skipped++; continue; }

      /*
       * WHICH payment this refund goes back to. It used to be the one gateway payment id stored on the
       * booking's link, whatever the booking had collected - so after a second capture a full refund
       * was sent against a payment smaller than the refund.
       */
      const captures = await capturedGatewayPayments(db, paymentId);
      const committed = await committedByGatewayPayment(db, bookingId, refundCaseId, text(row.gateway_payment_id));
      const remainingOn = (gatewayPaymentId: string) => {
        const capture = captures.find(item => item.gatewayPaymentId === gatewayPaymentId);
        return capture ? money(capture.amount - (committed.get(gatewayPaymentId) ?? 0)) : 0;
      };
      let targetPaymentId = text(row.target_payment_id);
      if (targetPaymentId) {
        if (!captures.some(item => item.gatewayPaymentId === targetPaymentId)) throw new Error(`gateway payment ${targetPaymentId} was not captured on this booking`);
        if (requested > remainingOn(targetPaymentId) + 0.009) throw new Error(`refund would exceed the captured payment ${targetPaymentId} (${requested} > ${remainingOn(targetPaymentId)} left)`);
      } else if (captures.length) {
        const unapplied = await unappliedDifferencePayments(db, bookingId);
        const allocations: Array<{ gatewayPaymentId: string; amount: number }> = [];
        let left = requested;
        for (const capture of captures) {
          if (left <= 0.009) break;
          if (unapplied.has(capture.gatewayPaymentId)) continue;
          const take = money(Math.min(left, remainingOn(capture.gatewayPaymentId)));
          if (take <= 0) continue;
          allocations.push({ gatewayPaymentId: capture.gatewayPaymentId, amount: take });
          left = money(left - take);
        }
        if (left > 0.009 || !allocations.length) throw new Error(`refund would exceed the captured payments (${money(requested - left)} of ${requested} is refundable)`);
        if (allocations.length > 1) {
          // One batch: the case shrinks to the newest part only if every further part is written with it.
          const [first, ...rest] = allocations;
          await db.batch([
            db.prepare("UPDATE booking_refund_cases SET amount=?,gateway_payment_id=?,updated_at=? WHERE id=? AND COALESCE(gateway_payment_id,'')='' AND ROUND(amount,2)=ROUND(?,2) AND status=?")
              .bind(first.amount, first.gatewayPaymentId, asOf, refundCaseId, requested, status),
            ...rest.map((part, offset) => db.prepare(`INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,policy_json,purpose,gateway_payment_id,created_at,updated_at)
              SELECT ?,booking_id,payment_id,?,reason,status,requested_by,approved_by,policy_json,purpose,?,created_at,? FROM booking_refund_cases WHERE id=? AND gateway_payment_id=? AND ROUND(amount,2)=ROUND(?,2)`)
              .bind(`${refundCaseId}-P${offset + 2}`, part.amount, part.gatewayPaymentId, asOf, refundCaseId, first.gatewayPaymentId, first.amount)),
          ]);
          const split = await db.prepare("SELECT gateway_payment_id,amount FROM booking_refund_cases WHERE id=?").bind(refundCaseId).first<Row>();
          if (text(split?.gateway_payment_id) !== first.gatewayPaymentId || Math.abs(money(split?.amount) - first.amount) > 0.009) { report.skipped++; continue; }
          const parts = await db.prepare(`${CANDIDATE_SELECT} WHERE r.id IN (SELECT value FROM json_each(?)) ORDER BY r.id`).bind(JSON.stringify(rest.map((_, offset) => `${refundCaseId}-P${offset + 2}`))).all<Row>();
          queue.push(...parts.results);
          requested = first.amount;
          row.refund_amount = first.amount;
        }
        targetPaymentId = allocations[0].gatewayPaymentId;
      } else {
        targetPaymentId = text(row.gateway_payment_id);
      }
      if (!targetPaymentId) throw new Error("captured Razorpay payment id is missing");

      const prior = await db.prepare(`SELECT COALESCE(SUM(amount),0) total
        FROM booking_refund_cases
        WHERE booking_id=? AND id<>? AND status IN ('approved','processing','processed','completed')`)
        .bind(bookingId, refundCaseId).first<Row>();
      /*
       * What has ALREADY gone back to this customer, taking the larger of the two records of it.
       *
       * The guard used to count only other booking_refund_cases, and rec.refunded_amount was
       * SELECTed a few lines above and never read. A refund issued straight from the Razorpay
       * dashboard - which a support agent genuinely does - produces a refund.processed webhook
       * that moves refunded_amount but opens no refund case at all. This sweep runs unattended and
       * initiates real refunds on a policy flag, so against a Rs 4,000 capture already refunded
       * Rs 3,000 outside the case system it saw "no other cases", approved the full Rs 4,000, and
       * sent Rs 7,000 back on a Rs 4,000 booking with no human involved.
       *
       * max() rather than a sum, because the two are usually the SAME refund seen from two sides:
       * a processed case that the gateway already reflects must count once, or a legitimate
       * remaining refund would be blocked. Whichever ledger has seen more is the safe figure.
       * [D31-W1c]
       */
      const alreadyCommitted = money(prior?.total);
      const gatewayRefunded = money(row.refunded_amount);
      const alreadyRefunded = Math.max(alreadyCommitted, gatewayRefunded);
      if (alreadyRefunded + requested > captured + 0.009) {
        throw new Error(`refund would exceed captured funds (already ${alreadyRefunded} [cases ${alreadyCommitted}, gateway ${gatewayRefunded}] + ${requested} > captured ${captured})`);
      }

      if (status === "requested") {
        const approved = await db.prepare(`UPDATE booking_refund_cases
          SET status='approved',approved_by='system:automatic-refund-policy',updated_at=?
          WHERE id=? AND status='requested'`)
          .bind(asOf, refundCaseId).run();
        if (Number(approved.meta?.changes || 0) !== 1) { report.skipped++; continue; }
      }

      // The claim also records which payment the refund is made against.
      const claim = await db.prepare(`UPDATE booking_refund_cases
        SET status='processing',gateway_payment_id=COALESCE(NULLIF(gateway_payment_id,''),?),updated_at=? WHERE id=? AND status='approved'`)
        .bind(targetPaymentId, asOf, refundCaseId).run();
      if (Number(claim.meta?.changes || 0) !== 1) { report.skipped++; continue; }

      const gateway = await createPaymentRefund(env, {
        bookingId,
        paymentId,
        gatewayPaymentId: targetPaymentId,
        refundCaseId,
        amount: requested,
        currency: text(row.currency) || "INR",
      });
      if (!gateway.connected) {
        await db.prepare("UPDATE booking_refund_cases SET status='approved',updated_at=? WHERE id=? AND status='processing' AND gateway_reference IS NULL")
          .bind(Date.now(), refundCaseId).run();
        throw new Error(gateway.reason);
      }

      const gatewayRefundId = text(gateway.refund.id);
      const now = Date.now();
      const persisted = await db.prepare("UPDATE booking_refund_cases SET gateway_reference=?,updated_at=? WHERE id=? AND status='processing' AND gateway_reference IS NULL")
        .bind(gatewayRefundId, now, refundCaseId).run();
      if (Number(persisted.meta?.changes || 0) !== 1) {
        const winner = await db.prepare("SELECT gateway_reference FROM booking_refund_cases WHERE id=?").bind(refundCaseId).first<Row>();
        if (text(winner?.gateway_reference) !== gatewayRefundId) throw new Error("refund gateway identity conflict detected");
      }
      await db.prepare("UPDATE payment_reconciliation_records SET gateway_status='refund_requested',reconciliation_status='pending_refund',updated_at=? WHERE payment_id=?")
        .bind(now, paymentId).run();
      row.gateway_reference = gatewayRefundId;
      report.initiated++;
      const message = await ensureRefundMessage(db, row);
      if (message.generated) report.notified++;
    } catch (error) {
      report.failed++;
      report.errors.push(`${refundCaseId || bookingId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
