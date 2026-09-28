import { governedJsonError } from "./governed-http-error";

type CompletionEventInput = {
  bookingId: string;
  providerId: string;
  actorId: string;
  occurredAt: number;
  eventId?: string;
  detail: Record<string, unknown>;
};

/** Record current payment truth in the same statement that writes completion history.
 * A pre-lease snapshot can be stale after a capture/refund. This is an audit write,
 * never payment authority: it changes neither payment state nor payout eligibility.
 */
export async function recordGroomingCompletionEvent(db: D1Database, input: CompletionEventInput) {
  const eventId = input.eventId ?? crypto.randomUUID();
  const result = await db.prepare(`
    INSERT INTO booking_lifecycle_events
      (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at)
    SELECT ?,b.id,?,'booking',b.id,?,json_set(?,'$.paymentStatus',p.status),?
    FROM canonical_bookings b
    JOIN booking_payments p ON p.booking_id=b.id AND p.customer_id=b.customer_id
    WHERE b.id=? AND b.provider_id=? AND b.service_code='grooming' AND b.status='completed'
    ON CONFLICT(id) DO NOTHING
  `).bind(eventId, "service_completed", input.actorId, JSON.stringify(input.detail),
    input.occurredAt, input.bookingId, input.providerId).run();
  if (Number(result.meta?.changes || 0) !== 1) {
    const existing = await db.prepare(`SELECT e.id FROM booking_lifecycle_events e
      JOIN canonical_bookings b ON b.id=e.booking_id
      JOIN booking_payments p ON p.booking_id=b.id AND p.customer_id=b.customer_id
      WHERE e.id=? AND e.booking_id=? AND e.event_type='service_completed'
        AND b.provider_id=? AND b.service_code='grooming' AND b.status='completed'`)
      .bind(eventId, input.bookingId, input.providerId).first();
    if (existing) return { eventId, duplicatePrevented: true };
    throw governedJsonError({
      error: "Completion payment history could not be recorded. Refresh the booking and contact Operations if it remains unavailable.",
      code: "completion_payment_history_unavailable",
    }, 409);
  }
  return { eventId };
}
