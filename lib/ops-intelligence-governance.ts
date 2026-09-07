/**
 * Operations intelligence - the ops-efficiency lever, computed from real booking history.
 *
 * Provider ranking is advisory only: this module never mutates assignment state. Rankings are
 * deterministic, expose degraded data sources, and can be constrained to currently governed
 * provider capacity profiles so recommendations do not drift away from scheduler truth.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dow = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();

async function readRows(db: Db, source: string, sql: string, binds: unknown[], degradedSources: string[]) {
  try {
    return (await db.prepare(sql).bind(...binds).all<Row>()).results;
  } catch {
    degradedSources.push(source);
    return [];
  }
}

/**
 * Rank providers for a booking. The optional city/zone filters mirror provider-capacity governance
 * without autonomously assigning anyone. candidateProviderIds remains supported for a scheduler
 * shortlist. Scores are sorted on full precision, then provider id, and only rounded for display.
 */
export async function rankProvidersForBooking(db: Db, input: { serviceCode: string; candidateProviderIds?: string[]; cityId?: string; zoneId?: string; at?: number }) {
  const serviceCode = String(input.serviceCode || "").trim();
  if (!serviceCode) throw new Error("A service is required");
  const at = input.at ?? Date.now();
  const nowIso = new Date(at).toISOString();
  const effectiveDate = nowIso.slice(0, 10);
  const degradedSources: string[] = [];

  const work = await readRows(db, "provider_work_orders", "SELECT provider_id,MAX(provider_name) provider_name,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled,SUM(CASE WHEN status IN ('assigned','awaiting_acceptance','in_progress') AND scheduled_start>=? THEN 1 ELSE 0 END) upcoming_load FROM provider_work_orders WHERE service_code=? GROUP BY provider_id", [nowIso, serviceCode], degradedSources);
  const ratings = await readRows(db, "booking_ratings", "SELECT provider_id,AVG(stars) avg_stars,COUNT(*) rating_count FROM booking_ratings WHERE service_code=? GROUP BY provider_id", [serviceCode], degradedSources);

  const governedRows = await readRows(db, "provider_capacity_profiles", "SELECT id,city_id,services_json,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)", [effectiveDate, effectiveDate], degradedSources);
  const governedIds = new Set(governedRows.filter(row => {
    let services: string[] = [], zones: string[] = [];
    try { services = JSON.parse(String(row.services_json || "[]")); } catch { services = []; }
    try { zones = JSON.parse(String(row.zones_json || "[]")); } catch { zones = []; }
    if (!services.includes(serviceCode)) return false;
    if (input.cityId && String(row.city_id) !== input.cityId) return false;
    if (input.zoneId && !zones.includes(input.zoneId)) return false;
    return true;
  }).map(row => String(row.id)));

  const ratingBy = new Map(ratings.map(r => [String(r.provider_id), { avg: Number(r.avg_stars), count: Number(r.rating_count) }]));
  const shortlist = input.candidateProviderIds && input.candidateProviderIds.length ? new Set(input.candidateProviderIds) : null;
  const ranked = work
    .filter(r => (!shortlist || shortlist.has(String(r.provider_id))) && governedIds.has(String(r.provider_id)))
    .map(r => {
      const completed = Number(r.completed), cancelled = Number(r.cancelled), upcomingLoad = Number(r.upcoming_load);
      const rating = ratingBy.get(String(r.provider_id)) || { avg: 0, count: 0 };
      const terminal = completed + cancelled;
      const completionRate = terminal > 0 ? completed / terminal : 0.5;
      const ratingConfidence = clamp01(rating.count / 5);
      const ratingScore = rating.count > 0 ? (rating.avg / 5) * ratingConfidence + 0.6 * (1 - ratingConfidence) : 0.6;
      const availability = 1 / (1 + upcomingLoad);
      const experience = clamp01(completed / 10);
      const rawScore = clamp01(0.30 * completionRate + 0.30 * ratingScore + 0.25 * availability + 0.15 * experience);
      return { providerId: String(r.provider_id), providerName: String(r.provider_name || r.provider_id), rawScore, score: round2(rawScore), factors: { completionRate: round2(completionRate), avgRating: round2(rating.avg), ratingCount: rating.count, upcomingLoad, completed } };
    })
    .sort((a, b) => b.rawScore - a.rawScore || a.providerId.localeCompare(b.providerId))
    .map(({ rawScore: _rawScore, ...provider }) => provider);

  return {
    serviceCode,
    method: "history_weighted_rank_v2",
    recommendationOnly: true,
    governedCandidateFilter: true,
    degraded: degradedSources.length > 0,
    degradedSources: [...new Set(degradedSources)],
    ranked,
  };
}

/** Day-of-week seasonal demand forecast from the trailing window (default 28 days), for staffing. */
export async function forecastDemand(db: Db, input: { serviceCode?: string; cityId?: string; horizonDays?: number; basisDays?: number; at?: number }) {
  const at = input.at ?? Date.now();
  const basisDays = Math.max(7, Math.min(Number(input.basisDays) || 28, 120));
  const horizonDays = Math.max(1, Math.min(Number(input.horizonDays) || 14, 60));
  const since = at - basisDays * DAY;
  const svc = String(input.serviceCode || "").trim(), city = String(input.cityId || "").trim();
  const degradedSources: string[] = [];
  const rows = await readRows(db, "canonical_bookings", "SELECT date(created_at/1000,'unixepoch') day,COUNT(*) n FROM canonical_bookings WHERE created_at>=? AND (?='' OR service_code=?) AND (?='' OR city_id=?) GROUP BY day", [since, svc, svc, city, city], degradedSources);
  const byDay = new Map(rows.map(r => [String(r.day), Number(r.n)]));
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
  return { serviceCode: svc || "all", cityId: city || "all", method: "day_of_week_seasonal_v1", basisDays, horizonDays, dailyAverage, forecastTotal, forecast, degraded: degradedSources.length > 0, degradedSources: [...new Set(degradedSources)] };
}
