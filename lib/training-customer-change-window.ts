/** Founder policy: customer changes are permitted until exactly 24 hours before a session. */
export const TRAINING_CUSTOMER_CHANGE_WINDOW_MS = 24 * 60 * 60_000;
export const TRAINING_CUSTOMER_CHANGE_CLOSED_MESSAGE = "Sessions can be changed online up to 24 hours before they start. Past sessions, invalid schedules and changes within 24 hours require PawSpace support; a missed session counts as used.";
export function canCustomerRescheduleTraining(scheduledStart: unknown, now = Date.now()): boolean {
  const startsAt = typeof scheduledStart === "string" ? Date.parse(scheduledStart) : NaN;
  return Number.isFinite(startsAt) && Number.isFinite(now) && startsAt - now >= TRAINING_CUSTOMER_CHANGE_WINDOW_MS;
}
