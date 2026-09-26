/**
 * Owner decision (QA M1): a groomer may mark arrived or start service only from 60 minutes before to
 * 2 hours after the booked start. A 30 Sept booking was accepted, started, completed and invoiced on 26 Sept.
 * Operations can authorise an exception with a reason; nothing else widens the window in production.
 */
export const SERVICE_WINDOW_EARLY_MINUTES = 60;
export const SERVICE_WINDOW_LATE_MINUTES = 120;
/** The booking_lifecycle_events row Operations writes when it authorises an early or late start. */
export const SERVICE_WINDOW_OVERRIDE_EVENT = "service_window_override_authorised";
export const SERVICE_WINDOW_OVERRIDE_MIN_REASON = 10;

export const ist = (at: number) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at);

export function serviceWindowIssue(action: string, scheduledStart: string, now: number): string | null {
  if (action !== "arrived" && action !== "start_service") return null;
  const start = Date.parse(scheduledStart);
  if (!Number.isFinite(start)) return null;
  const opens = start - SERVICE_WINDOW_EARLY_MINUTES * 60_000, closes = start + SERVICE_WINDOW_LATE_MINUTES * 60_000;
  if (now < opens) return `This job starts ${ist(start)} IST. You can mark arrival or start from ${ist(opens)} IST.`;
  if (now > closes) return `This job was due ${ist(start)} IST. Ask operations to reschedule it or authorise a late start.`;
  return null;
}

/** When arrive/start opens and closes for a booked start, or null when the start is not a date. */
export function serviceWindowBounds(scheduledStart: string): { opensAt: number; closesAt: number } | null {
  const start = Date.parse(scheduledStart);
  if (!Number.isFinite(start)) return null;
  return { opensAt: start - SERVICE_WINDOW_EARLY_MINUTES * 60_000, closesAt: start + SERVICE_WINDOW_LATE_MINUTES * 60_000 };
}

export type ServiceWindowOverride = { authorisedBy: string; authorisedAt: number; reason: string; scheduledStart: string | null };

/** Two booked starts are the same instant, whatever ISO spelling each was stored with. */
export function sameScheduledStart(a: unknown, b: unknown): boolean {
  const left = Date.parse(String(a ?? "")), right = Date.parse(String(b ?? ""));
  return Number.isFinite(left) && left === right;
}

/** The booking_lifecycle_events row /api/grooming-booking-change writes when it moves a Grooming booking. */
export const BOOKING_RESCHEDULED_EVENT = "booking_rescheduled";

/**
 * An override is granted for ONE booked start and is stored with it (detail.scheduledStart). It applies only
 * while the booking still starts then AND has not been rescheduled since it was granted: once the booking
 * moves, the old override no longer lets the groomer arrive or start - not even if the booking is later moved
 * back to the same time - and Operations must authorise the booked time again. An override stored without a
 * booked start cannot be tied to one and never applies. `current` is the newest override that applies;
 * `earlier` lists, newest first, the ones that no longer apply (an older authorisation for the same booked
 * time that still applies is simply superseded by `current`, so it is in neither).
 * `lastRescheduledAt` is the occurred_at of the booking's latest BOOKING_RESCHEDULED_EVENT, if any.
 */
export function serviceWindowOverrides(rows: ReadonlyArray<Record<string, unknown>>, scheduledStart: string, lastRescheduledAt: number | null = null): { current: ServiceWindowOverride | null; earlier: ServiceWindowOverride[] } {
  const all = rows.map((row): ServiceWindowOverride => {
    let detail: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(String(row.detail_json ?? "{}")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>; } catch { detail = {}; }
    return { authorisedBy: String(row.actor_id ?? ""), authorisedAt: Number(row.occurred_at ?? 0), reason: String(detail.reason ?? ""), scheduledStart: typeof detail.scheduledStart === "string" ? detail.scheduledStart : null };
  }).sort((a, b) => b.authorisedAt - a.authorisedAt);
  // Same millisecond as the move: an override that names the NEW start can only have been granted after it.
  const applies = (item: ServiceWindowOverride) => sameScheduledStart(item.scheduledStart, scheduledStart) && !(Number.isFinite(lastRescheduledAt) && Number(lastRescheduledAt) > item.authorisedAt);
  const current = all.find(applies) ?? null;
  return { current, earlier: all.filter(item => !applies(item)) };
}
