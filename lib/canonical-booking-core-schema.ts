/*
 * The three canonical booking tables that read-only surfaces depend on.
 *
 * This codebase does not migrate its schema: every module owns an `ensure*Tables(db)` full of
 * CREATE TABLE IF NOT EXISTS and calls it before touching the database. That convention was only
 * ever followed by code that WRITES. Read-only surfaces skipped it, on the reasonable-sounding
 * assumption that whoever wrote the rows must have created the tables first — which holds on a warm
 * database and fails on every cold one: a fresh preview branch, a rebuilt D1, a restored backup, a
 * rollback. `/api/booking-command-center/stream` failed exactly that way, returning 500 with
 * "no such table: booking_payments" while its dashboard sat at zero.
 *
 * The statements below are byte-identical to the ones in app/api/canonical-bookings/route.ts, and
 * tests/schema-read-coverage.test.mjs fails if they ever drift. That matters more than it looks:
 * CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so if a reader created these
 * tables first with a different shape, the writer's own CREATE would silently accept it and the
 * mismatch would surface much later as a column error.
 */
type Db = D1Database;

export const CANONICAL_BOOKING_CORE_DDL = [
  "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
] as const;

/*
 * canonical_customers is the fourth table a read-only booking surface reaches for, and it had the
 * same hole: /api/training-ops joins it (and the three above) while ensuring only the training
 * tables, so on a cold D1 the Training Ops console answered 500 "no such table: canonical_bookings",
 * then "no such table: canonical_customers", with all four metric tiles at "-".
 *
 * Eleven modules carry their own copy of this CREATE. Ten are byte-identical to the statement below;
 * three (lib/customer-account.ts, lib/inbound-ai-lead-capture.ts, app/api/admin/data-ingest/route.ts)
 * differ ONLY in the DEFAULT on `source` ('customer_app' rather than 'uat_customer_app'). Every one
 * of the ten INSERT sites in the repo names `source` explicitly, so that DEFAULT never fires and the
 * two spellings are behaviourally identical - but the column set is what matters here, and on that
 * all eleven agree. This copy tracks app/api/canonical-bookings/route.ts, the same writer the three
 * statements above track, and tests/schema-read-coverage.test.mjs fails if it drifts.
 */
export const CANONICAL_CUSTOMER_DDL = "CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)" as const;

const customerEnsured = new WeakSet<Db>();

/** Create canonical_customers if it is missing. Cheap and idempotent once warm. */
export async function ensureCanonicalCustomerTable(db: Db): Promise<void> {
  if (customerEnsured.has(db)) return;
  await db.prepare(CANONICAL_CUSTOMER_DDL).run();
  customerEnsured.add(db);
}

const ensured = new WeakSet<Db>();

/** Create the canonical booking core tables if they are missing. Cheap and idempotent once warm. */
export async function ensureCanonicalBookingCoreTables(db: Db): Promise<void> {
  if (ensured.has(db)) return;
  await db.batch(CANONICAL_BOOKING_CORE_DDL.map((statement) => db.prepare(statement)));
  ensured.add(db);
}
