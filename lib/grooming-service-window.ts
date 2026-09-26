/**
 * Owner decision (QA M1): a groomer may mark arrived or start service only from 60 minutes before to
 * 2 hours after the booked start. A 30 Sept booking was accepted, started, completed and invoiced on 26 Sept.
 * Operations can authorise an exception with a reason; nothing else widens the window in production.
 */
export const SERVICE_WINDOW_EARLY_MINUTES = 60;
export const SERVICE_WINDOW_LATE_MINUTES = 120;

const ist = (at: number) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at);

export function serviceWindowIssue(action: string, scheduledStart: string, now: number): string | null {
  if (action !== "arrived" && action !== "start_service") return null;
  const start = Date.parse(scheduledStart);
  if (!Number.isFinite(start)) return null;
  const opens = start - SERVICE_WINDOW_EARLY_MINUTES * 60_000, closes = start + SERVICE_WINDOW_LATE_MINUTES * 60_000;
  if (now < opens) return `This job starts ${ist(start)} IST. You can mark arrival or start from ${ist(opens)} IST.`;
  if (now > closes) return `This job was due ${ist(start)} IST. Ask operations to reschedule it or authorise a late start.`;
  return null;
}
