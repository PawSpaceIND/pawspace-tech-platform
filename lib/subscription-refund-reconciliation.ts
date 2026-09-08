import { postBalancedJournal } from "./financial-lifecycle";
import { ACCT } from "./finance-accounts";
import { issueAdjustment } from "./gst-accounting";
type Db = D1Database;
type Row = Record<string, unknown>;
const t = (v: unknown) => String(v ?? "").trim(), n = (v: unknown) => Number(v ?? 0);
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 16).toUpperCase()}`;
function entity(payload: Row, key: string) {
  const p = payload.payload as Record<string, { entity?: Row }> | undefined;
  return p?.[key]?.entity || {};
}

// Count every provider-confirmed refund, including accounting still awaiting repair.
// Legacy processed internal cases without a provider record also consume the ceiling.
const allocatedSql = `(SELECT COALESCE(SUM(r.amount_paise),0) FROM subscription_provider_refunds r WHERE r.cycle_id=cy.id)
  +(SELECT COALESCE(SUM(c.amount_paise),0) FROM subscription_refund_cases c WHERE c.cycle_id=cy.id AND c.status='processed'
    AND NOT EXISTS (SELECT 1 FROM subscription_provider_refunds r WHERE r.gateway_refund_id=c.gateway_refund_id))`;

export async function processSubscriptionRefundEvent(db: Db, payload: Row, eventId: string) {
  if (t(payload.event) !== "refund.processed") return { handled: false };
  const refund = entity(payload, "refund"), refundId = t(refund.id), paymentId = t(refund.payment_id), amount = n(refund.amount);
  if (!refundId || !paymentId || !Number.isSafeInteger(amount) || amount <= 0) return { handled: false };
  await db.prepare("CREATE TABLE IF NOT EXISTS subscription_provider_refunds (id TEXT PRIMARY KEY,cycle_id TEXT NOT NULL,gateway_refund_id TEXT NOT NULL UNIQUE,provider_event_id TEXT NOT NULL UNIQUE,amount_paise INTEGER NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  const refundCase = await db.prepare("SELECT r.*,cy.finance_invoice_id,c.source_booking_id FROM subscription_refund_cases r JOIN subscription_billing_cycles cy ON cy.id=r.cycle_id JOIN subscription_billing_contracts c ON c.id=r.contract_id WHERE r.gateway_refund_id=?").bind(refundId).first<Row>();
  let cycle: Row | null, kind = "maker_checker";
  if (refundCase) {
    cycle = await db.prepare("SELECT * FROM subscription_billing_cycles WHERE id=?").bind(refundCase.cycle_id).first<Row>();
    if (n(refundCase.amount_paise) !== amount) throw new Error("subscription_refund_amount_mismatch");
  } else {
    cycle = await db.prepare("SELECT cy.*,c.source_booking_id FROM subscription_billing_cycles cy JOIN subscription_billing_contracts c ON c.id=cy.contract_id WHERE cy.provider_payment_id=?").bind(paymentId).first<Row>();
    kind = "provider_proration";
  }
  if (!cycle) return { handled: false };
  if (t(cycle.provider_payment_id) !== paymentId) throw new Error("subscription_refund_payment_mismatch");
  if (t(refund.currency) && t(refund.currency) !== t(cycle.currency)) throw new Error("subscription_refund_currency_mismatch");
  const invoiceId = t(refundCase?.finance_invoice_id) || t(cycle.finance_invoice_id);
  if (!invoiceId) throw new Error("subscription_refund_invoice_missing");
  const invoice = await db.prepare("SELECT subtotal,tax_total,total FROM finance_invoices WHERE id=?").bind(invoiceId).first<Row>();
  if (!invoice || n(invoice.total) <= 0) throw new Error("subscription_refund_invoice_invalid");

  const previous = await db.prepare("SELECT * FROM subscription_provider_refunds WHERE gateway_refund_id=?").bind(refundId).first<Row>();
  if (!previous) {
    // Reserve the confirmed refund before accounting. The cap is checked in this same
    // INSERT, so distinct concurrent refunds cannot both spend the remaining ceiling.
    try {
      const inserted = await db.prepare(`INSERT INTO subscription_provider_refunds
        (id,cycle_id,gateway_refund_id,provider_event_id,amount_paise,kind,created_at)
        SELECT ?,cy.id,?,?,?,?,? FROM subscription_billing_cycles cy
        WHERE cy.id=? AND ?+${allocatedSql}<=cy.amount_paise
        ON CONFLICT(gateway_refund_id) DO NOTHING`)
        .bind(uid("SPRF"), refundId, eventId, amount, kind, Date.now(), cycle.id, amount).run();
      if (!Number(inserted.meta?.changes || 0)) {
        const winner = await db.prepare("SELECT id FROM subscription_provider_refunds WHERE gateway_refund_id=?").bind(refundId).first<Row>();
        if (!winner) throw new Error("subscription_refunds_exceed_cycle_capture");
      }
    } catch (error) {
      // A provider event cannot be rebound to another refund identity.
      if (error instanceof Error && /UNIQUE/i.test(error.message)) throw new Error("subscription_refund_event_identity_conflict");
      throw error;
    }
  }
  const record = await db.prepare("SELECT * FROM subscription_provider_refunds WHERE gateway_refund_id=?").bind(refundId).first<Row>();
  if (!record || t(record.cycle_id) !== t(cycle.id) || n(record.amount_paise) !== amount) throw new Error("subscription_refund_identity_mismatch");

  // Always resume accounting, even when the provider record already exists. A retry can
  // follow a failure between the durable claim, credit note, journal and final status.
  // Preserve accounting already posted by the previous event-keyed implementation.
  const legacyKey = `subscription:${t(record.provider_event_id)}`;
  const legacyNote = await db.prepare("SELECT id FROM finance_adjustment_documents WHERE source_event_key=?").bind(`${legacyKey}:credit-note`).first<Row>();
  const ratio = (amount / 100) / n(invoice.total), base = Math.round(n(invoice.subtotal) * ratio * 100) / 100;
  const tax = Math.round((amount / 100 - base) * 100) / 100;
  await issueAdjustment(db, {
    invoiceId, kind: "credit_note", sourceEventKey: legacyNote ? `${legacyKey}:credit-note` : `subscription:refund:${refundId}:credit-note`,
    reason: kind === "provider_proration" ? "Razorpay subscription proration refund" : t(refundCase?.reason), amount: base, taxAmount: tax,
  }, "system:subscription-billing");
  // postBalancedJournal installs the journal schema; probing a legacy key must only
  // tolerate absence of that table, not a transient database failure.
  let legacyJournal: Row | null = null;
  try { legacyJournal = await db.prepare("SELECT id FROM journal_transactions WHERE source_event_id=?").bind(`${legacyKey}:refund`).first<Row>(); }
  catch (error) { if (!(error instanceof Error && /no such table: journal_transactions/i.test(error.message))) throw error; }
  await postBalancedJournal(db, {
    sourceType: kind === "provider_proration" ? "subscription_proration_refund" : "subscription_refund",
    sourceId: t(refundCase?.id) || refundId, sourceEventId: legacyJournal ? `${legacyKey}:refund` : `subscription:refund:${refundId}:journal`,
    narration: `Subscription refund ${refundId}`, currency: t(cycle.currency) || "INR",
    entries: [
      { accountCode: ACCT.DEFERRED_REVENUE, direction: "DEBIT", amountPaise: amount, bookingId: t(refundCase?.source_booking_id) || t(cycle.source_booking_id) },
      { accountCode: ACCT.GATEWAY_CLEARING, direction: "CREDIT", amountPaise: amount, bookingId: t(refundCase?.source_booking_id) || t(cycle.source_booking_id) },
    ],
  });
  const ts = Date.now();
  await db.batch([
    ...(refundCase ? [db.prepare("UPDATE subscription_refund_cases SET status='processed',updated_at=? WHERE id=? AND status='processing'").bind(ts, refundCase.id)] : []),
    db.prepare(`UPDATE subscription_billing_cycles AS cy SET status=CASE WHEN ${allocatedSql}>=cy.amount_paise THEN 'refunded' ELSE 'partially_refunded' END,updated_at=? WHERE id=?`).bind(ts, cycle.id),
  ]);
  return { handled: true, kind, cycleId: t(cycle.id), duplicate: Boolean(previous) };
}
