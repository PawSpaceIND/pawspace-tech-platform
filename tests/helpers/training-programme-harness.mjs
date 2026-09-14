/**
 * Shared setup for the EXECUTED Training programme and session-lifecycle suites.
 *
 * tests/training-programme.test.mjs and tests/training-session-lifecycle.test.mjs used to read
 * lib/training-programme.ts, lib/training-session-lifecycle.ts and their routes as strings and
 * regex-match table names, refusal messages and action vocabularies. A test named "Training Gate 2
 * owns each trainer session and consumes completion exactly once" asserted that the phrase
 * `INSERT OR IGNORE INTO training_session_consumptions` appeared in the source; it would have passed
 * with the guard deleted and the statement left behind in a comment.
 *
 * These helpers exist so every assertion in those suites runs the real function or route against a
 * real SQLite-backed D1 and reads the rows back. No training module is mocked: the modules own their
 * own DDL through their `ensure*Tables` exports, and only the canonical tables that belong to OTHER
 * surfaces (bookings, payments, reservations, work orders, media assets) are created here, with DDL
 * copied from the owning sources.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./module-hooks.mjs";
import { makeD1 } from "./taxi-harness.mjs";
import { ORIGIN } from "./execution-harness.mjs";

installWorkersHooks("__TRAINING_PROGRAMME_DB__", "__TRAINING_PROGRAMME_ENV__");

export const TRAINER_ID = "train_kiran";
export const OTHER_TRAINER_ID = "train_ramesh";
export const CUSTOMER_ID = "cus_programme_1";
export const DOORSTEP = { latitude: 12.9716, longitude: 77.5946 };
export const REPORT = {
  attendance: { mode: "parent", safeAreaConfirmed: true, parentOrCaretakerConfirmed: true },
  homework: "Practise loose-leash walking 10 minutes daily",
  progress: { obedience: 6 },
};

const NOW = Date.now();
// Every window is derived from the run time so the suite never expires: a literal calendar date
// would move into the past and turn every 409 the tests expect into a past-dated 400.
const BASE_DAY = (() => {
  const d = new Date(NOW + 14 * 86_400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
})();
export const dayAt = (dayOffset, hour, minute = 0) =>
  new Date(BASE_DAY + dayOffset * 86_400_000 + hour * 3_600_000 + minute * 60_000).toISOString();
// 05:30Z == 11:00 IST, inside a 09:00-19:00 IST roster window.
export const sessionStart = (dayOffset) => dayAt(dayOffset, 5, 30);
export const sessionEnd = (dayOffset) => dayAt(dayOffset, 6, 30);
export const sessionDate = (dayOffset) => dayAt(dayOffset, 0).slice(0, 10);

export function freshTrainingProgrammeWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__TRAINING_PROGRAMME_DB__ = db;
  globalThis.__TRAINING_PROGRAMME_ENV__ = { NODE_ENV: "test", PAWSPACE_LOCAL_PREVIEW: "on", PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_MEDIA_ENV: "uat" };
  // DDL copied verbatim from the owning sources: canonical_bookings + booking_payments from
  // app/api/walking-bookings/route.ts, canonical_customers from lib/customer-account.ts,
  // scheduling_reservations + scheduling_availability from app/api/uat-scheduling/route.ts,
  // provider_work_orders from app/api/booking-command-center/route.ts, booking_service_addresses from
  // lib/booking-doorstep.ts, service_media_assets from app/api/service-media/route.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL DEFAULT 'assigned',explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_service_addresses (booking_id TEXT PRIMARY KEY,address TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'staff_entered',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS service_media_assets (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,purpose TEXT NOT NULL,storage_key TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,scan_status TEXT NOT NULL DEFAULT 'pending',access_status TEXT NOT NULL DEFAULT 'pending_upload',retention_status TEXT NOT NULL DEFAULT 'active',synthetic INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  return { sqlite, db };
}

/**
 * One canonical dog_training booking: N reservations, a work order, a doorstep, and the governed quote +
 * sandbox attestation the final-session balance check reads (a deposit stays PARTIALLY_PAID, which is
 * what blocks the final session until the balance is settled; dueNow === total settles it).
 */
