import { enqueueCommunication } from "./communication-engine";
import { ensurePaymentReconciliationTables } from "./grooming-payment-reconciliation";
import { createPaymentRefund, paymentEnvironment } from "./razorpay-client";

type Db = D1Database;
type Row = Record<string, unknown>;
type Env = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const money = (value: unknown) => Math.round(Math.max(0, Number(value || 0)) * 100) / 100;

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

async function ensureRefundMessage(db: Db, row: Row) {
  const bookingId = text(row.booking_id), refundCaseId = text(row.refund_case_id);
  if (!bookingId || !refundCaseId) return { generated: false, reason: "missing_identity" };
  const amount = money(row.refund_amount);
  const result = await enqueueCommunication(db, {
    customerId: text(row.customer_id),
    cityId: text(row.city_id),
    channel: "whatsapp",
    purpose: "service_recovery",
    idempotencyKey: `BOOKING-REFUND-PROCESSING-${refundCaseId}`,
    templateKey: "booking_cancelled_refund_processing",
    payload: {
      bookingId,
      refundCaseId,
      amount,
      currency: text(row.currency) || "INR",
      gatewayRefundId: text(row.gateway_reference) || null,
      body: `Your PawSpace booking has been cancelled. A refund of INR ${amount.toFixed(2)} is being processed to your original payment method.`,
    },
    createdBy: "system:automatic-refund",
    bookingId,
  });
  return { generated: !(result as Row).duplicatePrevented, result };
}

/**
 * Processes only booking refund cases whose stored policy explicitly allows automatic refunding.
 * Human-review cases remain untouched. Provider submission is idempotent on refundCaseId, and a
 * persisted gateway reference is treated as proof that Razorpay must not be called again for that case.
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

  let runtimeEnvironment: "sandbox" | "live";
  try { runtimeEnvironment = paymentEnvironment(env); }
  catch (error) {
    return { processed: 0, initiated: 0, notified: 0, skipped: 0, failed: 1, errors: [error instanceof Error ? error.message : String(error)], blocked: true };
  }

  const candidates = await db.prepare(`SELECT
      r.id refund_case_id,r.booking_id,r.payment_id,r.amount refund_amount,r.reason,r.status refund_status,
      r.policy_json,r.gateway_reference,r.created_at,
      b.customer_id,b.city_id,b.service_code,b.status booking_status,
      p.status payment_status,p.amount payment_amount,p.currency,p.method,
      l.gateway_payment_id,l.environment gateway_environment,
      rec.captured_amount,rec.refunded_amount
    FROM booking_refund_cases r
    JOIN canonical_bookings b ON b.id=r.booking_id
    JOIN booking_payments p ON p.id=r.payment_id AND p.booking_id=r.booking_id
    LEFT JOIN payment_gateway_links l ON l.booking_id=r.booking_id AND l.payment_id=r.payment_id
    LEFT JOIN payment_reconciliation_records rec ON rec.payment_id=r.payment_id
    WHERE r.status IN ('requested','approved','processing','processed')
      AND b.status='cancelled' AND r.amount>0
    ORDER BY r.created_at ASC
    LIMIT ?`).bind(limit).all<Row>();

  const report = { processed: 0, initiated: 0, notified: 0, skipped: 0, failed: 0, errors: [] as string[] };
  for (const row of candidates.results) {
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
      if (!text(row.gateway_payment_id)) throw new Error("captured Razorpay payment id is missing");
      const captured = Number(row.captured_amount) > 0
        ? money(row.captured_amount)
        : ["captured", "refund_pending", "partially_refunded", "refunded"].includes(text(row.payment_status))
          ? money(row.payment_amount)
          : 0;
      if (captured <= 0) throw new Error("no verified captured funds are available to refund");

      const prior = await db.prepare(`SELECT COALESCE(SUM(amount),0) total
        FROM booking_refund_cases
        WHERE booking_id=? AND id<>? AND status IN ('approved','processing','processed','completed')`)
        .bind(bookingId, refundCaseId).first<Row>();
      const requested = money(row.refund_amount), alreadyCommitted = money(prior?.total);
      if (alreadyCommitted + requested > captured + 0.009) {
        throw new Error(`refund would exceed captured funds (${alreadyCommitted}+${requested}>${captured})`);
      }

      const status = text(row.refund_status);
      if (status === "requested") {
        const approved = await db.prepare(`UPDATE booking_refund_cases
          SET status='approved',approved_by='system:automatic-refund-policy',updated_at=?
          WHERE id=? AND status='requested'`)
          .bind(asOf, refundCaseId).run();
        if (Number(approved.meta?.changes || 0) !== 1) { report.skipped++; continue; }
      } else if (status !== "approved") {
        report.skipped++;
        continue;
      }

      const claim = await db.prepare(`UPDATE booking_refund_cases
        SET status='processing',updated_at=? WHERE id=? AND status='approved'`)
        .bind(asOf, refundCaseId).run();
      if (Number(claim.meta?.changes || 0) !== 1) { report.skipped++; continue; }

      const gateway = await createPaymentRefund(env, {
        bookingId,
        paymentId,
        gatewayPaymentId: text(row.gateway_payment_id),
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
