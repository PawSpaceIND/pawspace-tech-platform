/*
 * Executable Training fixture for the programme + session-lifecycle suites (Work Order 02).
 *
 * NOT a mock. node:sqlite behind the D1 adapter, the REAL lib/training-programme.ts and
 * lib/training-session-lifecycle.ts, and the REAL /api/training-programmes and /api/training-sessions
 * routes. The base DDL below is copied verbatim from the owning sources (never guessed), exactly as
 * tests/training-hardening.test.mjs does: canonical_bookings + booking_payments from
 * app/api/walking-bookings/route.ts, canonical_customers from the customer surfaces,
 * scheduling_reservations + scheduling_availability from app/api/uat-scheduling/route.ts,
 * provider_work_orders from app/api/booking-command-center/route.ts, service_media_assets from
 * app/api/service-media/route.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./module-hooks.mjs";
import { d1, ORIGIN } from "./execution-harness.mjs";

installWorkersHooks("__TRAINING_WO02_DB__", "__TRAINING_WO02_ENV__");

export const TRAINER = "train_kiran";
export const OTHER_TRAINER = "train_sanjay";
export const CUSTOMER = "cus_wo02";
export const OTHER_CUSTOMER = "cus_wo02_other";
export const DOORSTEP = { latitude: 12.9716, longitude: 77.5946 };
export const NOW = Date.now();

// Anchored a fortnight ahead of the run so "future" stays true whenever the suite runs.
const BASE_DAY = (() => { const d = new Date(NOW + 14 * 86_400_000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); })();
export const dayAt = (dayOffset, hour, minute = 0) => new Date(BASE_DAY + dayOffset * 86_400_000 + hour * 3_600_000 + minute * 60_000).toISOString();
export const sessionStart = (dayOffset) => dayAt(dayOffset, 5, 30);
export const sessionEnd = (dayOffset) => dayAt(dayOffset, 6, 30);
export const sessionDate = (dayOffset) => dayAt(dayOffset, 0).slice(0, 10);

export const REPORT = { attendance: { mode: "parent", safeAreaConfirmed: true, parentOrCaretakerConfirmed: true }, homework: "Practise loose-leash walking 10 minutes daily", progress: { obedience: 6 } };

export async function freshWorld(t, env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  enterWorkersDbScope(db);
  globalThis.__TRAINING_WO02_DB__ = db;
  globalThis.__TRAINING_WO02_ENV__ = { NODE_ENV: "test", PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_MEDIA_ENV: "uat", ...env };
  if (t) t.after(() => sqlite.close());
  baseTables(sqlite);
  const { ensureSecurityTables } = await import("../../lib/server-auth.ts");
  await ensureSecurityTables(db);
  return { sqlite, db };
}

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

/** One canonical dog_training booking: N reservations, captured payment, customer, doorstep. */
export function seedBooking(sqlite, { id, group, customer = CUSTOMER, sessions = 4, total = 8000, dueNow = 4000, dayBase = 0, provider = TRAINER, packageCode = "obedience-starter", governedPayment = true, reservationProvider = provider, occurrenceNumbers = null, reservations = sessions } = {}) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customer, "blr", "Trisha Kumar", "+91-9000000001", "trisha@example.in", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[\"pet_1\"]','[\"pet_1\"]','blr','blr-east','dog_training',?,'Obedience Starter',?,?,?,?,'confirmed','customer_app',?,'INR','{\"requirements\":[\"Recall\"]}','uat',?,?)")
    .run(id, `idem-${id}`, customer, packageCode, group, provider, sessionStart(dayBase), sessionEnd(dayBase + sessions - 1), total, NOW, NOW);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi','deposit','captured',?,?,?)")
    .run(`PAY-${id}`, id, customer, total, dueNow, `payk-${id}`, NOW, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO booking_service_addresses (booking_id,address,latitude,longitude,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, "12 MG Road, Bengaluru", DOORSTEP.latitude, DOORSTEP.longitude, NOW, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'assigned',?,?)")
    .run(`WO-${id}`, id, group, provider, "Kiran S.", "commission", "dog_training", sessionStart(dayBase), sessionEnd(dayBase + sessions - 1), sessions, NOW, NOW);
  if (governedPayment) seedGovernedPayment(sqlite, { bookingId: id, total, captured: dueNow, sessions });
  for (let i = 0; i < reservations; i++) {
    const occurrence = occurrenceNumbers ? occurrenceNumbers[i] : i + 1;
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,'blr','blr-east',?,'[\"pet_1\"]',?,?,1,?,NULL,'assigned','{}',?)")
      .run(`R-${id}-${i + 1}`, group, reservationProvider, "dog_training", customer, sessionStart(dayBase + i), sessionEnd(dayBase + i), occurrence, NOW);
  }
}

