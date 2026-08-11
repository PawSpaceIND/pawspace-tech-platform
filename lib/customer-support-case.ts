/**
 * Real customer-facing complaint/support intake - genuinely missing before this. A real,
 * well-built staff-side case system already existed (lib/unified-case-center.ts, with a
 * "customer_complaint" case type already modeled) but nothing let a customer actually create one
 * themselves; it only ever auto-synced cases from refunds, lead SLA events and payment
 * reconciliation exceptions. A customer with a genuine service problem (bad grooming, a no-show,
 * a damaged item) had no in-app way to report it - the general Contact form just creates an
 * untyped sales lead, not a tracked case with SLA timers.
 *
 * Deliberately a thin wrapper reusing the real case system end to end - no parallel/competing
 * ticketing system, no case data model duplicated.
 */

import { createUnifiedCase } from "./unified-case-center";

type Db = D1Database;
type Row = Record<string, unknown>;

export async function submitCustomerComplaint(db: Db, input: { customerId: string; bookingId?: string | null; title: string; description: string; severity?: "low" | "medium" | "high" }) {
  const title = input.title.trim(), description = input.description.trim();
  if (!title) throw new Error("A short title for your issue is required");
  if (!description || description.length < 10) throw new Error("Please describe the issue in a bit more detail (at least 10 characters)");
  let providerId: string | null = null;
  if (input.bookingId) {
    const booking = await db.prepare("SELECT customer_id,provider_id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
    if (!booking) throw new Error("Booking not found");
    if (String(booking.customer_id) !== input.customerId) throw new Error("You can only report an issue on your own booking");
    providerId = String(booking.provider_id);
  }
  const idempotencyKey = `customer-complaint:${input.customerId}:${input.bookingId || "general"}:${title.slice(0, 40)}:${Date.now()}`;
  const result = await createUnifiedCase(db, {
    idempotencyKey,
    caseType: "customer_complaint",
    severity: input.severity || "medium",
    title,
    description,
    customerId: input.customerId,
    bookingId: input.bookingId || null,
    providerId,
    sourceType: "customer_self_report",
    sourceId: input.customerId,
    ownerTeam: "customer_support",
    actorId: input.customerId,
  });
  return result;
}

export async function listCustomerComplaints(db: Db, customerId: string) {
  const rows = await db.prepare("SELECT id,title,status,severity,resolution_note,created_at FROM unified_cases WHERE customer_id=? AND case_type='customer_complaint' ORDER BY created_at DESC LIMIT 30").bind(customerId).all<Row>();
  return rows.results.map((r: Row) => ({ id: String(r.id), title: String(r.title), status: String(r.status), severity: String(r.severity), resolutionNote: r.resolution_note ? String(r.resolution_note) : null, createdAt: Number(r.created_at) }));
}
