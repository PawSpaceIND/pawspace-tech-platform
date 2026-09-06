/**
 * Shared setup for the EXECUTED Pet Taxi suites.
 *
 * The taxi gate suites used to read `lib/taxi-governance.ts` (and the lifecycle and finance modules)
 * as a string and regex-match them. A test named "Pet Taxi quote binds one canonical trip reservation"
 * asserted that the phrase "exactly one canonical trip reservation" appeared in the source; it would
 * have passed with the guard deleted and the sentence left behind in a comment.
 *
 * These helpers exist so every taxi assertion runs the real function against a real SQLite-backed D1
 * and reads the rows back. There is deliberately no taxi module mocked here: the modules own their own
 * DDL through their `ensure*Tables` exports, so a suite calls those and gets the production schema
 * rather than a hand-copied one that can drift from it.
 */
import { DatabaseSync } from "node:sqlite";

/**
 * The D1 surface the taxi modules use: prepare/bind/first/run/all, plus batch and exec.
 *
 * `batch` runs inside a real transaction so a failing statement rolls the whole batch back, which is
 * what D1 does and what the ensure*Tables + seed paths assume.
 */
export function makeD1(sqlite) {
  /*
   * `onSql(pattern, fn)` — a ONE-SHOT hook that runs immediately before the next statement whose SQL
   * contains `pattern`. Same idea as tests/helpers/voice-harness.mjs.
   *
   * This is what makes a check-then-act test real rather than nominal. Statements against this shim
   * are synchronous, so `Promise.all` over two route calls does NOT interleave them — each runs to
   * completion before the next starts, and a claim-token race can never actually occur. Measured:
   * relaxing `INSERT OR IGNORE` to `INSERT OR REPLACE` on the refund transition claim survived a
   * Promise.all "concurrency" test precisely because of that. Registering a hook on the guarded UPDATE
   * lets a competing statement land in the exact gap between claiming and applying.
   *
   * WHAT THIS DOES AND DOES NOT MODEL — be precise, because the difference matters.
   *
   * It models STATEMENT-LEVEL INTERLEAVING: the competitor observes the intermediate state, exactly as
   * a second caller would in the window between a check and the act that depends on it. That is the
   * ordering the guards under test exist to survive.
   *
   * It does NOT model TRANSACTION ISOLATION. `depth` makes a nested batch join the outer transaction
   * rather than open its own, so both callers share one connection and one transaction; the competitor
   * sees the winner's uncommitted claim row. Real D1 would serialise two connections instead, and the
   * loser would meet the same constraint after the winner committed. The OUTCOME asserted — exactly one
   * winner, refused by a PRIMARY KEY or UNIQUE index — is the same either way, which is why these tests
   * assert outcomes rather than isolation behaviour.
   *
   * Two connections is not an option here: a `node:sqlite` in-memory database is per-connection, so a
   * second connection would not see this one's data at all.
   *
   * The assertions are sabotage-proven rather than assumed: relaxing the posting claim to
   * `INSERT OR REPLACE`, and dropping the cancellation approval claim's exclusivity, each turn the
   * corresponding test red.
   */
  const hooks = [];
  const fire = async (sql) => {
    const index = hooks.findIndex((hook) => sql.includes(hook.pattern));
    if (index === -1) return;
    const [hook] = hooks.splice(index, 1);
    await hook.fn();
  };
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { await fire(sql); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { await fire(sql); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => { await fire(sql); return { results: sqlite.prepare(sql).all(...args) }; },
  });
  let depth = 0;
  return {
    onSql: (pattern, fn) => { hooks.push({ pattern, fn }); },
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

export function freshSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA journal_mode=MEMORY;");
  return sqlite;
}

/**
 * A NON-PREVIEW origin for every request these suites build.
 *
 * lib/development-preview.ts grants an authentication-free superuser holding ["*"] on localhost,
 * 127.0.0.1 and terminal.local when the runtime declares development/test — and `npm test` declares
 * exactly that. Any authorization assertion posted to those hosts passes vacuously, so the taxi suites
 * use a hostname the preview branch cannot match.
 */
export const OPS_ORIGIN = "https://ops.pawspace.example";
export const taxiUrl = (path) => `${OPS_ORIGIN}${path}`;

/**
 * A pickup time comfortably in the future; createTaxiQuote refuses anything at or before now.
 *
 * TRUNCATED TO A WHOLE SECOND on purpose. The instant-normalisation test compares the same moment
 * written as `...Z` and as `...+05:30`, and the +05:30 spelling comes from a formatter that has no
 * millisecond field — so a pickup carrying 126ms is genuinely a different instant in the two spellings
 * and `sameInstant` correctly refuses it. Rounding here keeps that test about normalisation instead of
 * about formatter precision. (Confirmed by running it: the refusal was the fixture's fault, not the
 * guard's.)
 */
export const futurePickup = (offsetMinutes = 180) =>
  new Date(Math.floor((Date.now() + offsetMinutes * 60_000) / 1000) * 1000).toISOString();

/**
 * A quote that is valid in every respect, so a test can vary ONE field and attribute the refusal to
 * that field rather than to fixture drift.
 */
export function validQuoteInput(overrides = {}) {
  return {
    routeCode: "taxi-blr-east-short",
    originLabel: "Indiranagar pickup point",
    destinationLabel: "Whitefield veterinary clinic",
    petCount: 1,
    scheduledStart: futurePickup(),
    paymentMode: "sandbox_deferred",
    ...overrides,
  };
}

/**
 * A canonical Pet Taxi trip, seeded across the five tables the lifecycle and finance modules read but
 * do not own: canonical_bookings, provider_work_orders, booking_payments, taxi_trips and
 * provider_assignment_offers. Everything those modules DO own comes from their own ensure*Tables, so
 * this is the whole external fixture surface.
 *
 * DDL is copied verbatim from the owning sources (app/api/taxi-bookings/route.ts for taxi_trips,
 * lib/provider-capacity-governance.ts for the offers table) rather than invented, so a schema change
 * upstream surfaces here as a real error instead of a test that quietly diverges.
 *
 * Returns the ids so a test can drive `mutateTaxiBooking` without restating them.
 */
export function seedCanonicalTrip(sqlite, {
  bookingId = "BKG-TAXI-1", tripId = "TRIP-1", providerId = "taxi_rahul", customerId = "CUST-TAXI-1",
  reservationId = "RES-1", groupId = "GRP-1", routeCode = "taxi-blr-east-short", amount = 449,
  tripStatus = "scheduled", workOrderStatus = "offered", offerStatus = "pending",
  offerExpiresAt = Date.now() + 10 * 60_000, scheduledStart = futurePickup(), pickupStatus = "pending",
  dropoffStatus = "pending", vehicleId = null, paymentStatus = "pending",
} = {}) {
  const now = Date.now();
  const scheduledEnd = new Date(new Date(scheduledStart).getTime() + 45 * 60_000).toISOString();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT NOT NULL,pet_ids_json TEXT DEFAULT '[]',city_id TEXT,zone_id TEXT,service_code TEXT NOT NULL,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}',created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  // DDL verbatim from app/api/canonical-bookings/route.ts, which owns this table. The recovery path
  // rewrites provider_model on a replacement, so an abbreviated copy here would fail at runtime.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL DEFAULT 0,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS taxi_trips (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,origin_label TEXT NOT NULL,destination_label TEXT NOT NULL,route_code TEXT NOT NULL,synthetic_distance_km REAL NOT NULL,estimated_duration_minutes INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',vehicle_id TEXT,pickup_verification_status TEXT NOT NULL DEFAULT 'pending',dropoff_verification_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  // The recovery path cancels the scheduling hold, and completion closes the reservation, so the
  // reservation row has to exist for either to be exercised. DDL from backend/src/scheduling.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)");

  sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,'blr','blr-east','pet_taxi',?,'Pet Taxi',?,?,?,?,'confirmed',?,'harness',?,?)")
    .run(bookingId, `idem-${bookingId}`, customerId, routeCode, groupId, providerId, scheduledStart, scheduledEnd, amount, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,'full_time','pet_taxi',?,?,?,?,?)")
    .run(`WO-${bookingId}`, bookingId, groupId, providerId, "Rahul K.", scheduledStart, scheduledEnd, workOrderStatus, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,0,'upi','sandbox_deferred',?,?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, customerId, amount, paymentStatus, `pk-${bookingId}`, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,vehicle_id,pickup_verification_status,dropoff_verification_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,5,45,?,?,?,?,?,?,?,?)")
    .run(tripId, bookingId, groupId, reservationId, providerId, "Indiranagar pickup point", "Whitefield veterinary clinic", routeCode, scheduledStart, scheduledEnd, tripStatus, vehicleId, pickupStatus, dropoffStatus, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES (?,?,?,?,?,?,1,?)")
    .run(groupId, bookingId, providerId, offerStatus, now, offerExpiresAt, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,'pet_taxi','blr','blr-east',?,'[]',?,?,'confirmed',?)")
    .run(reservationId, groupId, providerId, customerId, scheduledStart, scheduledEnd, now);
  // Recovery re-opens the assignment decision for this group, so the decision row must exist.
  // DDL from lib/provider-capacity-governance.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,updated_at) VALUES (?,'best_fit',?,?,'assigned','harness',?)")
    .run(groupId, JSON.stringify([providerId]), providerId, now);

  return { bookingId, tripId, providerId, customerId, reservationId, groupId, scheduledStart, scheduledEnd, amount };
}

