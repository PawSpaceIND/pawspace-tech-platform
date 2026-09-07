import { ensureProviderCapacityTables } from "./provider-capacity-governance";

/**
 * Real post-booking rating capture, universal across all verticals (keyed off canonical_bookings,
 * not a per-vertical table) - genuinely missing before this: no customer-facing way to rate a
 * completed service existed anywhere, meaning provider_capacity_profiles.rating/quality_score -
 * the exact fields the real matching engine (lib/provider-capacity-governance.ts) sorts providers
 * by - were permanently stuck at whatever hardcoded seed value they started with. A newly
 * onboarded provider would show rating:0 forever regardless of real service quality.
 *
 * Design: one rating per completed booking, submitted by the customer who owns it. A provider's
 * real rating is the live average of their real submitted ratings - never fabricated, never
 * defaulting to a plausible-looking number when no ratings exist yet (stays at whatever the seed
 * value was until real ratings start coming in, which is honestly what "not enough data yet"
 * looks like for a new provider).
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

export async function ensureBookingRatingTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS booking_ratings (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,stars INTEGER NOT NULL,comment TEXT,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_ratings_provider ON booking_ratings(provider_id)"),
  ]);
}

export async function submitBookingRating(db: Db, input: { customerId: string; bookingId: string; stars: number; comment?: string; actorId: string }) {
  await ensureBookingRatingTables(db);
  const stars = Number(input.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error("Rating must be a whole number from 1 to 5");
  const booking = await db.prepare("SELECT id,customer_id,provider_id,service_code,status FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.customer_id) !== input.customerId) throw new Error("You can only rate your own bookings");
  if (String(booking.status) !== "completed") throw new Error("You can only rate a completed booking");
  const existing = await db.prepare("SELECT id FROM booking_ratings WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if (existing) throw new Error("This booking has already been rated");
  const id = uid("RATE"), now = Date.now();
  await db.prepare("INSERT INTO booking_ratings (id,booking_id,customer_id,provider_id,service_code,stars,comment,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, input.bookingId, input.customerId, String(booking.provider_id), String(booking.service_code), stars, input.comment?.trim() || null, now).run();
  const recomputed = await recomputeProviderRating(db, String(booking.provider_id));
  return { id, bookingId: input.bookingId, providerId: String(booking.provider_id), stars, ...recomputed };
}

/**
 * The real average of a provider's real submitted ratings - never fabricated, never a plausible
 * default. Only writes to provider_capacity_profiles.rating if the provider capacity row already
 * exists (a provider must be at least activated for this to apply).
 */
export async function recomputeProviderRating(db: Db, providerId: string) {
  // Rating is allowed to be the first consumer of provider capacity on a fresh/partially provisioned
  // database. The old implementation assumed another route had created this table already, which made
  // an otherwise valid completed-booking rating fail with `no such table: provider_capacity_profiles`.
  await Promise.all([ensureBookingRatingTables(db), ensureProviderCapacityTables(db)]);
  const row = await db.prepare("SELECT COUNT(*) count, AVG(stars) avg_stars FROM booking_ratings WHERE provider_id=?").bind(providerId).first<Row>();
  const count = Number(row?.count || 0);
  const average = count > 0 ? Math.round(Number(row?.avg_stars || 0) * 100) / 100 : null;
  if (average !== null) {
    await db.prepare("UPDATE provider_capacity_profiles SET rating=?,quality_score=?,updated_at=? WHERE id=?")
      .bind(average, Math.round(average * 20), Date.now(), providerId).run();
  }
  return { ratingCount: count, averageRating: average };
}

export async function listCustomerRatableBookings(db: Db, customerId: string) {
  await ensureBookingRatingTables(db);
  const rows = await db.prepare(
    "SELECT b.id,b.service_code,b.package_name,b.provider_id,b.scheduled_start FROM canonical_bookings b LEFT JOIN booking_ratings r ON r.booking_id=b.id WHERE b.customer_id=? AND b.status='completed' AND r.id IS NULL ORDER BY b.scheduled_start DESC LIMIT 20"
  ).bind(customerId).all<Row>();
  return rows.results.map((r: Row) => ({ bookingId: String(r.id), serviceCode: String(r.service_code), packageName: String(r.package_name), providerId: String(r.provider_id), scheduledStart: String(r.scheduled_start) }));
}
