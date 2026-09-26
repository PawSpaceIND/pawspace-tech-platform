// A cancelled or refunded booking is not money still to collect, even while its refund is pending.
const CLOSED_BOOKING = new Set(["cancelled", "canceled", "refunded", "closed"]);
const CLOSED_PAYMENT = new Set(["paid", "captured", "completed", "refunded", "refund_pending", "refund_requested", "partially_refunded", "cancelled", "canceled"]);

/** Bookings the Command Center counts as "Payment pending" and in "Open revenue". */
export function awaitingPayment(booking: Record<string, unknown>) {
  return !CLOSED_BOOKING.has(String(booking.status)) && !CLOSED_PAYMENT.has(String(booking.payment_status));
}
