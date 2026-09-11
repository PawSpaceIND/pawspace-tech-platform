/**
 * Growth intelligence - retention and personalised next-best-action, from real customer history.
 *
 *   listChurnRisk - ranks customers who are lapsing (no completed service in a while), weighted by
 *     their value, so win-back effort (e.g. grantWinbackPoints) goes where it pays. Advisory only:
 *     outbound_contact and campaign_activation remain forbidden autonomous actions, so this suggests
 *     who to reach - a human still triggers the outreach.
 *   recommendNextService - per customer, blends service gaps, vaccination-due dates and upcoming pet
 *     birthdays into a prioritised, explainable recommendation list (ties the Pet Passport,
 *     vaccination records and birthday reward together).
 *
 * Rules/statistics today (no external provider needed); cold-DB safe.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const empty = () => ({ results: [] as Row[] });
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const CORE_SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking"];
const levelOf = (s: number) => (s >= 0.7 ? "high" : s >= 0.4 ? "medium" : "low");

/** Rank lapsing customers by churn risk x value. Only returns customers who are actually at risk. */
export async function listChurnRisk(db: Db, input: { limit?: number; at?: number } = {}) {
  const at = input.at ?? Date.now();
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, 500));
  const cutoff90 = new Date(at - 90 * DAY).toISOString();
  const rows = await db.prepare("SELECT customer_id cust,COUNT(*) bookings,COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) completed,MAX(CASE WHEN status='completed' THEN scheduled_start END) last_completed,COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','refunded') THEN total_amount ELSE 0 END),0) value,COALESCE(SUM(CASE WHEN scheduled_start>=? THEN 1 ELSE 0 END),0) bookings_90d,COALESCE(SUM(CASE WHEN status='cancelled' AND scheduled_start>=? THEN 1 ELSE 0 END),0) cancelled_90d FROM canonical_bookings GROUP BY customer_id").bind(cutoff90,cutoff90).all<Row>().catch(empty);
  const ratingRows = await db.prepare("SELECT customer_id,COALESCE(SUM(CASE WHEN stars<3 AND created_at>=? THEN 1 ELSE 0 END),0) low_ratings_90d FROM booking_ratings GROUP BY customer_id").bind(at-90*DAY).all<Row>().catch(empty);
  const lowRatings = new Map(ratingRows.results.map(r => [String(r.customer_id), Number(r.low_ratings_90d ?? 0) || 0]));
  const scored = rows.results.map(r => {
    const completed = Number(r.completed ?? 0) || 0, last = r.last_completed ? Date.parse(String(r.last_completed)) : NaN;
    if (!completed || Number.isNaN(last)) return null;
    const daysSince = Math.max(0, Math.floor((at - last) / DAY));
    const recentLowRatings = Math.max(0, lowRatings.get(String(r.cust)) ?? 0);
    const bookings90 = Math.max(0, Number(r.bookings_90d ?? 0) || 0);
    const cancelled90 = Math.max(0, Number(r.cancelled_90d ?? 0) || 0);
    const cancellationFrequency = bookings90 ? clamp01(cancelled90 / bookings90) : 0;
    const recencyRisk = clamp01(daysSince / 120), ratingRisk = clamp01(recentLowRatings / 2);
    const risk = clamp01(recencyRisk * 0.55 + ratingRisk * 0.25 + cancellationFrequency * 0.20);
    if (risk < 0.25) return null;
    const value = Number(r.value ?? 0) || 0;
    const priority = round2(clamp01(risk * (0.85 + 0.15 * clamp01(value / 5000))));
    const signals = [`${daysSince} days since last completed service`];
    if (recentLowRatings) signals.push(`${recentLowRatings} recent rating(s) below 3 stars`);
    if (cancellationFrequency) signals.push(`${Math.round(cancellationFrequency*100)}% cancellation frequency (90d)`);
    return { customerId: String(r.cust), daysSinceLastCompletedService: daysSince, recentLowRatings, cancellationFrequency: round2(cancellationFrequency), bookings: Number(r.bookings ?? 0) || 0, completedServices: completed, lifetimeValue: round2(value), score: round2(risk), priority, riskLevel: levelOf(risk), reason: signals.join("; "), suggestedAction: "winback_offer", recommendationOnly: true };
  }).filter(Boolean) as Array<Record<string, unknown>>;
  scored.sort((a, b) => (Number(b.priority) - Number(a.priority)) || (Number(b.score) - Number(a.score)));
  return { method: "service_quality_cancellation_v2", atRisk: scored.slice(0, limit) };
}

