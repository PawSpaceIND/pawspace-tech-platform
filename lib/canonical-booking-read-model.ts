type Db = D1Database;

const ensured = new WeakSet<Db>();

/**
 * Ensures the canonical booking table exists for read-only consumers that can be
 * reached before the booking write route has initialized a fresh environment.
 *
 * Keep this definition identical to the owning booking route. A reduced table
 * would be unsafe: a later CREATE TABLE IF NOT EXISTS would not add the omitted
 * columns and the first real booking write would then fail.
 */
export async function ensureCanonicalBookingReadModel(db: Db) {
  if (ensured.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"
  ).run();
  ensured.add(db);
}
