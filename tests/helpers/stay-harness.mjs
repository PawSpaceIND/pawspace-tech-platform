/**
 * Shared setup for the EXECUTED home-service suites: Boarding, Pet Sitting, Dog Walking and Food.
 *
 * The ten Boarding and Sitting gate suites used to read `lib/boarding-...ts` and `lib/sitting-...ts`
 * as STRINGS and regex-match them. That is not a hypothetical weakness here: PAWSPACE-QA-001 was a
 * boarding refund ceiling that compared against `total_amount` while the message beside it read
 * "within the captured booking value" — the file read correct, behaved wrong, and boarding-gate3
 * agreed with it. These helpers exist so every assertion runs the real function against a real
 * SQLite-backed D1 and reads the rows back.
 *
 * The D1 shim, the non-preview origin and the refusal reader are the same ones the Pet Taxi suites
 * use, and are re-exported from there rather than copied: one shim, one set of documented limits
 * (statement-level interleaving, not transaction isolation — see tests/helpers/taxi-harness.mjs).
 * What is new here is the Boarding and Sitting fixture surface.
 */
export { makeD1, freshSqlite, refusal, nextKey, customerSessionCookie, seedActiveCommercialTerm, OPS_ORIGIN } from "./taxi-harness.mjs";
import { OPS_ORIGIN } from "./taxi-harness.mjs";

export const stayUrl = (path) => `${OPS_ORIGIN}${path}`;

/** A stay window that starts comfortably in the future; the quote guards refuse anything at or before now. */
export function stayWindow({ startInHours = 48, durationHours = 4 } = {}) {
  const startMs = Math.floor((Date.now() + startInHours * 3_600_000) / 1000) * 1000;
  return {
    scheduledStart: new Date(startMs).toISOString(),
    scheduledEnd: new Date(startMs + durationHours * 3_600_000).toISOString(),
  };
}

/**
 * The tables the Boarding and Sitting modules READ but do not own, so no ensure*Tables call creates
 * them. DDL is copied verbatim from the owning source (app/api/canonical-bookings/route.ts for
 * canonical_bookings, provider_work_orders and booking_payments; backend/src/scheduling.ts for
 * scheduling_reservations) rather than invented, so an upstream schema change surfaces here as a real
 * error instead of a fixture that quietly diverges.
 */
export function ensureCanonicalTables(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT NOT NULL,pet_ids_json TEXT DEFAULT '[]',city_id TEXT,zone_id TEXT,service_code TEXT NOT NULL,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}',created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL DEFAULT 0,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)");
  // The Operations snapshot joins the customer onto every stay, so the row has to exist for the
  // queue to be readable at all. DDL from lib/customer-account.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  // A decline or a host outage re-opens the assignment decision for the group, so the row has to
  // exist for the escalation paths to run at all. DDL from lib/provider-capacity-governance.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)");
}

/**
 * A Boarding stay in its born state, created through the PRODUCTION statement
 * (`boardingStayStatement`) rather than a hand-written INSERT, so the row's defaults —
 * awaiting_host_acceptance, care_plan_status 'required', check_in_status 'pending' — are the ones the
 * platform actually writes. Seeds the canonical booking behind it too.
 */
export async function seedBoardingStay(db, sqlite, {
  bookingId = "BKG-BOARD-1", customerId = "CUST-BOARD-1", providerId = "host_maya_rohan",
  packageCode = "boarding-4h", petCount = 1, stayUnits = 1, amount = 499,
  paymentStatus = "captured", paymentMode = "prepaid", amountDueNow, window: given,
} = {}) {
  const governance = await import("../../lib/boarding-governance.ts");
  const lifecycle = await import("../../lib/boarding-stay-lifecycle.ts");
  await governance.ensureBoardingGovernanceTables(db);
  await lifecycle.ensureBoardingStayLifecycleTables(db);
  const window = given ?? stayWindow();
  const booking = seedCanonicalStayBooking(sqlite, {
    bookingId, customerId, providerId, serviceCode: "boarding", packageCode,
    amount, amountDueNow: amountDueNow ?? amount, paymentStatus, paymentMode, ...window,
  });
  await governance.boardingStayStatement(db, {
    bookingId, customerId, providerId, cityId: "blr", zoneId: "blr-east", packageCode,
    scheduledStart: window.scheduledStart, scheduledEnd: window.scheduledEnd, stayUnits, petCount,
  }).run();
  const stay = await db.prepare("SELECT id FROM boarding_stays WHERE booking_id=?").bind(bookingId).first();
  return { ...booking, stayId: String(stay.id), ...window };
}

