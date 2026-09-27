// A cancelled or refunded booking is not money still to collect, even while its refund is pending.
const CLOSED_BOOKING = new Set(["cancelled", "canceled", "refunded", "closed"]);
const CLOSED_PAYMENT = new Set(["paid", "captured", "completed", "refunded", "refund_pending", "refund_requested", "partially_refunded", "cancelled", "canceled"]);

/** Bookings the Command Center counts as "Payment pending" and in "Collectible balance". */
export function awaitingPayment(booking: Record<string, unknown>) {
  if (CLOSED_BOOKING.has(String(booking.status))) return false;
  const status = String(booking.payment_status);
  // A captured deposit is not a settled booking. Use the canonical stage's due-now amount,
  // which is collectable even before its deadline. This count does not mean overdue.
  if (["paid", "captured", "completed"].includes(status)) {
    const due = Number(booking.amount_due_now);
    return Number.isFinite(due) && due > 0;
  }
  return !CLOSED_PAYMENT.has(status);
}