function upcomingBirthdayWithin(dob: string, at: number, days: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const now = new Date(at), mmdd = dob.slice(5);
  for (let y = 0; y <= 1; y++) {
    const cand = Date.parse(`${now.getUTCFullYear() + y}-${mmdd}T00:00:00Z`);
    if (Number.isNaN(cand)) return null;
    const delta = Math.floor((cand - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / DAY);
    if (delta >= 0 && delta <= days) return delta;
  }
  return null;
}

/** Prioritised next-best-action for one customer: care due, birthday offers, and untried services. */
export async function recommendNextService(db: Db, input: { customerId: string; at?: number }) {
  const customerId = String(input.customerId || "").trim();
  if (!customerId) throw new Error("A customer is required");
  const at = input.at ?? Date.now();
  const today = new Date(at).toISOString().slice(0, 10), soon = new Date(at + 30 * DAY).toISOString().slice(0, 10);
  const [bookings, pets, vaccines, birthdays] = await Promise.all([
    db.prepare("SELECT DISTINCT service_code FROM canonical_bookings WHERE customer_id=? AND status NOT IN ('cancelled')").bind(customerId).all<Row>().catch(empty),
    db.prepare("SELECT id,name FROM canonical_pets WHERE customer_id=?").bind(customerId).all<Row>().catch(empty),
    db.prepare("SELECT pet_id,vaccine_type,next_due_on FROM pet_vaccinations WHERE customer_id=? AND status='active' AND next_due_on IS NOT NULL AND next_due_on<=?").bind(customerId, soon).all<Row>().catch(empty),
    db.prepare("SELECT pet_id,date_of_birth FROM pet_birthdays WHERE customer_id=?").bind(customerId).all<Row>().catch(empty),
  ]);
  const petName = new Map(pets.results.map(p => [String(p.id), String(p.name)]));
  const used = new Set(bookings.results.map(b => String(b.service_code)));
  const recs: Array<Record<string, unknown>> = [];
  // 1) vaccination due / overdue - highest priority (care + safety)
  for (const v of vaccines.results) {
    const due = String(v.next_due_on), overdue = due < today;
    recs.push({ type: "vaccination_due", priority: overdue ? 1 : 2, pet: petName.get(String(v.pet_id)) || String(v.pet_id), reason: `${String(v.vaccine_type)} ${overdue ? "overdue" : "due"} on ${due}`, suggestedAction: overdue ? "vaccination_reminder_urgent" : "vaccination_reminder" });
  }
  // 2) upcoming pet birthday -> the flat birthday grooming offer
  for (const b of birthdays.results) {
    const inDays = upcomingBirthdayWithin(String(b.date_of_birth), at, 14);
    if (inDays !== null) recs.push({ type: "birthday_offer", priority: 2, pet: petName.get(String(b.pet_id)) || String(b.pet_id), reason: `Birthday in ${inDays} day(s)`, suggestedAction: "birthday_grooming_offer" });
  }
  // 3) untried core services - cross-sell
  for (const svc of CORE_SERVICES) if (!used.has(svc)) recs.push({ type: "service_gap", priority: 3, service: svc, reason: `Has never tried ${svc.replace(/_/g, " ")}`, suggestedAction: "cross_sell" });
  recs.sort((a, b) => Number(a.priority) - Number(b.priority));
  return { customerId, generatedAt: at, method: "care_and_gap_v1", recommendationOnly: true, recommendations: recs };
}
