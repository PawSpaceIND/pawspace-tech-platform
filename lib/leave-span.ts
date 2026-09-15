/**
 * How many days a leave request covers, derived from its own dates. [R3E-LEAVE-UNITS]
 *
 * `leave_requests.units` is what the balance is debited by, and it was whatever the requester typed:
 * it had no relationship to start_date/end_date at all. Reproduced against the running product, all
 * three of these were accepted with 200 -
 *
 *   2027-01-01 → 2027-01-10 with units 1   a ten-day absence charged to one day of balance
 *   2027-02-10 → 2027-02-01 with units 1   the end date BEFORE the start date
 *   2027-03-01 → 2027-03-01 with units 9   one day charged as nine
 *
 * - and on /me the employee types the "Days" field themselves, so the first is a form anyone can fill
 * in. lib/attendance-leave.ts requestLeave() now refuses a request whose units disagree with its
 * dates, and the two leave forms compute the number rather than asking for it.
 *
 * It lives in its own module because both of those forms are "use client" components: importing this
 * out of lib/attendance-leave.ts would drag the whole D1-backed engine into the browser bundle, which
 * is the failure tests/client-bundle-server-isolation.test.mjs exists to catch. Pure calendar
 * arithmetic, no timezone of its own - both ends are parsed at UTC midnight so the offset cancels.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive whole days from start to end, or null for an unreadable or inverted range. */
export function leaveSpanDays(startDate: string, endDate: string) {
  const from = String(startDate ?? "").trim(), to = String(endDate ?? "").trim();
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00.000Z`), b = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** The units a request over this range may carry: the whole span, or one half day less. */
export function leaveUnitsFor(startDate: string, endDate: string, halfDay: boolean) {
  const span = leaveSpanDays(startDate, endDate);
  if (span === null) return null;
  return halfDay ? span - 0.5 : span;
}
