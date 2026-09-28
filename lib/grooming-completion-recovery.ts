import type { CompletionFinanceFact } from "./service-completion-finance";
import type { CollectionGate, recordedCashCollection } from "./service-cash-collection";

/** Server-authored receipt committed with the existing provider lifecycle event. */
export type GroomingCompletionReceipt = {
  version: 1;
  bookingId: string;
  customerId: string;
  providerId: string;
  occurredAt: number;
  eventId: string;
  paymentId: string | null;
  sessionsToConsume: number;
  finance: CompletionFinanceFact;
  settledGate: CollectionGate;
  recordedCash: Awaited<ReturnType<typeof recordedCashCollection>>;
};

/** Recover outputs only from the durable, matching completed transition, never request data. */
export async function readGroomingCompletionReceipt(db: D1Database, bookingId: string, providerId: string) {
  const row = await db.prepare(`SELECT e.detail_json,b.customer_id FROM provider_lifecycle_events e
    JOIN canonical_bookings b ON b.id=e.booking_id
    JOIN provider_work_orders w ON w.booking_id=b.id
    WHERE e.booking_id=? AND e.scope_id=e.booking_id AND e.service_code='grooming'
      AND e.to_status='completed' AND e.provider_id=?
      AND b.service_code='grooming' AND b.status='completed' AND w.status='completed'
      AND b.provider_id=e.provider_id AND w.provider_id=e.provider_id
    ORDER BY e.created_at DESC,e.id DESC LIMIT 1`).bind(bookingId, providerId)
    .first<{ detail_json: string; customer_id: string }>();
  if (!row) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(row.detail_json); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const parsed = decoded as { detail?: { completionReceipt?: GroomingCompletionReceipt } };
  const receipt = parsed.detail?.completionReceipt;
  if (!receipt || receipt.version !== 1 || receipt.bookingId !== bookingId
      || receipt.providerId !== providerId || receipt.customerId !== row.customer_id
      || !receipt.eventId || !Number.isFinite(receipt.occurredAt)
      || receipt.finance?.bookingId !== bookingId || !receipt.settledGate) return null;
  return receipt;
}
