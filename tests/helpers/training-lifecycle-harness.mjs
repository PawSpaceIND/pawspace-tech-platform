/*
 * Executable harness for the Dog Training programme and session lifecycle.
 *
 * Every suite built on this file drives the REAL modules (lib/training-programme.ts,
 * lib/training-session-lifecycle.ts, the /api/training-* route handlers) against a real SQLite engine
 * through the D1 adapter in helpers/execution-harness.mjs. Nothing here mocks business logic: the
 * fixtures below are the canonical rows a programme needs before the first module call, written with
 * the exact DDL of the tables that own them (copied from app/api/walking-bookings/route.ts,
 * app/api/uat-scheduling/route.ts, app/api/booking-command-center/route.ts and
 * app/api/service-media/route.ts, never guessed).
 *
 * Two identities are available to a suite:
 *   - a PLATFORM SESSION cookie for a customer or a provider (the same binding + session issue path the
 *     OTP routes use), sent to a real https origin so lib/development-preview.ts grants nothing;
 *   - the localhost PREVIEW actor, which resolves to a superuser and stands in for Ops staff.
 */
import { installWorkersHooks } from "./module-hooks.mjs";
import { world as executionWorld, ORIGIN } from "./execution-harness.mjs";

export const DB_GLOBAL = "__TRAINING_LIFECYCLE_DB__";
export const ENV_GLOBAL = "__TRAINING_LIFECYCLE_ENV__";
installWorkersHooks(DB_GLOBAL, ENV_GLOBAL);

export const TRAINER = "train_kiran";
export const OTHER_TRAINER = "train_ramesh";
export const CUSTOMER = "cus_t1";
export const OTHER_CUSTOMER = "cus_other";
// The trainer must arrive AT the doorstep: the same point, so the distance is 0m and inside
// TRAINING_ARRIVAL_GEOFENCE_METERS (250). Moving either value apart is what the gate is for.
export const DOORSTEP = { latitude: 12.9716, longitude: 77.5946 };
export const FAR_AWAY = { latitude: 13.0827, longitude: 80.2707 };

