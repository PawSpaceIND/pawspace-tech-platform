/**
 * Single source of truth for rendering booking times to customers. Every PawSpace booking is
 * scheduled and stored against India Standard Time; a page that formats it with the *device*
 * time zone (the default of `Date#toLocaleString`) silently relabels it — a 7:00 AM IST walk
 * shown to a browser whose OS clock is UTC reads as "1:30 am", with no zone in sight (CUST-L-D13).
 *
 * The mobile-app surfaces already pinned `timeZone:"Asia/Kolkata"` piecemeal, each with its own
 * copy of the Intl options. This module gives every V2 and legacy customer surface the same,
 * explicitly IST-labelled formatting so a page cannot fall back to the device zone by omission.
 *
 * Stored values are never touched here — every function only changes how a timestamp is DISPLAYED.
 */

export const INDIA_TIME_ZONE = "Asia/Kolkata";
const IST_SUFFIX = " IST";

function parseInstant(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function isValid(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

/** Date + time in IST, labelled, e.g. "24 Sept, 7:00 am IST" (add `weekday` for "Thu, 24 Sept, 7:00 am IST"). */
export function formatIndiaDateTime(
  value: string | number | Date,
  options: { weekday?: boolean; year?: boolean; fallback?: string } = {},
): string {
  const date = parseInstant(value);
  if (!isValid(date)) return options.fallback ?? "Schedule pending";
  const formatted = new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    ...(options.weekday ? { weekday: "short" as const } : {}),
    day: "numeric",
    month: "short",
    ...(options.year ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${formatted}${IST_SUFFIX}`;
}

/** Time only, in IST, labelled, e.g. "2:00 pm IST" — for the closing half of a start-to-end range. */
export function formatIndiaTime(value: string | number | Date, fallback = "Schedule pending"): string {
  const date = parseInstant(value);
  if (!isValid(date)) return fallback;
  const formatted = new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${formatted}${IST_SUFFIX}`;
}

/** A start -> end window, both ends labelled in IST, e.g. "24 Sept, 7:00 am IST -> 7:30 am IST". */
export function formatIndiaRange(
  start: string | number | Date,
  end: string | number | Date,
  options: { weekday?: boolean; year?: boolean } = {},
): string {
  return `${formatIndiaDateTime(start, options)} → ${formatIndiaTime(end)}`;
}

/** Medium date-style + short time-style in IST, labelled, e.g. "24 Sept 2026, 7:00 am IST". */
export function formatIndiaDateTimeMedium(value: string | number | Date, fallback = "Schedule pending"): string {
  const date = parseInstant(value);
  if (!isValid(date)) return fallback;
  const formatted = new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  return `${formatted}${IST_SUFFIX}`;
}