/**
 * A canonical Dog Walking booking with its walk sessions.
 *
 * Walking is per-SESSION: one canonical booking fans out into `walkCount` rows in walking_sessions,
 * each with its own reservation, and the lifecycle, finance and proof modules all key off a session
 * id rather than the booking. DDL for walking_sessions is verbatim from lib/walking-ops-governance.ts,
 * which owns it.
 */
export async function seedWalkingBooking(db, sqlite, {
  bookingId = "BKG-WALK-1", customerId = "CUST-WALK-1", providerId = "walker_dev",
  packageCode = "walking-30", packageName = "30-minute Solo Walk", amount = 349,
  walkCount = 1, paymentStatus = "pending", paymentMode = "pay_after_service",
  window: given, sessionStatus = "scheduled", ...rest
} = {}) {
  const lifecycle = await import("../../lib/walking-lifecycle.ts");
  const ops = await import("../../lib/walking-ops-governance.ts");
  const capacity = await import("../../lib/provider-capacity-governance.ts");
  await lifecycle.ensureWalkingLifecycleTables(db);
  await ops.ensureWalkingOpsTables(db);
  await capacity.seedProviderCapacityDefaults(db);

  const window = given ?? stayWindow({ durationHours: 0.5 });
  const booking = seedCanonicalStayBooking(sqlite, {
    bookingId, customerId, providerId, serviceCode: "dog_walking", packageCode, packageName,
    amount: amount * walkCount, amountDueNow: 0, paymentStatus, paymentMode, ...window, ...rest,
  });

  const now = Date.now();
  // walkingPerSessionAmount() reads the per-walk price off pricing_json and refuses completion when it
  // is absent, so a Walking booking is only well-formed with it.
  sqlite.prepare("UPDATE canonical_bookings SET pricing_json=? WHERE id=?")
    .run(JSON.stringify({ perWalkAmount: amount, walkCount, packageCode }), bookingId);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,1,?)")
    .run(booking.groupId, bookingId, providerId, now, now + 30 * 60_000, now);

  const sessions = [];
  for (let index = 0; index < walkCount; index += 1) {
    const start = new Date(new Date(window.scheduledStart).getTime() + index * 24 * 3_600_000).toISOString();
    const end = new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
    const sessionId = `WSESS-${bookingId}-${index + 1}`;
    const reservationId = `${booking.reservationId}-${index + 1}`;
    sqlite.prepare("INSERT OR REPLACE INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(sessionId, bookingId, booking.groupId, reservationId, providerId, index + 1, start, end, sessionStatus, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,'dog_walking','blr','blr-east',?,'[]',?,?,'confirmed',?)")
      .run(reservationId, booking.groupId, providerId, customerId, start, end, now);
    sessions.push({ sessionId, reservationId, scheduledStart: start, scheduledEnd: end });
  }
  return { ...booking, sessions, sessionId: sessions[0]?.sessionId, perWalkAmount: amount };
}

/**
 * A canonical Pet Sitting booking. Sitting has no separate stay table — its lifecycle works off
 * canonical_bookings and provider_work_orders directly — so this is the canonical seed with the
 * sitting service code and the tables its modules own already ensured.
 */
export async function seedSittingBooking(db, sqlite, {
  bookingId = "BKG-SIT-1", customerId = "CUST-SIT-1", providerId = "sitter_ananya",
  packageCode = "sitting-visit-60", packageName = "Home Visit", amount = 399,
  amountDueNow, paymentStatus = "captured", paymentMode = "prepaid", window: given, ...rest
} = {}) {
  const lifecycle = await import("../../lib/sitting-lifecycle.ts");
  const capacity = await import("../../lib/provider-capacity-governance.ts");
  await lifecycle.ensureSittingLifecycleTables(db);
  // The Sitting Operations snapshot and the replacement-eligibility check both read the provider
  // capacity profiles. Boarding gets these for free because ensureBoardingGovernanceTables seeds
  // them; Sitting does not, so the real seeder is called here rather than a hand-written fixture.
  await capacity.seedProviderCapacityDefaults(db);
  const window = given ?? stayWindow();
  const booking = seedCanonicalStayBooking(sqlite, {
    bookingId, customerId, providerId, serviceCode: "pet_sitting", packageCode, packageName,
    amount, amountDueNow: amountDueNow ?? amount, paymentStatus, paymentMode, ...window, ...rest,
  });
  // Sitting acceptance is a response to a pending assignment offer, unlike Boarding where the stay row
  // carries its own acceptance state. DDL from lib/provider-capacity-governance.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,1,?)")
    .run(booking.groupId, bookingId, providerId, now, now + 30 * 60_000, now);
  return booking;
}

