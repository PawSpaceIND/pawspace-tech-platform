// Fail-closed persisted-evidence gates for the separate, explicitly authorized spoken-sale probe.
export function assertSaleBaseline(report) {
  if (report.aiPaused || report.dialed !== false) throw Error('Unpaused no-phone context required');
  if (!Array.isArray(report.pendingOffers) || report.pendingOffers.length) throw Error('Existing pending offer prevents a new test sale');
  if (!Array.isArray(report.completedBookings)) throw Error('Booking baseline required');
}
export function assertSpokenQuote(before, after, now = Date.now()) {
  assertSaleBaseline(before);
  if (after.aiPaused || after.dialed !== false) throw Error('Quote context is unsafe');
  if (JSON.stringify([...before.completedBookings].sort()) !== JSON.stringify([...after.completedBookings].sort())) throw Error('Booking changed before spoken confirmation');
  if (after.pendingOffers?.length !== 1) throw Error('Exactly one pending offer required');
  const offer = after.pendingOffers[0];
  if (!offer.id || !offer.summary || !Number.isFinite(Number(offer.expiresAt)) || Number(offer.expiresAt) <= now) throw Error('Fresh persisted quote required');
  return offer.id;
}
export function assertSpokenBooking(before, after) {
  if (after.aiPaused || after.dialed !== false || after.pendingOffers?.length) throw Error('Confirmation did not finish safely');
  const added = after.completedBookings?.filter(id => !before.completedBookings.includes(id));
  if (added?.length !== 1 || !added[0]) throw Error('Exactly one new voice booking required');
  return added[0];
}
export function assertSandboxSale(report, bookingId) {
  if (report.dialed !== false || report.synthetic !== true || report.replayChecked !== true || report.captured !== true) throw Error('Synthetic sandbox capture and replay required');
  const b = report.booking;
  if (b?.id !== bookingId || b.booking_status !== 'confirmed' || b.payment_status !== 'captured' || !b.gateway_order_id || b.currency !== 'INR' || !(Number(b.payment_amount) > 0) || Number(b.total_amount) !== Number(b.payment_amount)) throw Error('Canonical booking/payment evidence mismatch');
}

export function spokenInputComplete(transcript, reply, expected) {
  const text=String(transcript||'');
  return Boolean((expected instanceof RegExp && expected.test(text)) || String(reply||'').trim());
}