export function seedGovernedPayment(sqlite, { bookingId, total, captured, sessions, mode = "deposit" }) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_commercial_quotes (id TEXT PRIMARY KEY,package_code TEXT NOT NULL,package_version INTEGER NOT NULL,pet_count INTEGER NOT NULL,scheduled_start TEXT NOT NULL,payment_mode TEXT NOT NULL,coupon_code TEXT,discount REAL NOT NULL DEFAULT 0,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,minutes_per_session INTEGER NOT NULL,sessions INTEGER NOT NULL,validity_days INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',used_booking_id TEXT,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_booking_quote_links (quote_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_quote_payment_attestations (quote_id TEXT PRIMARY KEY,status TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',environment TEXT NOT NULL DEFAULT 'sandbox',reference TEXT NOT NULL,bound_payment_key TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const quoteId = `TQ-${bookingId}`;
  sqlite.prepare("INSERT OR IGNORE INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,'open',?)")
    .run(quoteId, "dog_training_basic", 1, 1, sessionStart(0), mode, total, captured, 60, sessions, 30, NOW + 30 * 86_400_000, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO training_booking_quote_links (quote_id,booking_id,created_at) VALUES (?,?,?)").run(quoteId, bookingId, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO training_quote_payment_attestations (quote_id,status,amount,reference,bound_payment_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(quoteId, captured >= total ? "FULLY_PAID" : "PARTIALLY_PAID", captured, `att-${bookingId}`, `payk-${bookingId}`, NOW, NOW);
}

export function seedRoster(sqlite, provider, dateIso, windows = ["09:00-19:00"], zone = "blr-east") {
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,'uat_seed',?)")
    .run(`AV-${provider}-${dateIso}-${zone}`, provider, "blr", zone, dateIso, JSON.stringify(windows), NOW);
}

/** Clean, ready, active, non-synthetic BEFORE + AFTER assets linked to the session (secureEvidenceReady). */
export function seedEvidence(sqlite, mediaId, sessionRow) {
  for (const [suffix, purpose] of [["B", "before_service"], ["A", "after_service"]]) {
    const id = `${mediaId}-${suffix}`;
    sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'clean','ready','active',0,'uat',?,?)")
      .run(id, sessionRow.booking_id, sessionRow.provider_id, purpose, `media/${id}`, "image/jpeg", 2048, `sha-${id}`, NOW, NOW);
    sqlite.prepare("INSERT INTO training_session_media_links (media_id,session_id,programme_id,booking_id,provider_id,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, sessionRow.id, sessionRow.programme_id, sessionRow.booking_id, sessionRow.provider_id, NOW);
  }
  return [`media://asset/${mediaId}-B`, `media://asset/${mediaId}-A`];
}

/** Non-preview identities: role customer = pricing.view + scheduling.book; service_provider = bookings.view + ... */
export function seedCustomerIdentity(sqlite, email, customerId) {
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`usr-${email}`, email, email.split("@")[0], "customer", NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, customerId, NOW, NOW);
}
export function seedProviderIdentity(sqlite, email, providerId) {
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`usr-${email}`, email, email.split("@")[0], "service_provider", NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, providerId, NOW, NOW);
}

/** Drive a route handler as a forwarded identity against a REAL https origin (never localhost preview). */
export async function callAs(handler, method, bodyOrQuery, email) {
  const url = `${ORIGIN}/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email };
  const request = method === "GET" ? new Request(url, { headers }) : new Request(url, { method, headers, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
  return { status: response.status, body };
}

/** Product functions throw Response objects for HTTP-grade refusals; assert the real surface. */
export async function expectRefusal(operation, { status, message } = {}) {
  let refusal;
  try { await operation(); } catch (error) { refusal = error; }
  if (!(refusal instanceof Response)) throw new Error(`expected a Response refusal, got ${refusal?.constructor?.name ?? typeof refusal}: ${refusal?.message ?? refusal}`);
  const body = await refusal.text();
  if (status !== undefined && refusal.status !== status) throw new Error(`expected status ${status}, got ${refusal.status}: ${body}`);
  if (message && !message.test(body)) throw new Error(`refusal body did not match ${message}: ${body}`);
  return { status: refusal.status, body };
}
