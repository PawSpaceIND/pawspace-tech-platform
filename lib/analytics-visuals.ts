export type DateRange = { from: string; to: string };
const DAY = 86400000;
export function dateKey(date: Date) { return date.toISOString().slice(0, 10); }
export function rangeDays(range: DateRange) {
  const start = Date.parse(range.from + "T00:00:00Z"), end = Date.parse(range.to + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(end) || dateKey(new Date(start)) !== range.from || dateKey(new Date(end)) !== range.to || start > end) throw new Error("Choose valid dates in ascending order.");
  return Math.round((end - start) / DAY) + 1;
}
export function previousRange(range: DateRange): DateRange {
  const days = rangeDays(range), start = Date.parse(range.from + "T00:00:00Z");
  return { from: dateKey(new Date(start - days * DAY)), to: dateKey(new Date(start - DAY)) };
}
export function recentRange(days: number, now = new Date()): DateRange {
  // Complete days in the operating timezone: today's partial day is excluded.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const end = Date.parse(today + "T00:00:00Z") - DAY;
  return { from: dateKey(new Date(end - (days - 1) * DAY)), to: dateKey(new Date(end)) };
}
export function comparisonLabel(current: number, previous: number) {
  if (previous === 0) return current === 0 ? "No change · both periods zero" : "No percentage baseline · previous period zero";
  const change = (current - previous) / Math.abs(previous) * 100;
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}% vs previous period`;
}
export function dailyBookingSeries(bookings: Record<string, unknown>[], capturedFor: (booking: Record<string, unknown>) => number) {
  const days = new Map<string, { date: string; gmv: number; collected: number; bookings: number }>();
  for (const booking of bookings) {
    const date = String(booking.scheduled_start).slice(0, 10);
    const row = days.get(date) || { date, gmv: 0, collected: 0, bookings: 0 };
    row.bookings++;
    if (!["cancelled", "draft"].includes(String(booking.status))) {
      row.gmv += Number(booking.total_amount || 0);
      row.collected += capturedFor(booking);
    }
    days.set(date, row);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function alignDaily(range: DateRange, current: { date: string; gmv: number }[], previous: { date: string; gmv: number }[]) {
  const count = rangeDays(range);
  if (count > 366) throw new Error("Choose a range of 366 days or fewer.");
  const prior = previousRange(range), nowMap = new Map(current.map(row => [row.date, row.gmv])), oldMap = new Map(previous.map(row => [row.date, row.gmv]));
  return Array.from({ length: count }, (_, i) => {
    const date = dateKey(new Date(Date.parse(range.from + "T00:00:00Z") + i * DAY));
    const previousDate = dateKey(new Date(Date.parse(prior.from + "T00:00:00Z") + i * DAY));
    return { date, previousDate, current: nowMap.get(date) ?? 0, previous: oldMap.get(previousDate) ?? 0 };
  });
}
