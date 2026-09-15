/**
 * ONE definition of "what day is it" for a business that runs in IST. [R3E-IST-DAY]
 *
 * The People surfaces each derived the calendar day in UTC, so every one of them rolled over at
 * 05:30 IST rather than at midnight:
 *
 *   lib/attendance-leave.ts  recordAttendance stamped work_date with toISOString().slice(0,10) and
 *                            grouped the day's events with substr(datetime(...,'unixepoch'),1,10).
 *                            A single 02:00-11:00 IST shift became TWO rows - a fabricated previous
 *                            day flagged missing_checkout and a today row with no check-in and no
 *                            worked minutes.
 *   app/team/people/time     periodLockBody bounded the payroll lock with utcDayStart/utcDayEnd, so a
 *                            lock typed as "1 Sep - 14 Sep" really ran 1 Sep 05:30 IST -> 15 Sep 05:29
 *                            IST: a check-in on the 15th was refused and one at 02:00 on the 1st was
 *                            accepted, and filed against August.
 *   lib/people-reports.ts    bounded the payroll register against UTC day edges while an IST payroll
 *                            month begins at 18:30Z the previous day, so an AUGUST report returned
 *                            every September payroll row.
 *   lib/manager-dashboard.ts derived `today` the same way, so "As of", "Today's achievement" and
 *                            "Talk time today" all rolled at 05:30 IST.
 *
 * The rule the repository already knows - /team/people/onboarding's `T00:00:00+05:30` and
 * lib/control-tower.ts's toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"}) - lives here once so a
 * screen, an engine and a SQL GROUP BY cannot drift apart again.
 *
 * IST is a fixed +05:30 offset with no daylight saving, which is why a constant offset is exact here
 * and why the SQL form below can be written as an unconditional '+5 hours','+30 minutes' modifier.
 */

/** India Standard Time is UTC+05:30 all year; there is no daylight saving to model. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** ECMA-262 caps a Date time value at +-8.64e15 ms; one millisecond past it throws a RangeError. */
const MAX_TIME_VALUE_MS = 8_640_000_000_000_000;

/**
 * The IST calendar date (YYYY-MM-DD) an epoch millisecond falls on.
 *
 * Clamped rather than thrown: lib/people-reports.ts accepts the proven +-8.64e15 boundary as a period
 * bound, and shifting it by the IST offset would otherwise push `new Date(...)` past the time-value
 * limit and turn a query string back into a 500.
 */
export function istDayString(ms: number) {
  const shifted = Number(ms) + IST_OFFSET_MS;
  if (!Number.isFinite(shifted)) return "";
  return new Date(Math.min(Math.max(shifted, -MAX_TIME_VALUE_MS), MAX_TIME_VALUE_MS)).toISOString().slice(0, 10);
}

/** 00:00:00.000 IST on a YYYY-MM-DD date, in epoch milliseconds. NaN when the date is unreadable. */
export function istDayStart(date: string) {
  return new Date(`${String(date ?? "").trim()}T00:00:00.000+05:30`).getTime();
}

/** 23:59:59.999 IST on a YYYY-MM-DD date, in epoch milliseconds. NaN when the date is unreadable. */
export function istDayEnd(date: string) {
  return new Date(`${String(date ?? "").trim()}T23:59:59.999+05:30`).getTime();
}

/** The first instant of the IST month that an epoch millisecond falls in. */
export function istMonthStartMs(ms: number) {
  const day = istDayString(ms);
  return day ? istDayStart(`${day.slice(0, 7)}-01`) : Number.NaN;
}

/**
 * The SQLite expression for "the IST calendar date of this epoch-millisecond column".
 *
 * `datetime(col/1000,'unixepoch')` is UTC; the two modifiers shift it into IST before the date is
 * taken, so a GROUP BY over this agrees exactly with istDayString() in JavaScript.
 */
export function sqlIstDay(column: string) {
  return `substr(datetime(${column}/1000,'unixepoch','+5 hours','+30 minutes'),1,10)`;
}
