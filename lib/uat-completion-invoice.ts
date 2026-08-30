/**
 * Shared "issue the governed UAT invoice when a booking completes" finalizer, used by every vertical's
 * lifecycle route so the completion → invoice → tax → payout flow is identical across the platform.
 *
 * ⚠️ NON-PRODUCTION (see lib/gst-uat-activation.ts): placeholder 18% GST + dummy GSTIN.
 *
 * Design:
 *  • Self-guarding: it only acts when the canonical booking is actually `completed`, so a route may call
 *    it after any lifecycle mutation without knowing which action was the completing one.
 *  • Self-contained: verticals other than grooming don't create a booking_invoices row at completion, so
 *    this creates the invoice / tax-readiness / settlement rows if they're missing.
 *  • Idempotent: invoice creation is INSERT OR IGNORE, gst-accounting.issueInvoice dedupes on the source
 *    event key, and the UPDATEs are deterministic — safe to call repeatedly.
 *  • Fail-safe: never throws. A completion must never fail because placeholder tax could not be issued.
 */
import {issueUatGovernedInvoice, UAT_GST_DUMMY_GSTIN} from "./gst-uat-activation";
import {computeUatTaxAndPayout, type EngagementModel} from "./gst-uat-computation";

type Db = D1Database;
type Row = Record<string, unknown>;

async function ensureTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_tax_readiness (booking_id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,gross_amount REAL NOT NULL,tax_amount REAL,tax_rule_status TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_settlement_readiness (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,gross_booking_amount REAL NOT NULL,payout_amount REAL,status TEXT NOT NULL,eligible_after INTEGER NOT NULL,rule_version TEXT,reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  ]);
}

export type FinalizeInvoiceResult =
  | {skipped: true; reason: string}
  | {skipped: false; bookingId: string; serviceCode: string; engagementModel: EngagementModel; invoiceNumber: string; taxAmount: number; providerPayout: number};

export async function finalizeUatCompletionInvoice(db: Db, bookingId: string, actorId: string): Promise<FinalizeInvoiceResult> {
  try {
    if (!bookingId) return {skipped: true, reason: "no_booking"};
    await ensureTables(db);
    const booking = await db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>().catch(() => null);
    if (!booking) return {skipped: true, reason: "booking_not_found"};
    if (String(booking.status) !== "completed") return {skipped: true, reason: "not_completed"};

    const work = await db.prepare("SELECT provider_id,provider_name,provider_model FROM provider_work_orders WHERE booking_id=?").bind(bookingId).first<Row>().catch(() => null);
    const engagementModel: EngagementModel = String(work?.provider_model) === "commission" ? "commission" : "full_time";
    const serviceCode = String(booking.service_code || "");
    const gross = Number(booking.total_amount || 0);
    const now = Date.now();

    // Ensure the booking-level invoice records exist (grooming makes these at completion; the other
    // verticals do not, so create them here before issuing).
    const existing = await db.prepare("SELECT id,invoice_number FROM booking_invoices WHERE booking_id=?").bind(bookingId).first<Row>().catch(() => null);
    if (!existing) {
      const invoiceId = `INV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const invoiceNumber = `PS-${new Date(now).getUTCFullYear()}-${(serviceCode.slice(0, 3).toUpperCase() || "SVC")}-${String(now).slice(-8)}`;
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES (?,?,?,?,'issued',?,?,0,?,?,?,?)").bind(invoiceId, bookingId, String(booking.customer_id), invoiceNumber, String(booking.currency || "INR"), gross, gross, now, now, now),
        db.prepare("INSERT OR IGNORE INTO booking_tax_readiness (booking_id,invoice_id,gross_amount,tax_amount,tax_rule_status,reason,created_at,updated_at) VALUES (?,?,?,NULL,'configuration_required','UAT invoice pending tax computation',?,?)").bind(bookingId, invoiceId, gross, now, now),
        db.prepare("INSERT OR IGNORE INTO provider_settlement_readiness (booking_id,provider_id,provider_model,gross_booking_amount,payout_amount,status,eligible_after,reason,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?,?,?)").bind(bookingId, String(work?.provider_id || ""), engagementModel, gross, engagementModel === "commission" ? "rule_pending" : "not_applicable", now + 24 * 3600 * 1000, "UAT settlement pending", now, now),
      ]);
    }
    const invRow = await db.prepare("SELECT invoice_number FROM booking_invoices WHERE booking_id=?").bind(bookingId).first<Row>().catch(() => null);
    const invoiceNumber = String(invRow?.invoice_number || "");

    // Issue through the governed gst-accounting pipeline using the UAT taxable base.
    const gov = await issueUatGovernedInvoice(db, {bookingId, customerId: String(booking.customer_id), serviceCode, engagementModel, gross, packageName: String(booking.package_name || ""), actorId});
    const c = gov.ok ? gov.computation : computeUatTaxAndPayout({serviceCode, engagementModel, gross});
    const financeNumber = gov.ok ? String((gov.financeInvoice as Row).invoice_number || "") : "";

    await db.batch([
      db.prepare("UPDATE booking_invoices SET tax_amount=?,net_amount=?,updated_at=? WHERE booking_id=?").bind(c.gstAmount, c.netAmount, now, bookingId),
      db.prepare("UPDATE booking_tax_readiness SET tax_amount=?,tax_rule_status='uat_placeholder',reason=?,updated_at=? WHERE booking_id=?").bind(c.gstAmount, `UAT non-production ${c.gstRatePercent}% GST (dummy GSTIN ${UAT_GST_DUMMY_GSTIN})${financeNumber ? `; governed finance invoice ${financeNumber}` : ""}`, now, bookingId),
      db.prepare("UPDATE provider_settlement_readiness SET payout_amount=?,status=?,reason=?,updated_at=? WHERE booking_id=?").bind(c.providerPayout, engagementModel === "commission" ? "uat_computed" : "not_applicable", `UAT placeholder payout (${c.payoutModel}); provider share ${c.providerSharePercent}% of ${c.payoutBase}`, now, bookingId),
    ]);

    return {skipped: false, bookingId, serviceCode, engagementModel, invoiceNumber, taxAmount: c.gstAmount, providerPayout: c.providerPayout};
  } catch (err) {
    return {skipped: true, reason: err instanceof Error ? err.message : "finalize_failed"};
  }
}