const NOW = Date.now();
// Anchored a fortnight ahead of the run, never to a literal calendar date, so "far enough in the
// future" stays true whenever the suite runs. 05:30Z is 11:00 IST, inside a 09:00-19:00 roster window.
const BASE_DAY = (() => {
  const d = new Date(NOW + 14 * 86_400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
})();
export const dayAt = (dayOffset, hour, minute = 0) =>
  new Date(BASE_DAY + dayOffset * 86_400_000 + hour * 3_600_000 + minute * 60_000).toISOString();
export const sessionStart = (dayOffset) => dayAt(dayOffset, 5, 30);
export const sessionEnd = (dayOffset) => dayAt(dayOffset, 6, 30);
export const sessionDate = (dayOffset) => dayAt(dayOffset, 0).slice(0, 10);

export const REPORT = {
  attendance: { mode: "parent", safeAreaConfirmed: true, parentOrCaretakerConfirmed: true },
  homework: "Practise loose-leash walking 10 minutes daily",
  progress: { obedience: 6 },
};

function baseTables(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL DEFAULT 'assigned',explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_service_addresses (booking_id TEXT PRIMARY KEY,address TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'staff_entered',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS service_media_assets (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,purpose TEXT NOT NULL,storage_key TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,scan_status TEXT NOT NULL DEFAULT 'pending',access_status TEXT NOT NULL DEFAULT 'pending_upload',retention_status TEXT NOT NULL DEFAULT 'active',synthetic INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

/** A fresh in-memory database bound to this harness's Worker globals, with the canonical base tables. */
export function freshWorld(env = {}) {
  const world = executionWorld(DB_GLOBAL, ENV_GLOBAL, {
    PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_MEDIA_ENV: "uat", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
    ...env,
  });
  baseTables(world.sqlite);
  return world;
}

/** Seeds one canonical dog_training booking: N reservations, a captured deposit and the customer. */
export function seedBooking(world, {
  id, group, customer = CUSTOMER, sessions = 4, total = 8000, dueNow = 4000, dayBase = 0, provider = TRAINER,
  serviceCode = "dog_training", packageCode = "obedience-starter", packageName = "Obedience Starter",
  governedPayment = true, reservations = true, status = "confirmed",
}) {
  const { sqlite } = world;
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customer, "blr", customer === CUSTOMER ? "Trisha Kumar" : "Other Customer", "+91-9000000001", `${customer}@example.test`, NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[\"pet_1\"]','[\"pet_1\"]','blr','blr-east',?,?,?,?,?,?,?,?,'customer_app',?,'INR',?,'uat',?,?)")
    .run(id, `idem-${id}`, customer, serviceCode, packageCode, packageName, group, provider, sessionStart(dayBase), sessionEnd(dayBase + sessions - 1), status, total, JSON.stringify({ requirements: ["Use hand signals"] }), NOW, NOW);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi','deposit','captured',?,?,?)")
    .run(`PAY-${id}`, id, customer, total, dueNow, `payk-${id}`, NOW, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO booking_service_addresses (booking_id,address,latitude,longitude,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, "12 MG Road, Bengaluru", DOORSTEP.latitude, DOORSTEP.longitude, NOW, NOW);
  if (governedPayment) seedGovernedPayment(world, { bookingId: id, total, captured: dueNow, sessions });
  if (reservations) {
    for (let i = 0; i < sessions; i++) {
      seedReservation(world, { id: `R-${id}-${i + 1}`, group, provider, customer, serviceCode, occurrence: i + 1, start: sessionStart(dayBase + i), end: sessionEnd(dayBase + i) });
    }
  }
  return { id, group, customer, provider, sessions };
}

export function seedReservation(world, { id, group, provider = TRAINER, customer = CUSTOMER, serviceCode = "dog_training", occurrence = 1, start, end, status = "assigned" }) {
  world.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,'blr','blr-east',?,'[\"pet_1\"]',?,?,1,?,NULL,?,'{}',?)")
    .run(id, group, provider, serviceCode, customer, start, end, occurrence, status, NOW);
}

/*
 * The lifecycle reads a governed quote + payment attestation for "how much has the customer actually
 * paid" (a client-declared capture is not an obtained one), so a seeded booking needs the commercial
 * quote, the link binding it to the booking and the attestation carrying the captured figure. Real DDL,
 * copied from lib/training-commercial-governance.ts.
 */
export function seedGovernedPayment(world, { bookingId, total, captured, sessions, mode = "deposit" }) {
  const { sqlite } = world;
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_commercial_quotes (id TEXT PRIMARY KEY,package_code TEXT NOT NULL,package_version INTEGER NOT NULL,pet_count INTEGER NOT NULL,scheduled_start TEXT NOT NULL,payment_mode TEXT NOT NULL,coupon_code TEXT,discount REAL NOT NULL DEFAULT 0,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,minutes_per_session INTEGER NOT NULL,sessions INTEGER NOT NULL,validity_days INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,used_at INTEGER,used_booking_id TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_booking_quote_links (quote_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_quote_payment_attestations (quote_id TEXT PRIMARY KEY,status TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',environment TEXT NOT NULL DEFAULT 'sandbox',reference TEXT NOT NULL,bound_payment_key TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const quoteId = `TQ-${bookingId}`;
  sqlite.prepare("INSERT OR IGNORE INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,'open',?)")
    .run(quoteId, "dog_training_basic", 1, 1, sessionStart(0), mode, total, captured, 60, sessions, 30, NOW + 30 * 86_400_000, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO training_booking_quote_links (quote_id,booking_id,created_at) VALUES (?,?,?)").run(quoteId, bookingId, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO training_quote_payment_attestations (quote_id,status,amount,reference,bound_payment_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(quoteId, captured >= total ? "FULLY_PAID" : "PARTIALLY_PAID", captured, `att-${bookingId}`, `payk-${bookingId}`, NOW, NOW);
}

export function seedRoster(world, provider, dateIso, windows = ["09:00-19:00"], zone = "blr-east") {
  world.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,'uat_seed',?)")
    .run(`AV-${provider}-${dateIso}-${zone}`, provider, "blr", zone, dateIso, JSON.stringify(windows), NOW);
}

/** A clean, ready, active, non-synthetic proof asset linked to exactly this session and trainer. */
export function seedAsset(world, mediaId, purpose, sessionRow, overrides = {}) {
  const { sqlite } = world;
  const values = { scan: "clean", access: "ready", retention: "active", synthetic: 0, provider: sessionRow.provider_id, booking: sessionRow.booking_id, session: sessionRow.id, ...overrides };
  sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'uat',?,?)")
    .run(mediaId, values.booking, values.provider, purpose, `media/${mediaId}`, "image/jpeg", 2048, `sha-${mediaId}`, values.scan, values.access, values.retention, values.synthetic, NOW, NOW);
  sqlite.prepare("INSERT INTO training_session_media_links (media_id,session_id,programme_id,booking_id,provider_id,created_at) VALUES (?,?,?,?,?,?)")
    .run(mediaId, values.session, sessionRow.programme_id, sessionRow.booking_id, values.provider, NOW);
}

/** Canonical Before + After pictures, the pair completion demands. */
export function seedEvidence(world, mediaId, sessionRow) {
  for (const [suffix, purpose] of [["B", "before_service"], ["A", "after_service"]]) seedAsset(world, `${mediaId}-${suffix}`, purpose, sessionRow);
  return [`media://asset/${mediaId}-B`, `media://asset/${mediaId}-A`];
}

/** Drives one session through the governed flow to completion using the real lifecycle module. */
export async function completeSession(world, sessionRow, key) {
  const { mutateTrainingSession } = await import("../../lib/training-session-lifecycle.ts");
  let refs = null;
  for (const [action, extra] of [["accept", {}], ["on_the_way", {}], ["arrive", DOORSTEP], ["start", {}], ["owner_handover", { ownerHandoverMinutes: 15 }]]) {
    await mutateTrainingSession(world.db, { sessionId: sessionRow.id, action, actorId: `trainer:${sessionRow.provider_id}`, idempotencyKey: `${key}-${action}`, ...extra });
    if (!refs) refs = seedEvidence(world, `MA-${key}`, sessionRow);
  }
  return mutateTrainingSession(world.db, { sessionId: sessionRow.id, action: "complete", actorId: `trainer:${sessionRow.provider_id}`, idempotencyKey: `${key}-complete`, report: { ...REPORT, evidenceRefs: refs } });
}

/** A verified platform session for a customer or a provider, exactly as the OTP routes issue one. */
export async function sessionCookie(db, subjectType, subjectId) {
  const { upsertIdentityBinding } = await import("../../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../../lib/platform-session.ts");
  const principalKey = `${subjectType}:${subjectId}`;
  const binding = await upsertIdentityBinding(db, {
    identitySource: subjectType === "provider" ? "partner_otp" : "customer_otp",
    principalType: "identity_subject", principalKey, subjectType, subjectId,
    verificationState: "verified", actorId: "training-lifecycle-harness", reason: "executable Training lifecycle suite",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key), subjectType, subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

/**
 * Calls a real route handler. `cookie` sends a platform session to a real https origin (no preview
 * grant); `preview: true` uses the localhost preview actor, i.e. Ops staff with every permission.
 */
export async function routeCall(handler, method, path, { body, cookie, preview = false } = {}) {
  const origin = preview ? "http://localhost" : ORIGIN;
  const headers = { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) };
  const request = new Request(`${origin}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const response = await handler(request);
  return { status: response.status, body: await parseBody(response) };
}

export const trainer = (id = TRAINER) => `trainer:${id}`;
export { ORIGIN };
