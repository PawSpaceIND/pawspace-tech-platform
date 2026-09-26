/**
 * Pet Taxi pickup handover opens 30 minutes before the booked pickup (lib/taxi-lifecycle.ts). Suites that book a
 * ride hours ahead and then drive it straight through use this to arrive at pickup time first: it moves only a
 * pickup that is still more than 30 minutes away, to 10 minutes from now.
 */
export async function atPickupTime(db, bookingId) {
  const now = Date.now();
  await db.prepare("UPDATE canonical_bookings SET scheduled_start=? WHERE id=? AND scheduled_start>?")
    .bind(new Date(now + 10 * 60_000).toISOString(), bookingId, new Date(now + 30 * 60_000).toISOString()).run();
}
