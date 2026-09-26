/** Owner decision (SIT-04): a Pet Sitting Home Visit is one 60-minute visit; longer care is more visits or Overnight. */
export const HOME_VISIT_MINUTES = 60;
/** Explicit customer-selected times are interpreted in the Indian service timezone. */
function instant(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const value = Date.parse(`${date}T${time}:00+05:30`);
  if (!Number.isFinite(value) || new Date(value + 19_800_000).toISOString().slice(0, 10) !== date) return NaN;
  return value;
}
/** IST date and time at which a Home Visit starting at the chosen date and time ends. */
export function homeVisitEnd(date: string, time: string) {
  const from = instant(date, time);
  if (!Number.isFinite(from)) return null;
  const end = new Date(from + HOME_VISIT_MINUTES * 60_000 + 19_800_000).toISOString();
  return { date: end.slice(0, 10), time: end.slice(11, 16) };
}
export function stayCareWindow(start: string, end: string, startTime: string, endTime: string) {
  const from = instant(start, startTime), to = instant(end, endTime);
  const valid = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const hours = valid ? (to - from) / 3_600_000 : 0;
  const overnight = hours > 10;
  const nights = valid ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) : 0;
  const days = Math.floor(hours / 24), remainder = hours % 24;
  const duration = hours >= 24 ? `${days} ${days === 1 ? "night" : "nights"}${remainder ? ` + ${Number(remainder.toFixed(2))} hours` : ""}` : `${Number(hours.toFixed(2))} ${hours === 1 ? "hour" : "hours"}`;
  const stamp = (value: number) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(value);
  return {
    valid, hours, nights, duration, overnight,
    scheduledStart: new Date(from), scheduledEnd: new Date(to),
    boardingPackage: hours <= 4 ? "boarding-4h" : hours <= 10 ? "boarding-10h" : "boarding-24h",
    sittingPackage: overnight ? "sitting-overnight" : hours * 60 <= HOME_VISIT_MINUTES ? "sitting-visit-60" : null,
    summary: valid ? `${duration} · ${stamp(from)} → ${stamp(to)}` : "Choose a check-out after check-in.",
    key: JSON.stringify([start, startTime, end, endTime]),
  };
}
