// Training session-calendar PREVIEW helpers (display only).
//
// The number of sessions actually booked and their cadence are decided server-side
// by reserveUatSchedule (occurrences: quote.sessions + weekdays). These functions
// only build the on-screen preview list and must never influence how many
// occurrences are reserved — the preview is an honest sample of the schedule, not
// the source of truth for the booking.

const IST_OFFSET = 330 * 60_000;

/**
 * How many session dates to preview. Uses the real package session count once the
 * catalogue has loaded, and falls back to 4 while plan.sessions is still 0 (loading).
 */
export function trainingPreviewCount(planSessions: number): number {
  return Number.isFinite(planSessions) && planSessions > 0 ? Math.floor(planSessions) : 4;
}

/**
 * Build `count` preview dates: the selected start is session 1, followed by each
 * subsequent date that falls on one of `weekdays` at `hour` IST.
 *
 * The search window scales with `count` (max(40, count*8) days) so weekly cadences
 * on the 12- and 16-session plans still fill out — 16 weekly Saturdays span ~15
 * weeks, which the previous fixed 40-day / 4-date cap could not reach.
 */
export function trainingSessionPreviewDates(
  start: Date,
  weekdays: number[],
  hour: number,
  count: number,
): Date[] {
  const target = Math.max(1, Math.floor(count) || 1);
  const days = weekdays && weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6];
  const result: Date[] = [start];
  const maxOffset = Math.max(40, target * 8);
  for (let offset = 1; offset <= maxOffset && result.length < target; offset++) {
    const shifted = new Date(start.getTime() + IST_OFFSET);
    const candidate = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offset, hour, 0) - IST_OFFSET,
    );
    const weekday = new Date(candidate.getTime() + IST_OFFSET).getUTCDay();
    if (days.includes(weekday)) result.push(candidate);
  }
  return result;
}