/**
 * The customer's doorstep for a booking, written into the AUTHORITATIVE table.
 *
 * lib/booking-doorstep.ts consults booking_service_locations first (the one a customer flow actually
 * writes) and only falls back to booking_service_addresses. Seeding the authoritative table is what
 * makes a geofence assertion real rather than a fixture that exercises the fallback nobody writes.
 * DDL verbatim from lib/grooming-maps.ts.
 */
export function seedDoorstep(sqlite, { bookingId, customerId = "CUST-SIT-1", providerId = "sitter_ananya", latitude = 12.9716, longitude = 77.5946 }) {
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'customer_booking',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(bookingId, customerId, providerId, "12 MG Road, Bengaluru", latitude, longitude, now, now);
  return { latitude, longitude };
}

/**
 * A point `metres` north of a reference coordinate. One degree of latitude is ~111,320 m, which is
 * accurate enough to sit a sitter deliberately inside or outside a 250 m geofence.
 */
export function metresNorth({ latitude, longitude }, metres) {
  return { latitude: latitude + metres / 111_320, longitude };
}

/** A Sitting care plan: the same three requirements plus home access, which Boarding does not need. */
export function validSittingCarePlan(overrides = {}) {
  return {
    feeding: "Two meals, 8am and 7pm",
    medication: "None",
    emergencyContact: "Asha R. +919800000001",
    vet: "Cessna Lifeline +919800000002",
    homeAccess: "Lockbox by the gate, code shared at check-in",
    ...overrides,
  };
}

/** A care plan that satisfies the emergency-contact and vet requirements, so a test can drop ONE field. */
export function validCarePlan(overrides = {}) {
  return {
    feeding: "Two meals, 8am and 7pm",
    medication: "None",
    emergencyContact: "Asha R. +919800000001",
    vet: "Cessna Lifeline +919800000002",
    specialInstructions: "Crate at night",
    ...overrides,
  };
}

/**
 * A confirmed canonical booking with its work order, payment and scheduling reservation.
 *
 * `paymentStatus` matters more than it looks: the Boarding refund ceiling is `collectedForBooking`,
 * which counts only rows the payment layer regards as captured. A test that wants a refund to be
 * possible must seed a captured payment, and a test that wants the ceiling to bite must not.
 */
export function seedCanonicalStayBooking(sqlite, {
  bookingId = "BKG-STAY-1", customerId = "CUST-STAY-1", providerId = "host_maya_rohan",
  serviceCode = "boarding", packageCode = "boarding-4h", packageName = "Standard Stay",
  groupId = "GRP-STAY-1", reservationId = "RES-STAY-1", amount = 499, amountDueNow = 499,
  status = "confirmed", paymentStatus = "captured", paymentMode = "prepaid",
  scheduledStart, scheduledEnd, cityId = "blr", zoneId = "blr-east", providerModel = "commission",
} = {}) {
  const now = Date.now();
  const window = scheduledStart && scheduledEnd ? { scheduledStart, scheduledEnd } : stayWindow();
  ensureCanonicalTables(sqlite);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'harness',?,?)")
    .run(bookingId, `idem-${bookingId}`, customerId, cityId, zoneId, serviceCode, packageCode, packageName, groupId, providerId, window.scheduledStart, window.scheduledEnd, status, amount, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'assigned',?,?)")
    .run(`WO-${bookingId}`, bookingId, groupId, providerId, "Maya & Rohan", providerModel, serviceCode, window.scheduledStart, window.scheduledEnd, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi',?,?,?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, customerId, amount, amountDueNow, paymentMode, paymentStatus, `pk-${bookingId}`, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,?,?,?,?,'[]',?,?,'confirmed',?)")
    .run(reservationId, groupId, providerId, serviceCode, cityId, zoneId, customerId, window.scheduledStart, window.scheduledEnd, now);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(customerId, cityId, "UAT Customer", "+919800000000", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,updated_at) VALUES (?,'best_fit',?,?,'assigned','harness',?)")
    .run(groupId, JSON.stringify([providerId]), providerId, now);
  return { bookingId, customerId, providerId, groupId, reservationId, amount, ...window };
}
