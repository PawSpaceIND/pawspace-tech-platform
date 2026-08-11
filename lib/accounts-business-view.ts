type Db = D1Database;
type Row = Record<string, unknown>;

const rows = <T = Row>(r: { results?: unknown[] }) => (r.results || []) as T[];
async function safeAll(db: Db, sql: string, binds: unknown[] = []) {
  try {
    let q = db.prepare(sql);
    if (binds.length) q = q.bind(...binds);
    return rows(await q.all<Row>());
  } catch {
    return [] as Row[];
  }
}

const REFUND_LEDGER_VERTICALS = [
  { table: "boarding_refund_ledger", vertical: "Boarding" },
  { table: "sitting_refund_ledger", vertical: "Pet Sitting" },
  { table: "taxi_refund_ledger", vertical: "Pet Taxi" },
  { table: "walking_refund_ledger", vertical: "Dog Walking" },
] as const;
const SETTLEMENT_LEDGER_VERTICALS = [
  { table: "boarding_host_settlement_ledger", vertical: "Boarding" },
  { table: "sitting_sitter_settlement_ledger", vertical: "Pet Sitting" },
  { table: "taxi_driver_settlement_ledger", vertical: "Pet Taxi" },
  { table: "walking_walker_settlement_ledger", vertical: "Dog Walking" },
] as const;

/**
 * Real accounts ledger for Founder BI. booking_invoices and booking_payments are genuinely shared,
 * canonical tables across every vertical that issues them (confirmed identical schema in
 * boarding-invoice.ts, grooming-invoice.ts, sitting-invoice.ts, taxi-invoice.ts, walking-invoice.ts) -
 * safe to query universally for receivable, GST payable, and the transaction ledger.
 *
 * Refund queue and provider payable are scoped honestly to the four verticals whose refund/
 * settlement ledgers share an identical, safely-unionable schema (Boarding, Pet Sitting, Pet Taxi,
 * Dog Walking) - Training and Grooming use structurally different refund/settlement mechanisms
 * (training_refund_instructions has a different status vocabulary; Grooming's refunds live inside
 * payment_reconciliation_records, aggregated per-payment rather than as a discrete ledger) and are
 * not forced into the same union, which would risk silently misclassifying their real records.
 */
export async function buildAccountsBusinessView(db: Db) {
  const bookings = await safeAll(db, "SELECT id,service_code,total_amount FROM canonical_bookings WHERE status NOT IN ('draft','cancelled')");
  const bookingIds = bookings.map(b => String(b.id));
  let invoices: Row[] = [], payments: Row[] = [];
  if (bookingIds.length) {
    const placeholders = bookingIds.map(() => "?").join(",");
    [invoices, payments] = await Promise.all([
      safeAll(db, `SELECT id,booking_id,customer_id,invoice_number,status,gross_amount,tax_amount,net_amount,issued_at FROM booking_invoices WHERE booking_id IN (${placeholders})`, bookingIds),
      safeAll(db, `SELECT booking_id,amount,status,method FROM booking_payments WHERE booking_id IN (${placeholders})`, bookingIds),
    ]);
  }
  const invoiceByBooking = new Map(invoices.map(i => [String(i.booking_id), i]));
  const paymentByBooking = new Map(payments.map(p => [String(p.booking_id), p]));

  const paidAmount = (bookingId: string) => { const p = paymentByBooking.get(bookingId); return p && ["captured", "paid"].includes(String(p.status)) ? Number(p.amount || 0) : 0; };
  const receivable = bookings.reduce((sum, b) => { const total = Number(b.total_amount || 0), paid = paidAmount(String(b.id)); return sum + Math.max(0, total - paid); }, 0);
  const gstPayable = invoices.filter(i => i.issued_at != null).reduce((sum, i) => sum + Number(i.tax_amount || 0), 0);
  const invoicedBookingIds = new Set(invoices.map(i => String(i.booking_id)));
  const paidBookingIds = new Set(payments.filter(p => ["captured", "paid"].includes(String(p.status))).map(p => String(p.booking_id)));
  const unmatchedCount = bookings.filter(b => { const id = String(b.id); const hasInvoice = invoicedBookingIds.has(id), hasPayment = paidBookingIds.has(id); return hasInvoice !== hasPayment; }).length;

  let refundPending = 0, refundPendingCount = 0, providerPayable = 0, providerPayableCount = 0;
  for (const { table } of REFUND_LEDGER_VERTICALS) {
    const rows = await safeAll(db, `SELECT amount FROM ${table} WHERE status='sandbox_pending'`);
    for (const r of rows) { refundPending += Number(r.amount || 0); refundPendingCount++; }
  }
  for (const { table } of SETTLEMENT_LEDGER_VERTICALS) {
    const rows = await safeAll(db, `SELECT payout_amount FROM ${table} WHERE payout_status IN ('not_instructed','instructed') AND payout_amount IS NOT NULL`);
    for (const r of rows) { providerPayable += Number(r.payout_amount || 0); providerPayableCount++; }
  }

  const ledger = bookings
    .map(b => {
      const id = String(b.id), invoice = invoiceByBooking.get(id), payment = paymentByBooking.get(id);
      if (!invoice && !payment) return null;
      return {
        bookingId: id, vertical: String(b.service_code),
        invoiceNumber: invoice ? String(invoice.invoice_number) : null,
        gross: invoice ? Number(invoice.gross_amount) : Number(b.total_amount || 0),
        tax: invoice ? Number(invoice.tax_amount) : 0,
        net: invoice ? Number(invoice.net_amount) : Number(payment?.amount || 0),
        status: invoice ? String(invoice.status) : (payment ? String(payment.status) : "no_invoice"),
        method: payment ? String(payment.method) : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => (a.bookingId < b.bookingId ? 1 : -1))
    .slice(0, 100);

  return {
    receivable, gstPayable,
    refundQueue: { amount: refundPending, count: refundPendingCount, verticalsCovered: REFUND_LEDGER_VERTICALS.map(v => v.vertical) },
    providerPayable: { amount: providerPayable, count: providerPayableCount, verticalsCovered: SETTLEMENT_LEDGER_VERTICALS.map(v => v.vertical) },
    unmatched: unmatchedCount,
    ledger,
    sourceStatus: { invoices: "booking_invoices", payments: "booking_payments", refunds: "boarding_sitting_taxi_walking_only", payouts: "boarding_sitting_taxi_walking_only" },
  };
}
