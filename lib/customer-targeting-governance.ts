/**
 * Outbound customer-targeting intelligence - a refreshable, ranked "who to target anytime" list.
 *
 * runCustomerTargetingSweep scores every customer from real history and keeps the top N (default
 * 5000) in customer_target_scores, so marketing can pull the best audience at any moment without
 * recomputing. It refreshes on the background scheduler (throttled) and on demand, so scores track
 * behaviour as it changes. Advisory only: this ranks an audience; outbound_contact and
 * campaign_activation remain forbidden autonomous actions, so a human still launches any outreach.
 *
 * Signals (each normalised to 0..1, then weighted): booking frequency, order value (LTV), number of
 * pets, variety of services availed, tenure (days with PawSpace), recency, and a young-pet
 * (puppy/kitten) boost - young pets carry the most lifetime care value. Cold-DB safe.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const empty = () => ({ results: [] as Row[] });
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const DEFAULT_TOP_N = 5000;
const REFRESH_THROTTLE_MS = 6 * 3600_000; // don't recompute more than ~4x/day from the scheduler
const YOUNG_PET_MAX_DAYS = 365; // puppy/kitten cutoff

const WEIGHTS = { frequency: 0.25, orderValue: 0.25, serviceVariety: 0.15, petCount: 0.10, tenure: 0.10, youngPet: 0.10, recency: 0.05 };

export async function ensureCustomerTargetingTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS customer_target_scores (customer_id TEXT PRIMARY KEY,score REAL NOT NULL,segment TEXT NOT NULL,rank INTEGER NOT NULL,bookings INTEGER NOT NULL,bookings_per_month REAL NOT NULL,lifetime_value REAL NOT NULL,pet_count INTEGER NOT NULL,service_variety INTEGER NOT NULL,tenure_days INTEGER NOT NULL,recency_days INTEGER NOT NULL,has_young_pet INTEGER NOT NULL DEFAULT 0,signals_json TEXT NOT NULL,refreshed_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_target_scores_rank ON customer_target_scores(rank)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_target_scores_segment ON customer_target_scores(segment,score)"),
  ]);
}

function segmentOf(s: { score: number; hasYoungPet: boolean; tenureDays: number; serviceVariety: number; bookingsPerMonth: number; lifetimeValue: number; recencyDays: number }): string {
  if (s.hasYoungPet && s.tenureDays < 180) return "new_family_young_pet";
  if (s.score >= 70) return "vip";
  if (s.serviceVariety >= 3) return "multi_service_loyal";
  if (s.bookingsPerMonth >= 1.5) return "high_frequency";
  if (s.lifetimeValue >= 15000) return "high_value";
  if (s.recencyDays > 90) return "reactivation";
  return "standard";
}

/** Recompute target scores for all customers and keep the top N. Throttled unless force=true. */
export async function runCustomerTargetingSweep(db: Db, input: { at?: number; asOf?: number; topN?: number; force?: boolean } = {}) {
  await ensureCustomerTargetingTables(db);
  const at = input.at ?? input.asOf ?? Date.now();
  const topN = Math.max(1, Math.min(Number(input.topN) || DEFAULT_TOP_N, 50000));
  if (!input.force) {
    const last = await db.prepare("SELECT MAX(refreshed_at) m FROM customer_target_scores").first<Row>().catch(() => null);
    if (last && Number(last.m || 0) > 0 && at - Number(last.m) < REFRESH_THROTTLE_MS) return { refreshed: false, reason: "recently_refreshed", lastRefreshedAt: Number(last.m) };
  }
  const bookings = await db.prepare("SELECT customer_id cust,COUNT(*) bookings,COUNT(DISTINCT service_code) variety,SUM(CASE WHEN status NOT IN ('cancelled','refunded') THEN total_amount ELSE 0 END) ltv,MIN(created_at) first_at,MAX(created_at) last_at FROM canonical_bookings GROUP BY customer_id").all<Row>().catch(empty);
  if (!bookings.results.length) return { refreshed: true, scored: 0, kept: 0, topN };
  const petCounts = await db.prepare("SELECT customer_id cust,COUNT(*) pets FROM canonical_pets GROUP BY customer_id").all<Row>().catch(empty);
  const petBy = new Map(petCounts.results.map(r => [String(r.cust), Number(r.pets)]));
  // young-pet (puppy/kitten) detection from birthdays
  const youngRows = await db.prepare("SELECT p.customer_id cust,p.species species,b.date_of_birth dob FROM canonical_pets p JOIN pet_birthdays b ON b.pet_id=p.id").all<Row>().catch(empty);
  const youngBy = new Set<string>();
  for (const r of youngRows.results) {
    const dob = String(r.dob || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) continue;
    const ageDays = (at - Date.parse(dob + "T00:00:00Z")) / DAY;
    if (ageDays >= 0 && ageDays <= YOUNG_PET_MAX_DAYS && ["dog", "cat"].includes(String(r.species))) youngBy.add(String(r.cust));
  }
  const scored = bookings.results.map(r => {
    const cust = String(r.cust), count = Number(r.bookings), variety = Number(r.variety), ltv = Number(r.ltv) || 0;
    const firstAt = Number(r.first_at) || at, lastAt = Number(r.last_at) || at;
    const tenureDays = Math.max(0, Math.floor((at - firstAt) / DAY));
    const recencyDays = Math.max(0, Math.floor((at - lastAt) / DAY));
    const petCount = petBy.get(cust) || 0, hasYoungPet = youngBy.has(cust);
    const bookingsPerMonth = count / Math.max(1, tenureDays / 30);
    const n = {
      frequency: clamp01(bookingsPerMonth / 2),      // ~2 bookings/month = max
      orderValue: clamp01(ltv / 20000),              // Rs.20k LTV = max
      serviceVariety: clamp01(variety / 5),          // all 5 core services = max
      petCount: clamp01(petCount / 3),               // 3+ pets = max
      tenure: clamp01(tenureDays / 365),             // 1 year = max
      youngPet: hasYoungPet ? 1 : 0,
      recency: clamp01(1 - recencyDays / 180),       // active in last ~6 months
    };
    const score = round2(100 * (n.frequency * WEIGHTS.frequency + n.orderValue * WEIGHTS.orderValue + n.serviceVariety * WEIGHTS.serviceVariety + n.petCount * WEIGHTS.petCount + n.tenure * WEIGHTS.tenure + n.youngPet * WEIGHTS.youngPet + n.recency * WEIGHTS.recency));
    const segment = segmentOf({ score, hasYoungPet, tenureDays, serviceVariety: variety, bookingsPerMonth, lifetimeValue: ltv, recencyDays });
    return { cust, score, segment, count, bookingsPerMonth: round2(bookingsPerMonth), ltv: round2(ltv), petCount, variety, tenureDays, recencyDays, hasYoungPet, signals: n };
  });
  scored.sort((a, b) => b.score - a.score || b.ltv - a.ltv);
  const kept = scored.slice(0, topN);
  // stamp with `at` so the throttle check compares like-for-like across scheduler runs
  const stmts = [db.prepare("DELETE FROM customer_target_scores")];
  kept.forEach((s, i) => stmts.push(db.prepare("INSERT INTO customer_target_scores (customer_id,score,segment,rank,bookings,bookings_per_month,lifetime_value,pet_count,service_variety,tenure_days,recency_days,has_young_pet,signals_json,refreshed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(s.cust, s.score, s.segment, i + 1, s.count, s.bookingsPerMonth, s.ltv, s.petCount, s.variety, s.tenureDays, s.recencyDays, s.hasYoungPet ? 1 : 0, JSON.stringify(s.signals), at)));
  await db.batch(stmts);
  return { refreshed: true, scored: scored.length, kept: kept.length, topN, refreshedAt: at };
}

/** Pull the target audience: top-ranked customers, optionally filtered by segment / minimum score. */
export async function listTargetCustomers(db: Db, input: { limit?: number; segment?: string; minScore?: number } = {}) {
  await ensureCustomerTargetingTables(db);
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, DEFAULT_TOP_N));
  const clauses: string[] = ["1=1"], binds: unknown[] = [];
  if (input.segment) { clauses.push("segment=?"); binds.push(input.segment); }
  if (Number.isFinite(Number(input.minScore))) { clauses.push("score>=?"); binds.push(Number(input.minScore)); }
  const rows = await db.prepare(`SELECT customer_id,score,segment,rank,bookings,bookings_per_month,lifetime_value,pet_count,service_variety,tenure_days,recency_days,has_young_pet,refreshed_at FROM customer_target_scores WHERE ${clauses.join(" AND ")} ORDER BY rank LIMIT ${limit}`).bind(...binds).all<Row>().catch(empty);
  return rows.results.map((r: Row) => ({ customerId: String(r.customer_id), score: Number(r.score), segment: String(r.segment), rank: Number(r.rank), bookings: Number(r.bookings), bookingsPerMonth: Number(r.bookings_per_month), lifetimeValue: Number(r.lifetime_value), petCount: Number(r.pet_count), serviceVariety: Number(r.service_variety), tenureDays: Number(r.tenure_days), recencyDays: Number(r.recency_days), hasYoungPet: Boolean(Number(r.has_young_pet)), refreshedAt: Number(r.refreshed_at) }));
}

export async function customerTargetingSummary(db: Db) {
  await ensureCustomerTargetingTables(db);
  const rows = await db.prepare("SELECT segment,COUNT(*) c,ROUND(AVG(score),2) avg_score FROM customer_target_scores GROUP BY segment ORDER BY c DESC").all<Row>().catch(empty);
  const meta = await db.prepare("SELECT COUNT(*) total,MAX(refreshed_at) refreshed_at FROM customer_target_scores").first<Row>().catch(() => null);
  return { total: Number(meta?.total || 0), refreshedAt: meta?.refreshed_at ? Number(meta.refreshed_at) : null, bySegment: rows.results.map((r: Row) => ({ segment: String(r.segment), count: Number(r.c), averageScore: Number(r.avg_score) })) };
}
