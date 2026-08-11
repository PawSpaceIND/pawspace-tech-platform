/**
 * Operations intelligence - the ops-efficiency lever, computed from real booking history.
 *
 *   rankProvidersForBooking - ranks candidate providers for a service by an explainable blend of
 *     completion rate, customer rating (confidence-weighted), current upcoming load (availability)
 *     and experience. It RECOMMENDS an order; the actual assignment stays governed by the scheduler
 *     (provider_assignment is a forbidden autonomous action), so this never assigns anyone.
 *   forecastDemand - a transparent day-of-week seasonal forecast of booking volume, to staff ahead
 *     of demand. No black box: every number traces back to the trailing window.
 *
 * Rules/statistics today (no external provider needed); cold-DB safe.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const empty = () => ({ results: [] as Row[] });
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dow = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();

/**
 * Rank providers for a booking. Pass candidateProviderIds to rank a shortlist, or omit to rank every
 * provider with history in the service. Returns a scored, sorted list with the factors behind each.
 */
export async function rankProvidersForBooking(db: Db, input: { serviceCode: string; candidateProviderIds?: string[]; at?: number }) {
  const serviceCode = String(input.serviceCode || "").trim();
  if (!serviceCode) throw new Error("A service is required");
  const nowIso = new Date(input.at ?? Date.now()).toISOString();
  const work = await db.prepare("SELECT provider_id,MAX(provider_name) provider_name,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled,SUM(CASE WHEN status IN ('assigned','awaiting_acceptance','in_progress') AND scheduled_start>=? THEN 1 ELSE 0 END) upcoming_load FROM provider_work_orders WHERE service_code=? GROUP BY provider_id").bind(nowIso, serviceCode).all<Row>().catch(empty);
  const ratings = await db.prepare("SELECT provider_id,AVG(stars) avg_stars,COUNT(*) rating_count FROM booking_ratings WHERE service_code=? GROUP BY provider_id").bind(serviceCode).all<Row>().catch(empty);
  const ratingBy = new Map(ratings.results.map(r => [String(r.provider_id), { avg: Number(r.avg_stars), count: Number(r.rating_count) }]));
  const shortlist = input.candidateProviderIds && input.candidateProviderIds.length ? new Set(input.candidateProviderIds) : null;
  const ranked = work.results
    .filter(r => !shortlist || shortlist.has(String(r.provider_id)))
    .map(r => {
      const completed = Number(r.completed), cancelled = Number(r.cancelled), upcomingLoad = Number(r.upcoming_load);
      const rating = ratingBy.get(String(r.provider_id)) || { avg: 0, count: 0 };
      const terminal = completed + cancelled; // orders that reached an outcome; in-flight ones don't count against completion
      const completionRate = terminal > 0 ? completed / terminal : 0.5;
      const ratingConfidence = clamp01(rating.count / 5);
      const ratingScore = rating.count > 0 ? (rating.avg / 5) * ratingConfidence + 0.6 * (1 - ratingConfidence) : 0.6;
      const availability = 1 / (1 + upcomingLoad);
      const experience = clamp01(completed / 10);
      const score = clamp01(0.30 * completionRate + 0.30 * ratingScore + 0.25 * availability + 0.15 * experience);
      return { providerId: String(r.provider_id), providerName: String(r.provider_name || r.provider_id), score: round2(score), factors: { completionRate: round2(completionRate), avgRating: round2(rating.avg), ratingCount: rating.count, upcomingLoad, completed } };
    })
    .sort((a, b) => b.score - a.score);
  return { serviceCode, method: "history_weighted_rank_v1", recommendationOnly: true, ranked };
}

/** Day-of-week seasonal demand forecast from the trailing window (default 28 days), for staffing. */
export async function forecastDemand(db: Db, input: { serviceCode?: string; cityId?: string; horizonDays?: number; basisDays?: number; at?: number }) {
  const at = input.at ?? Date.now();
  const basisDays = Math.max(7, Math.min(Number(input.basisDays) || 28, 120));
  const horizonDays = Math.max(1, Math.min(Number(input.horizonDays) || 14, 60));
  const since = at - basisDays * DAY;
  const svc = String(input.serviceCode || "").trim(), city = String(input.cityId || "").trim();
  const rows = await db.prepare("SELECT date(created_at/1000,'unixepoch') day,COUNT(*) n FROM canonical_bookings WHERE created_at>=? AND (?='' OR service_code=?) AND (?='' OR city_id=?) GROUP BY day").bind(since, svc, svc, city, city).all<Row>().catch(empty);
  const byDay = new Map(rows.results.map(r => [String(r.day), Number(r.n)]));
  // build day-of-week averages across the basis window (dividing by how many of each weekday occurred)
  const dowTotals = Array(7).fill(0), dowCounts = Array(7).fill(0);
  for (let d = 0; d < basisDays; d++) {
    const date = isoDate(at - (d + 1) * DAY), w = dow(date);
    dowTotals[w] += byDay.get(date) || 0; dowCounts[w] += 1;
  }
  const dowAvg = dowTotals.map((t, i) => (dowCounts[i] ? t / dowCounts[i] : 0));
  const totalInWindow = [...byDay.values()].reduce((s, n) => s + n, 0);
  const dailyAverage = round2(totalInWindow / basisDays);
  const forecast = [];
  for (let d = 1; d <= horizonDays; d++) {
    const date = isoDate(at + d * DAY);
    forecast.push({ date, weekday: date, expectedBookings: round2(dowAvg[dow(date)]) });
  }
  const forecastTotal = round2(forecast.reduce((s, f) => s + f.expectedBookings, 0));
  return { serviceCode: svc || "all", cityId: city || "all", method: "day_of_week_seasonal_v1", basisDays, horizonDays, dailyAverage, forecastTotal, forecast };
}
