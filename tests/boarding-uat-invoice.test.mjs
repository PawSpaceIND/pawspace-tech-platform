/**
 * Boarding (net-based split) completion → governed UAT invoice.
 *
 * Proves, against a real in-memory SQLite via the shared D1 harness:
 *   1. Completing a Boarding booking auto-generates the invoice record (Boarding does not create one
 *      itself — the shared finalizer does).
 *   2. The invoice PDF renders from that record.
 *   3. The net-based split rule is applied: 18% of gross is deducted first (₹1000 → ₹820), then the
 *      provider share (70%) is taken on the net → ₹574 payout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__BOARDING_UAT_DB__");

const { finalizeUatCompletionInvoice } = await import("../lib/uat-completion-invoice.ts");
const { renderInvoicePdf } = await import("../lib/invoice-pdf.ts");
const { computeUatTaxAndPayout } = await import("../lib/gst-uat-computation.ts");

test("Boarding net-split completion auto-issues invoice + PDF; 18% flat deduction on payout base", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const { db } = makeCountingD1(sqlite);

  await db.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,package_name TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,status TEXT)");
  await db.exec("CREATE TABLE provider_work_orders (booking_id TEXT PRIMARY KEY,provider_id TEXT,provider_name TEXT,provider_model TEXT)");

  const bookingId = "BK-BOARD-NET-1", gross = 1000;
  await db.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,package_name,total_amount,currency,scheduled_start,status) VALUES (?,?,?,?,?,?,?,?,'completed')")
    .bind(bookingId, "CUS-1", "blr", "boarding", "Standard Home Boarding", gross, "INR", "2026-09-16T04:30:00Z").run();
  await db.prepare("INSERT INTO provider_work_orders (booking_id,provider_id,provider_name,provider_model) VALUES (?,?,?,'commission')")
    .bind(bookingId, "host_sana", "Sana F.").run();

  const result = await finalizeUatCompletionInvoice(db, bookingId, "staff@pawspace.in");
  assert.equal(result.skipped, false, "finalizer must act on a completed Boarding booking");

  // Net-based split: base = gross - 18% of gross = 820; provider payout = 70% of 820 = 574.
  const expected = computeUatTaxAndPayout({ serviceCode: "boarding", engagementModel: "commission", gross });
  assert.equal(expected.splitStyle, "net_of_gst");
  assert.equal(expected.payoutBase, 820, "18% flat deduction on gross yields the net payout base");
  assert.equal(expected.providerPayout, 574, "70% of the net payout base");

  // 1. Invoice auto-generated at completion.
  const inv = sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").get(bookingId);
  assert.ok(inv, "booking invoice row auto-generated at completion");
  assert.equal(inv.status, "issued");
  assert.equal(inv.tax_amount, expected.gstAmount, "invoice tax = governed 18% on the retained commission");
  assert.equal(inv.net_amount, expected.netAmount);

  // Provider payout split recorded with the 18%-deducted net base.
  const settlement = sqlite.prepare("SELECT payout_amount,status FROM provider_settlement_readiness WHERE booking_id=?").get(bookingId);
  assert.equal(settlement.payout_amount, 574, "provider payout uses the 18%-deducted net split");
  assert.equal(settlement.status, "uat_computed");

  // Governed finance invoice actually issued through gst-accounting.
  const fin = sqlite.prepare("SELECT COUNT(*) c FROM finance_invoices").get();
  assert.ok(Number(fin.c) >= 1, "governed finance invoice issued via gst-accounting.issueInvoice");

  // 2. Invoice PDF generates from the record.
  const pdf = renderInvoicePdf({
    invoiceNumber: String(inv.invoice_number),
    status: String(inv.status),
    issueDate: "2026-08-30",
    sellerName: "PawSpace Pet Care",
    customerName: "UAT Auditor",
    meta: [{ label: "Booking ID", value: bookingId }, { label: "Service", value: "Boarding" }],
    currency: "INR",
    grossAmount: gross,
    taxAmount: Number(inv.tax_amount),
    netAmount: Number(inv.net_amount),
    taxNote: "UAT non-production placeholder GST (dummy GSTIN) — NOT a production tax invoice.",
  });
  assert.ok(pdf.byteLength > 200, "PDF has real content");
  assert.equal(Buffer.from(pdf.subarray(0, 8)).toString("latin1"), "%PDF-1.4", "valid PDF header");

  // Idempotent: re-finalizing does not create a second invoice.
  await finalizeUatCompletionInvoice(db, bookingId, "staff@pawspace.in");
  const count = sqlite.prepare("SELECT COUNT(*) c FROM booking_invoices WHERE booking_id=?").get(bookingId);
  assert.equal(Number(count.c), 1, "finalizer is idempotent");
});