export function seedTrainingBooking(world, {
  id = "B1", group = "G1", customer = CUSTOMER_ID, sessions = 4, total = 8000, dueNow = 4000, dayBase = 0,
  provider = TRAINER_ID, packageCode = "training-4-puppy", packageName = "Puppy Training Plan", pricing = {},
  reservationProvider = provider, occurrenceNumbers = null,
} = {}) {
  const { sqlite } = world;
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(customer, "blr", "Trisha Kumar", "+91-9000000001", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[\"pet_1\"]','[\"pet_1\"]','blr','blr-east','dog_training',?,?,?,?,?,?,'confirmed','customer_app',?,'INR',?,'uat',?,?)")
    .run(id, `idem-${id}`, customer, packageCode, packageName, group, provider, sessionStart(dayBase), sessionEnd(dayBase + sessions - 1), total, JSON.stringify(pricing), NOW, NOW);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi','deposit','captured',?,?,?)")
    .run(`PAY-${id}`, id, customer, total, dueNow, `payk-${id}`, NOW, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES (?,?,?,?,?,'commission','dog_training',?,?,?,'assigned',?,?)")
    .run(`WO-${id}`, id, group, provider, "Kiran S.", sessionStart(dayBase), sessionEnd(dayBase + sessions - 1), sessions, NOW, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO booking_service_addresses (booking_id,address,latitude,longitude,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, "12 MG Road, Bengaluru", DOORSTEP.latitude, DOORSTEP.longitude, NOW, NOW);
  seedGovernedPayment(world, { bookingId: id, total, captured: dueNow, sessions });
  for (let i = 0; i < sessions; i++) {
    const occurrence = occurrenceNumbers ? occurrenceNumbers[i] : i + 1;
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,'blr','blr-east',?,'[\"pet_1\"]',?,?,1,?,NULL,'assigned','{}',?)")
      .run(`R-${id}-${i + 1}`, group, reservationProvider, "dog_training", customer, sessionStart(dayBase + i), sessionEnd(dayBase + i), occurrence, NOW);
  }
  return { id, group, customer, sessions, provider };
}

function seedGovernedPayment(world, { bookingId, total, captured, sessions, mode = "deposit" }) {
  const { sqlite } = world;
  // Real DDL, copied from lib/training-commercial-governance.ts - seeded here because the fixture
  // writes them before any lib call has had a chance to ensure them.
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_commercial_quotes (id TEXT PRIMARY KEY,package_code TEXT NOT NULL,package_version INTEGER NOT NULL,pet_count INTEGER NOT NULL,scheduled_start TEXT NOT NULL,payment_mode TEXT NOT NULL,coupon_code TEXT,discount REAL NOT NULL DEFAULT 0,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,minutes_per_session INTEGER NOT NULL,sessions INTEGER NOT NULL,validity_days INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,used_at INTEGER,used_booking_id TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_booking_quote_links (quote_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_quote_payment_attestations (quote_id TEXT PRIMARY KEY,status TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',environment TEXT NOT NULL DEFAULT 'sandbox',reference TEXT NOT NULL,bound_payment_key TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const quoteId = `TQ-${bookingId}`;
  sqlite.prepare("INSERT OR IGNORE INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,'open',?)")
    .run(quoteId, "training-4-puppy", 1, 1, sessionStart(0), mode, total, captured, 60, sessions, 30, NOW + 30 * 86_400_000, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO training_booking_quote_links (quote_id,booking_id,created_at) VALUES (?,?,?)").run(quoteId, bookingId, NOW);
  sqlite.prepare("INSERT OR IGNORE INTO training_quote_payment_attestations (quote_id,status,amount,reference,bound_payment_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(quoteId, captured >= total ? "FULLY_PAID" : "PARTIALLY_PAID", captured, `att-${bookingId}`, `payk-${bookingId}`, NOW, NOW);
}

export function seedRoster(world, provider, dateIso, windows = ["09:00-19:00"], zone = "blr-east") {
  world.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,'uat_seed',?)")
    .run(`AV-${provider}-${dateIso}-${zone}`, provider, "blr", zone, dateIso, JSON.stringify(windows), NOW);
}

/** A clean, ready, active, non-synthetic asset linked to exactly this session and trainer. */
export function seedAsset(world, mediaId, purpose, sessionRow, overrides = {}) {
  const asset = { scan: "clean", access: "ready", retention: "active", synthetic: 0, bookingId: sessionRow.booking_id, providerId: sessionRow.provider_id, linkSessionId: sessionRow.id, linkProviderId: sessionRow.provider_id, ...overrides };
  world.sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'uat',?,?)")
    .run(mediaId, asset.bookingId, asset.providerId, purpose, `media/${mediaId}`, "image/jpeg", 2048, `sha-${mediaId}`, asset.scan, asset.access, asset.retention, asset.synthetic, NOW, NOW);
  world.sqlite.prepare("INSERT INTO training_session_media_links (media_id,session_id,programme_id,booking_id,provider_id,created_at) VALUES (?,?,?,?,?,?)")
    .run(mediaId, asset.linkSessionId, sessionRow.programme_id, sessionRow.booking_id, asset.linkProviderId, NOW);
  return `media://asset/${mediaId}`;
}

/** The canonical BEFORE + AFTER pair completion demands. */
export function seedEvidence(world, mediaId, sessionRow) {
  return [seedAsset(world, `${mediaId}-B`, "before_service", sessionRow), seedAsset(world, `${mediaId}-A`, "after_service", sessionRow)];
}

const STEPS = [["accept", {}], ["on_the_way", {}], ["arrive", DOORSTEP], ["start", {}], ["owner_handover", { ownerHandoverMinutes: 15 }]];

/**
 * Drive a session through the governed pre-completion steps with the real mutation function, so a
 * completion test starts from the exact state the module requires rather than an UPDATE that skips
 * the guards.
 */
export async function advanceSession(db, sessionRow, key, { through = "owner_handover" } = {}) {
  const { mutateTrainingSession } = await import("../../lib/training-session-lifecycle.ts");
  const results = [];
  for (const [action, extra] of STEPS) {
    results.push(await mutateTrainingSession(db, { sessionId: sessionRow.id, action, actorId: `trainer:${sessionRow.provider_id}`, idempotencyKey: `${key}-${action}`, ...extra }));
    if (action === through) break;
  }
  return results;
}

export async function completeSession(world, sessionRow, key) {
  const { mutateTrainingSession } = await import("../../lib/training-session-lifecycle.ts");
  await advanceSession(world.db, sessionRow, key);
  const evidenceRefs = seedEvidence(world, `MA-${key}`, sessionRow);
  return mutateTrainingSession(world.db, { sessionId: sessionRow.id, action: "complete", actorId: `trainer:${sessionRow.provider_id}`, idempotencyKey: `${key}-complete`, report: { ...REPORT, evidenceRefs } });
}

/**
 * Product governance functions throw Response objects for HTTP-grade refusals. assert.rejects(regex)
 * stringifies those as "[object Response]", which proves only that something rejected. This asserts
 * the real refusal surface: Response type, exact status, and the body the caller would read.
 */
export async function expectResponseRefusal(operation, { status, message } = {}) {
  let refusal;
  try { await (typeof operation === "function" ? operation() : operation); }
  catch (error) { refusal = error; }
  assert.ok(refusal instanceof Response, `expected a Response refusal, got ${refusal?.constructor?.name ?? typeof refusal}`);
  if (status !== undefined) assert.equal(refusal.status, status, "unexpected refusal status");
  const body = await refusal.text();
  if (message) assert.match(body, message);
  return { response: refusal, body };
}

/** A verified platform session for a customer or provider subject, as the OTP exchange would issue. */
export async function platformSessionCookie(db, subjectType, subjectId) {
  const { upsertIdentityBinding } = await import("../../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../../lib/platform-session.ts");
  const principalKey = `${subjectType}:${subjectId}`;
  const binding = await upsertIdentityBinding(db, {
    identitySource: subjectType === "provider" ? "partner_otp" : "customer_otp",
    principalType: "identity_subject", principalKey, subjectType, subjectId,
    verificationState: "verified", actorId: "training-programme-harness",
    reason: "executable Training programme suite",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType, subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

/** Real app_users rows so route authorization resolves against canonical role state. */
export async function seedActor(world, { email, role, customerId, providerId }) {
  const { ensureSecurityTables } = await import("../../lib/server-auth.ts");
  await ensureSecurityTables(world.db);
  world.sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`usr-${email}`, email, email.split("@")[0], role, NOW, NOW);
  if (customerId) world.sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, customerId, NOW, NOW);
  if (providerId) world.sqlite.prepare("INSERT OR REPLACE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, providerId, NOW, NOW);
  return email;
}

/**
 * Drive a route handler as a forwarded identity against a REAL https origin. localhost would resolve
 * to a development-preview superuser and prove nothing about ownership or permissions.
 */
export async function callRoute(handler, method, path, { body, email, cookie } = {}) {
  const headers = { "content-type": "application/json", ...(email ? { "oai-authenticated-user-email": email } : {}), ...(cookie ? { cookie } : {}) };
  const request = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const response = await handler(request);
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  return { status: response.status, body: parsed };
}

/** Route a client-side `fetch` into real route handlers, recording every request the client makes. */
export function bridgeClientFetch(routes, { email, cookie } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(String(input), ORIGIN);
    const modulePath = routes[target.pathname];
    if (!modulePath) throw new Error(`unrouted client request: ${target.pathname}`);
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, path: target.pathname, query: Object.fromEntries(target.searchParams), body: init.body ? JSON.parse(String(init.body)) : null });
    const handler = (await import(modulePath))[method];
    const headers = { ...(init.headers || {}), ...(email ? { "oai-authenticated-user-email": email } : {}), ...(cookie ? { cookie } : {}) };
    return handler(new Request(target.href, { method, headers, ...(init.body ? { body: init.body } : {}) }));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