/** An active, UAT-verified vehicle owned by the seeded driver. */
export function seedVehicle(sqlite, { vehicleId = "VEH-1", providerId = "taxi_rahul", active = 1, inspection = "uat_verified" } = {}) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS taxi_vehicle_profiles (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,label TEXT NOT NULL,vehicle_type TEXT NOT NULL,pet_restraint TEXT NOT NULL,inspection_status TEXT NOT NULL DEFAULT 'uat_verified',active INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO taxi_vehicle_profiles (id,provider_id,label,vehicle_type,pet_restraint,inspection_status,active,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(vehicleId, providerId, "Hatchback · crate", "hatchback", "crate", inspection, active, Date.now());
  return vehicleId;
}

/**
 * An ACTIVE commercial term for pet_taxi, created through the real maker/checker path.
 *
 * Discovered by running the conversion: `complete_trip` calls resolveServiceCompletionFinance, which
 * throws `CommercialTermConfigurationRequired: no active commercial term for service pet_taxi`. That
 * is correct fail-closed behaviour — the platform refuses to invent a payout or a tax status for a
 * service nobody has configured — so trip completion is genuinely unreachable without this. The taxi
 * suites therefore assert BOTH directions: refused without a term, resolved with one.
 */
export async function seedActiveCommercialTerm(db, { serviceCode = "pet_taxi", providerSharePct = 0.7, engagementModel = "commission_standard" } = {}) {
  const terms = await import("../../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const draft = await terms.saveCommercialTerm(db, {
    serviceCode, engagementModel, providerSharePct,
    effectiveFrom: "2026-01-01", reason: "Pet Taxi executed-test baseline", actorId: "maker@pawspace.test",
  });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APPR-TAXI-1", actorId: "checker@pawspace.test" });
  return draft.id;
}

