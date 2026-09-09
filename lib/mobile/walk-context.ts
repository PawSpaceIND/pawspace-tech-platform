export function resolveActiveWalkContext(
  bookingId: string,
  sessionId: string,
  bookings: Array<{ id: string; provider_id: string; sessions?: Array<Record<string, unknown>> }>,
  proof: { bookingId: string; providerId: string; sandboxOnly: boolean },
) {
  const booking = bookings.find(item => item.id === bookingId);
  const session = booking?.sessions?.find(item => String(item.id) === sessionId);
  if (!booking || !session || proof.bookingId !== bookingId || proof.providerId !== booking.provider_id || !proof.sandboxOnly) {
    throw new Error("Open an authorised internal-test walk from your job list.");
  }
  if (session.status !== "in_progress") {
    throw new Error("Start this walk from your job list before recording its route.");
  }
  return { bookingId, sessionId, providerId: booking.provider_id };
}
