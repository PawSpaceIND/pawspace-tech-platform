type Db = Pick<D1Database, "prepare">;
type Row = Record<string, unknown>;
type Occurrence = {start: string; end: string};

/** Include every local calendar day touched, including overnight stays. */
export function schedulingDates(occurrences: Occurrence[], offsetMinutes: number): string[] {
  const dates = new Set<string>();
  for (const occurrence of occurrences) {
    const first = new Date(Date.parse(occurrence.start) + offsetMinutes * 60_000).toISOString().slice(0, 10);
    const last = new Date(Date.parse(occurrence.end) + offsetMinutes * 60_000).toISOString().slice(0, 10);
    for (let day = Date.parse(first); day <= Date.parse(last); day += 86_400_000) dates.add(new Date(day).toISOString().slice(0, 10));
  }
  return [...dates].sort();
}

/** Two request-local reads replace provider × session database round trips.
 * Never reuse this snapshot across previews or reservations: a new request must see new leave/rosters.
 */
export function schedulingCalendarReads(db: Db, cityId: string, occurrences: Occurrence[], offsetMinutes: number) {
  const dates = schedulingDates(occurrences, offsetMinutes);
  const start = new Date(Math.min(...occurrences.map(item => Date.parse(item.start)))).toISOString();
  const end = new Date(Math.max(...occurrences.map(item => Date.parse(item.end)))).toISOString();
  let roster: Promise<Row[]> | undefined;
  let leave: Promise<Row[]> | undefined;
  return {
    async availability(providerId: string, date: string) {
      roster ??= db.prepare("SELECT * FROM scheduling_availability WHERE city_id=? AND date>=? AND date<=?")
        .bind(cityId, dates[0], dates[dates.length - 1]).all<Row>().then(result => result.results);
      const rows = (await roster).filter(row => String(row.provider_id) === providerId && String(row.date) === date);
      const authored = rows.filter(row => ["partner_app", "operations", "roster"].includes(String(row.source)));
      return authored.length ? authored : rows;
    },
    async unavailable(providerId: string, scheduledStart: string, scheduledEnd: string) {
      leave ??= db.prepare("SELECT u.provider_id,u.starts_at,u.ends_at FROM provider_unavailability u JOIN provider_capacity_profiles p ON p.id=u.provider_id WHERE p.city_id=? AND u.status='active' AND julianday(u.starts_at)<julianday(?) AND julianday(u.ends_at)>julianday(?)")
        .bind(cityId, end, start).all<Row>().then(result => result.results);
      return (await leave).some(row => String(row.provider_id) === providerId && Date.parse(String(row.starts_at)) < Date.parse(scheduledEnd) && Date.parse(String(row.ends_at)) > Date.parse(scheduledStart));
    },
  };
}