/**
 * A REAL customer session cookie for a verified phone principal.
 *
 * The taxi routes resolve a customer through `resolvePlatformSession`, which reads a signed session
 * cookie — not through the staff `oai-authenticated-user-email` header. Minting the session through
 * the production `upsertIdentityBinding` + `issuePlatformSession` path is what makes the
 * customer-versus-Finance authority assertions real: the session is only usable while the binding
 * behind it stays active and verified.
 *
 * Returns a `cookie` header value ready to put on a Request.
 */
export async function customerSessionCookie(db, { principalKey, customerId, subjectType = "customer" }) {
  const bindings = await import("../../lib/identity-binding.ts");
  const sessions = await import("../../lib/platform-session.ts");
  await bindings.ensureIdentityBindingTables(db);
  await bindings.upsertIdentityBinding(db, {
    identitySource: subjectType === "customer" ? "customer_otp" : "partner_otp",
    principalType: "phone", principalKey, subjectType, subjectId: customerId,
    verificationState: "verified", actorId: "otp@pawspace.test", reason: "verified OTP sign-in",
  });
  const binding = await bindings.findIdentityBinding(db, {
    identitySource: subjectType === "customer" ? "customer_otp" : "partner_otp",
    principalType: "phone", principalKey, subjectType,
  });
  if (!binding) throw new Error("the harness could not find the binding it just created");
  const issued = await sessions.issuePlatformSession(db, {
    bindingId: String(binding.id),
    identitySource: subjectType === "customer" ? "customer_otp" : "partner_otp",
    principalType: "phone", principalKey, subjectType, subjectId: customerId,
  });
  const token = String(issued.token ?? issued.sessionToken ?? "");
  if (!token) throw new Error(`issuePlatformSession returned no token: ${JSON.stringify(Object.keys(issued))}`);
  return { cookie: `${sessions.PLATFORM_SESSION_COOKIE}=${encodeURIComponent(token)}`, bindingId: String(binding.id) };
}

/** A distinct idempotency key per call, so a test's own repeats do not collide by accident. */
let keySeq = 0;
export const nextKey = (prefix = "K") => `${prefix}-${++keySeq}-${Math.random().toString(36).slice(2, 8)}`;

/** The status a thrown control Response carries, or null when the value is not one. */
export async function refusal(promise) {
  try { await promise; return null; }
  catch (error) {
    if (!(error instanceof Response)) throw error;
    return { status: error.status, message: await error.text().catch(() => "") };
  }
}
