import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, so the REAL training routes and libs execute unmodified.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__TRN_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__TRN_DB__ = makeD1(sqlite); }

const sessionsRoute = await import("../app/api/training-sessions/route.ts");
const customerChangeRoute = await import("../app/api/training-customer-session-change/route.ts");
const cancellationRoute = await import("../app/api/training-cancellation/route.ts");
const earningsRoute = await import("../app/api/training-provider-earnings/route.ts");
const reconciliationRoute = await import("../app/api/training-reconciliation/route.ts");
const opsRoute = await import("../app/api/training-ops/route.ts");
const { materializeTrainingProgramme } = await import("../lib/training-programme.ts");
const { mutateTrainingSession } = await import("../lib/training-session-lifecycle.ts");
const { requestTrainingCancellation, approveTrainingCancellation } = await import("../lib/training-cancellation.ts");
const { saveTrainingCompensationRule, refreshTrainingFinanceReadModel } = await import("../lib/training-finance.ts");

// Preview actor (localhost + NODE_ENV!=production) resolves to a superuser; ownership checks pass.
const call = async (handler, method, bodyOrQuery, headers = {}) => {
  const url = `http://localhost/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url, { headers })
    : new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  return { status: response.status, body: await parseBody(response) };
};
// Some routes surface thrown Response errors as plain text via authError.
async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
// Non-preview actor: forwarded-identity headers against a non-local host — exercises the REAL
// role + ownership path (app_users role_code=customer has scheduling.book but no manage overrides).
const callAs = async (handler, method, bodyOrQuery, email) => {
  const url = `https://app.pawspace.test/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email };
  const request = method === "GET" ? new Request(url, { headers }) : new Request(url, { method, headers, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  return { status: response.status, body: await parseBody(response) };
};

// Exact DDL copied verbatim from the owning sources (never guessed): canonical_bookings +
// booking_payments from app/api/walking-bookings/route.ts, canonical_customers from the customer
// surfaces, scheduling_reservations + scheduling_availability from app/api/uat-scheduling/route.ts,
// provider_work_orders from app/api/booking-command-center/route.ts, service_media_assets from
// app/api/service-media/route.ts.
function baseTables() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL DEFAULT 'assigned',explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS service_media_assets (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,purpose TEXT NOT NULL,storage_key TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,scan_status TEXT NOT NULL DEFAULT 'pending',access_status TEXT NOT NULL DEFAULT 'pending_upload',retention_status TEXT NOT NULL DEFAULT 'active',synthetic INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

const NOW = Date.now();
const TRAINER = "train_kiran";
// Session times: far enough in the future to reschedule, spread across days.
// 05:30Z == 11:00 IST, 06:30Z == 12:00 IST — inside a 09:00-19:00 IST roster window.
const sessionStart = (dayOffset) => new Date(Date.UTC(2026, 8, 1 + dayOffset, 5, 30, 0)).toISOString();
const sessionEnd = (dayOffset) => new Date(Date.UTC(2026, 8, 1 + dayOffset, 6, 30, 0)).toISOString();

// Seeds one canonical dog_training booking: N reservations, captured payment, customer.
function seedBooking({ id, group, customer = "cus_t1", sessions = 4, total = 8000, dueNow = 4000, dayBase = 0, provider = TRAINER }) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(customer, "blr", "Trisha Kumar", "+91-9000000001", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[\"pet_1\"]','[\"pet_1\"]','blr','blr-east','dog_training','obedience-starter','Obedience Starter',?,?,?,?,'confirmed','customer_app',?,'INR','{}','uat',?,?)")
    .run(id, `idem-${id}`, customer, group, provider, sessionStart(dayBase), sessionEnd(dayBase + sessions - 1), total, NOW, NOW);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi','deposit','captured',?,?,?)")
    .run(`PAY-${id}`, id, customer, total, dueNow, `payk-${id}`, NOW, NOW);
  for (let i = 0; i < sessions; i++) {
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,'blr','blr-east',?,'[\"pet_1\"]',?,?,1,?,NULL,'assigned','{}',?)")
      .run(`R-${id}-${i + 1}`, group, provider, "dog_training", customer, sessionStart(dayBase + i), sessionEnd(dayBase + i), i + 1, NOW);
  }
}

function seedRoster(provider, dateIso, windows = ["09:00-19:00"], zone = "blr-east") {
  sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,'uat_seed',?)")
    .run(`AV-${provider}-${dateIso}-${zone}`, provider, "blr", zone, dateIso, JSON.stringify(windows), NOW);
}

// Secure evidence pipeline: clean/ready/active non-synthetic asset + session link, per the exact
// requirements in secureEvidenceReady (lib/training-session-lifecycle.ts).
function seedEvidence(mediaId, sessionRow) {
  sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'clean','ready','active',0,'uat',?,?)")
    .run(mediaId, sessionRow.booking_id, sessionRow.provider_id, "training_homework", `media/${mediaId}`, "image/jpeg", 2048, `sha-${mediaId}`, NOW, NOW);
  sqlite.prepare("INSERT INTO training_session_media_links (media_id,session_id,programme_id,booking_id,provider_id,created_at) VALUES (?,?,?,?,?,?)")
    .run(mediaId, sessionRow.id, sessionRow.programme_id, sessionRow.booking_id, sessionRow.provider_id, NOW);
}

const REPORT = { attendance: { mode: "parent", safeAreaConfirmed: true, parentOrCaretakerConfirmed: true }, homework: "Practise loose-leash walking 10 minutes daily", progress: { obedience: 6 } };

async function completeSession(db, sessionRow, key) {
  let seeded = false;
  for (const [action, extra] of [["accept", {}], ["on_the_way", {}], ["arrive", {}], ["start", {}], ["complete", { report: { ...REPORT, evidenceRefs: [`media://asset/MA-${key}`] } }]]) {
    await mutateTrainingSession(db, { sessionId: sessionRow.id, action, actorId: `trainer:${sessionRow.provider_id}`, idempotencyKey: `${key}-${action}`, ...extra });
    // The first mutation ensures the lifecycle tables (incl. training_session_media_links) exist.
    if (!seeded) { seedEvidence(`MA-${key}`, sessionRow); seeded = true; }
  }
}

// Non-preview identities for ownership tests: role "customer" = pricing.view + scheduling.book only.
function seedCustomerIdentity(email, customerId) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`usr-${email}`, email, email.split("@")[0], "customer", NOW, NOW);
  sqlite.prepare("INSERT INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)")
    .run(email, customerId, NOW, NOW);
}

// ---- 1. Programme materialization: booking -> N sessions, idempotent -------------------------

test("real execution: dog_training booking materializes exactly N sessions and replay is idempotent", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1" });
  const db = globalThis.__TRN_DB__;
  const first = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(first.sessions.length, 4);
  assert.deepEqual(first.sessions.map(s => Number(s.sequence_no)), [1, 2, 3, 4]);
  assert.ok(first.sessions.every(s => s.status === "scheduled" && s.provider_id === TRAINER));
  assert.equal(Number(first.programme.total_sessions), 4);
  const replay = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_sessions").get().n, 4, "replay must not duplicate sessions");
});

// ---- 2. Session lifecycle: complete requires evidence; consumption exactly once ----------------

test("real execution: complete demands validated report + clean evidence, consumes exactly once, replay idempotent", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1" });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  const s1 = sessions[0];
  for (const action of ["accept", "on_the_way", "arrive", "start"]) {
    await mutateTrainingSession(db, { sessionId: s1.id, action, actorId: "trainer:t", idempotencyKey: `s1-${action}` });
  }
  // Without evidence -> 409 (money consequence: a completed session is chargeable value)
  await assert.rejects(
    mutateTrainingSession(db, { sessionId: s1.id, action: "complete", actorId: "trainer:t", idempotencyKey: "s1-complete-bad", report: { ...REPORT, evidenceRefs: ["media://asset/GHOST"] } }),
    (e) => e instanceof Response && e.status === 409);
  seedEvidence("MA-1", s1);
  const done = await mutateTrainingSession(db, { sessionId: s1.id, action: "complete", actorId: "trainer:t", idempotencyKey: "s1-complete", report: { ...REPORT, evidenceRefs: ["media://asset/MA-1"] } });
  assert.equal(done.status, "completed");
  assert.equal(done.consumedExactlyOnce, true);
  assert.equal(done.programme.completed, 1);
  assert.equal(done.programme.status, "in_progress");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_session_consumptions WHERE session_id=?").get(s1.id).n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id=?").get(s1.schedule_reservation_id).status, "completed");
  const replay = await mutateTrainingSession(db, { sessionId: s1.id, action: "complete", actorId: "trainer:t", idempotencyKey: "s1-complete" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_session_consumptions").get().n, 1, "replay must not double-consume");
});

test("real execution: no_show respects the 15-minute grace for providers; programme completion statuses derive from session outcomes", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", sessions: 2 });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  // Sessions are in the future: provider-recorded no_show inside grace must 409
  await assert.rejects(
    mutateTrainingSession(db, { sessionId: sessions[1].id, action: "no_show", actorId: "trainer:t", idempotencyKey: "ns-early", reason: "customer absent at start", staffOverride: false }),
    (e) => e instanceof Response && e.status === 409, "no_show before scheduled_start+grace must be rejected");
  await completeSession(db, sessions[0], "c1");
  const ns = await mutateTrainingSession(db, { sessionId: sessions[1].id, action: "no_show", actorId: "ops:staff", idempotencyKey: "ns-staff", reason: "customer absent at start", staffOverride: true });
  assert.equal(ns.status, "no_show");
  assert.equal(ns.consumption, "pending_policy", "no_show must never auto-consume a session");
  const prog = sqlite.prepare("SELECT status,completed_sessions,no_show_sessions FROM training_programmes").get();
  assert.equal(prog.status, "completed_with_exceptions", "terminal programme with a no_show is completed_with_exceptions, not completed");
  assert.equal(prog.completed_sessions, 1);
  assert.equal(prog.no_show_sessions, 1);
});

test("real execution: a programme whose every session completes cleanly ends status=completed", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", sessions: 2 });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await completeSession(db, sessions[0], "c1");
  await completeSession(db, sessions[1], "c2");
  const prog = sqlite.prepare("SELECT status,completed_sessions FROM training_programmes").get();
  assert.equal(prog.status, "completed");
  assert.equal(prog.completed_sessions, 2);
});

// ---- 3. THE ROSTER DEFECT: reschedule/replace must respect trainer roster availability ---------

test("REGRESSION lib/training-session-lifecycle.ts: staff reschedule is rejected when the trainer has no roster window (pre-fix it only checked profile + reservation overlap)", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1" });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  const s1 = sessions[0];
  // Target window: 2026-09-20 11:00-12:00 IST. NO scheduling_availability row exists.
  const newStart = new Date(Date.UTC(2026, 8, 20, 5, 30)).toISOString(), newEnd = new Date(Date.UTC(2026, 8, 20, 6, 30)).toISOString();
  const denied = await call(sessionsRoute.POST, "POST", { sessionId: s1.id, action: "reschedule", idempotencyKey: "rs-noroster", newStart, newEnd });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.match(String(denied.body.error), /roster/i, "the rejection must name the roster gap");
  assert.equal(sqlite.prepare("SELECT scheduled_start FROM training_sessions WHERE id=?").get(s1.id).scheduled_start, s1.scheduled_start, "session window must be unchanged");

  // 03:00 IST on a rostered day is still OUTSIDE the 09:00-19:00 window -> rejected
  seedRoster(TRAINER, "2026-09-20");
  const night = await call(sessionsRoute.POST, "POST", { sessionId: s1.id, action: "reschedule", idempotencyKey: "rs-night", newStart: new Date(Date.UTC(2026, 8, 19, 21, 30)).toISOString(), newEnd: new Date(Date.UTC(2026, 8, 19, 22, 30)).toISOString() });
  assert.equal(night.status, 409, "a 03:00 IST session must not pass the roster check");

  // Same request inside the roster window now succeeds and moves session + reservation together
  const ok = await call(sessionsRoute.POST, "POST", { sessionId: s1.id, action: "reschedule", idempotencyKey: "rs-ok", newStart, newEnd });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(sqlite.prepare("SELECT scheduled_start FROM training_sessions WHERE id=?").get(s1.id).scheduled_start, newStart);
  assert.equal(sqlite.prepare("SELECT scheduled_start,status FROM scheduling_reservations WHERE id=?").get(s1.schedule_reservation_id).scheduled_start, newStart);
});

test("REGRESSION: reschedule inside roster still rejects a travel-buffer collision with another reservation", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1" });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  seedRoster(TRAINER, "2026-09-02");
  // Session 2 already occupies 2026-09-02 05:30-06:30Z; move session 1 right on top of it.
  const clash = await call(sessionsRoute.POST, "POST", { sessionId: sessions[0].id, action: "reschedule", idempotencyKey: "rs-clash", newStart: sessionStart(1), newEnd: sessionEnd(1) });
  assert.equal(clash.status, 409);
  assert.match(String(clash.body.error), /travel buffer|conflicts/i);
});

test("REGRESSION: replace_provider requires the replacement trainer to be rostered for the session window", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1" });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  const s1 = sessions[0];
  const denied = await call(sessionsRoute.POST, "POST", { sessionId: s1.id, action: "replace_provider", idempotencyKey: "rp-noroster", newProviderId: "train_ramesh", reason: "original trainer unavailable" });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.match(String(denied.body.error), /roster/i);
  seedRoster("train_ramesh", "2026-09-01");
  const ok = await call(sessionsRoute.POST, "POST", { sessionId: s1.id, action: "replace_provider", idempotencyKey: "rp-ok", newProviderId: "train_ramesh", reason: "original trainer unavailable" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(sqlite.prepare("SELECT provider_id FROM training_sessions WHERE id=?").get(s1.id).provider_id, "train_ramesh");
  assert.equal(sqlite.prepare("SELECT provider_id FROM scheduling_reservations WHERE id=?").get(s1.schedule_reservation_id).provider_id, "train_ramesh");
});

// ---- 4. Customer session change: ownership + platform-session scope --------------------------

test("real execution: customer session-change route validates programme/session linkage and opens a recovery case", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1" }); seedBooking({ id: "B2", group: "G2", customer: "cus_other" });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await materializeTrainingProgramme(db, { bookingId: "B2", actorId: "uat" });
  // Session from another programme under this bookingId -> 404, not a silent cross-programme write
  const foreign = sqlite.prepare("SELECT id FROM training_sessions WHERE booking_id='B2' LIMIT 1").get();
  const cross = await call(customerChangeRoute.POST, "POST", { action: "request_reschedule", bookingId: "B1", sessionId: foreign.id, reason: "family trip conflicts", idempotencyKey: "cc-cross" });
  assert.equal(cross.status, 404);
  const ok = await call(customerChangeRoute.POST, "POST", { action: "request_reschedule", bookingId: "B1", sessionId: sessions[0].id, reason: "family trip conflicts", idempotencyKey: "cc-1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, "reschedule_requested");
  const rec = sqlite.prepare("SELECT recovery_type,status FROM training_session_recovery_cases WHERE session_id=?").get(sessions[0].id);
  assert.equal(rec.recovery_type, "reschedule");
  assert.equal(rec.status, "open");
  // Only request_reschedule is customer-reachable; staff actions must not pass through this route
  const staffLeak = await call(customerChangeRoute.POST, "POST", { action: "reschedule", bookingId: "B1", sessionId: sessions[0].id, reason: "escalation attempt!", idempotencyKey: "cc-leak" });
  assert.equal(staffLeak.status, 400);
});

test("real execution: session-change and cancellation requests from a customer who does NOT own the programme are denied (403)", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", customer: "cus_t1" });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  // Force security tables into existence, then bind mallory to a DIFFERENT customer.
  await call(opsRoute.GET, "GET");
  seedCustomerIdentity("mallory@pawspace.test", "cus_other");
  const change = await callAs(customerChangeRoute.POST, "POST", { action: "request_reschedule", bookingId: "B1", sessionId: sessions[0].id, reason: "not my booking heh", idempotencyKey: "own-1" }, "mallory@pawspace.test");
  assert.equal(change.status, 403, JSON.stringify(change.body));
  const cancel = await callAs(cancellationRoute.POST, "POST", { action: "request", bookingId: "B1", reason: "not my booking heh", idempotencyKey: "own-2" }, "mallory@pawspace.test");
  assert.equal(cancel.status, 403, JSON.stringify(cancel.body));
  // The 403 must fire BEFORE any case is written (the table may not even exist yet — same thing)
  const casesTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='training_cancellation_cases'").get();
  if (casesTable) assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_cancellation_cases").get().n, 0);
  // The rightful owner sails through the same path
  seedCustomerIdentity("trisha@pawspace.test", "cus_t1");
  const owner = await callAs(customerChangeRoute.POST, "POST", { action: "request_reschedule", bookingId: "B1", sessionId: sessions[0].id, reason: "family trip conflicts", idempotencyKey: "own-3" }, "trisha@pawspace.test");
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
});

// ---- 5. Cancellation money math: server-computed, policy-driven, 100%-refund platform rule ----

test("real execution: cancellation refund math is exact and 100% of captured money returns on an untouched programme (fee none)", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000 });
  const db = globalThis.__TRN_DB__;
  await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  // Without a published policy the case is blocked, never guessed
  const blocked = await call(cancellationRoute.POST, "POST", { action: "request", bookingId: "B1", reason: "relocating out of city", idempotencyKey: "can-1" });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.data.status, "blocked_policy_configuration");
  assert.equal(blocked.body.data.calculation, null);
  // Publish the platform rule: no fee, no-shows refundable -> untouched programme refunds 100% of captured
  const policy = await call(cancellationRoute.POST, "POST", { action: "configure_policy", cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "refundable", effectiveFrom: "2026-08-01", reason: "platform 100% refund rule" });
  assert.equal(policy.status, 200, JSON.stringify(policy.body));
  const caseRow = sqlite.prepare("SELECT * FROM training_cancellation_cases").get();
  assert.equal(caseRow.status, "calculated");
  assert.equal(caseRow.captured_amount, 4000);
  assert.equal(caseRow.per_session_value, 2000, "8000/4 sessions");
  assert.equal(caseRow.used_value, 0);
  assert.equal(caseRow.cancellation_fee, 0);
  assert.equal(caseRow.calculated_refund, 4000, "100% of captured money returns when nothing was consumed");
});

test("real execution: refund math deducts completed-session value exactly; client-sent amounts are ignored", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000 });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await completeSession(db, sessions[0], "c1");
  await call(cancellationRoute.POST, "POST", { action: "configure_policy", cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "refundable", effectiveFrom: "2026-08-01", reason: "platform 100% refund rule" });
  // Malicious body fields must have zero effect on server math
  const req = await call(cancellationRoute.POST, "POST", { action: "request", bookingId: "B1", reason: "relocating out of city", idempotencyKey: "can-1", refundAmount: 999999, calculatedRefund: 999999, capturedAmount: 999999 });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const calc = req.body.data.calculation;
  assert.equal(calc.perSessionValue, 2000);
  assert.equal(calc.usedValue, 2000, "1 completed session consumed");
  assert.equal(calc.cancellationFee, 0);
  assert.equal(calc.calculatedRefund, 2000, "4000 captured - 2000 used");
  assert.equal(calc.capturedAmount, 4000, "client-sent capturedAmount:999999 must be ignored");
  // Idempotent replay returns the same case
  const replay = await call(cancellationRoute.POST, "POST", { action: "request", bookingId: "B1", reason: "relocating out of city", idempotencyKey: "can-1" });
  assert.equal(replay.body.data.duplicatePrevented, true);
});

test("real execution: percent_captured fee and chargeable no-show change the math exactly as published", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000, sessions: 4 });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  // One staff-recorded no_show; policy says no-shows are chargeable + 10% fee on captured
  await mutateTrainingSession(db, { sessionId: sessions[0].id, action: "no_show", actorId: "ops:staff", idempotencyKey: "ns-1", reason: "customer absent at start", staffOverride: true });
  await call(cancellationRoute.POST, "POST", { action: "configure_policy", cityId: "blr", feeType: "percent_captured", feeValue: 10, noShowTreatment: "chargeable", effectiveFrom: "2026-08-01", reason: "fee policy for audit test" });
  const req = await call(cancellationRoute.POST, "POST", { action: "request", bookingId: "B1", reason: "relocating out of city", idempotencyKey: "can-2" });
  const calc = req.body.data.calculation;
  assert.equal(calc.chargeableSessions, 1, "chargeable no_show counts as used");
  assert.equal(calc.usedValue, 2000);
  assert.equal(calc.cancellationFee, 400, "10% of 4000 captured");
  assert.equal(calc.calculatedRefund, 1600, "4000 - 2000 used - 400 fee");
});

test("real execution: approval enforces segregation of duties, cancels everything atomically, and the refund instruction carries the server-computed amount", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000 });
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES ('WO1','B1','G1',?,'Kiran S.','commission','dog_training',?,?,4,'assigned',?,?)")
    .run(TRAINER, sessionStart(0), sessionEnd(3), NOW, NOW);
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await completeSession(db, sessions[0], "c1");
  await call(cancellationRoute.POST, "POST", { action: "configure_policy", cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "refundable", effectiveFrom: "2026-08-01", reason: "platform 100% refund rule" });
  // Request as the CUSTOMER identity so the preview approver is a different actor
  const req = await requestTrainingCancellation(db, { bookingId: "B1", reason: "relocating out of city", idempotencyKey: "can-3", actorId: "customer:cus_t1" });
  assert.equal(req.status, "calculated");
  // Segregation of duties: the requester cannot approve their own refund
  await assert.rejects(
    approveTrainingCancellation(db, { caseId: req.caseId, reason: "self approval attempt", actorId: "customer:cus_t1" }),
    (e) => e instanceof Response && e.status === 409);
  const approve = await call(cancellationRoute.POST, "POST", { action: "approve", caseId: req.caseId, reason: "finance approved relocation refund" });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(approve.body.data.approvedRefund, 2000, "server-computed: 4000 captured - 2000 consumed");
  assert.equal(approve.body.data.liveRefund, false, "sandbox only — no live money movement");
  assert.equal(approve.body.data.cancelledFutureSessions, 3);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='B1'").get().status, "cancelled");
  assert.equal(sqlite.prepare("SELECT status FROM provider_work_orders WHERE id='WO1'").get().status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_sessions WHERE status='cancelled'").get().n, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE status='cancelled'").get().n, 3);
  const refund = sqlite.prepare("SELECT amount,status,idempotency_key,live FROM training_refund_instructions").get();
  assert.equal(refund.amount, 2000);
  assert.equal(refund.status, "instruction_ready_sandbox");
  assert.equal(refund.live, 0);
  assert.equal(refund.idempotency_key, `training-refund:${req.caseId}`);
  // Completed value is preserved: the consumed session is NOT flipped to cancelled
  assert.equal(sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(sessions[0].id).status, "completed");
  // Second approval attempt must not double-create refund instructions
  const again = await call(cancellationRoute.POST, "POST", { action: "approve", caseId: req.caseId, reason: "double approval attempt" });
  assert.equal(again.status, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_refund_instructions").get().n, 1);
});

test("REGRESSION lib/training-cancellation.ts: approval no longer crashes when the provider_work_orders surface was never initialized", async () => {
  freshDb(); baseTables();
  sqlite.exec("DROP TABLE provider_work_orders");
  seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000 });
  const db = globalThis.__TRN_DB__;
  await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await call(cancellationRoute.POST, "POST", { action: "configure_policy", cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "refundable", effectiveFrom: "2026-08-01", reason: "platform 100% refund rule" });
  const req = await requestTrainingCancellation(db, { bookingId: "B1", reason: "relocating out of city", idempotencyKey: "can-4", actorId: "customer:cus_t1" });
  const approve = await call(cancellationRoute.POST, "POST", { action: "approve", caseId: req.caseId, reason: "finance approved relocation refund" });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(approve.body.data.approvedRefund, 4000);
});

// ---- 6. Provider earnings derive from completed sessions only ---------------------------------

test("real execution: trainer earnings exist ONLY for completed sessions and derive from the published per-session rule", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000, sessions: 3 });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await completeSession(db, sessions[0], "c1");
  await mutateTrainingSession(db, { sessionId: sessions[1].id, action: "no_show", actorId: "ops:staff", idempotencyKey: "ns-1", reason: "customer absent at start", staffOverride: true });
  await saveTrainingCompensationRule(db, { cityId: "blr", rateValue: 700, effectiveFrom: "2026-08-01", reason: "trainer per-session compensation", actorId: "finance:uat" });
  const res = await call(earningsRoute.GET, "GET", `providerId=${TRAINER}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const earnings = res.body.data.earnings;
  assert.equal(earnings.length, 1, "no_show and scheduled sessions must NOT earn");
  assert.equal(earnings[0].session_id, sessions[0].id);
  assert.equal(earnings[0].gross_earning, 700);
  assert.equal(earnings[0].status, "earned", "captured 4000 covers 1x per-session value 2666.67");
  assert.equal(res.body.data.livePayout, false);
  // Refresh replay must not duplicate earning rows
  await refreshTrainingFinanceReadModel(db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_session_earnings").get().n, 1);
});

test("real execution: earnings are held when captured money does not yet cover delivered value", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 0, sessions: 4 });
  sqlite.prepare("UPDATE booking_payments SET amount_due_now=0 WHERE booking_id='B1'").run();
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await completeSession(db, sessions[0], "c1");
  await saveTrainingCompensationRule(db, { cityId: "blr", rateValue: 700, effectiveFrom: "2026-08-01", reason: "trainer per-session compensation", actorId: "finance:uat" });
  const row = sqlite.prepare("SELECT status,hold_reason FROM training_session_earnings").get();
  assert.equal(row.status, "held_payment", "0 captured cannot cover a 2000 per-session delivery");
  assert.match(String(row.hold_reason), /does not yet cover/);
});

// ---- 7. Reconciliation cross-check: read model equals canonical booking pricing ----------------

test("real execution: a pristine quote-linked programme reconciles with ZERO issues; every tampered total surfaces as an exception", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000 });
  const db = globalThis.__TRN_DB__;
  await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  // Canonical server-quote linkage exactly as the commercial engine writes it
  await call(reconciliationRoute.GET, "GET"); // ensures training_commercial_quotes tables exist via the real route
  sqlite.prepare("INSERT INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,coupon_code,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at,used_at,used_booking_id) VALUES ('Q1','obedience-starter',1,1,?,'deposit',NULL,0,8000,4000,60,4,7,?, 'used',?,?,'B1')")
    .run(sessionStart(0), NOW + 7 * 86_400_000, NOW, NOW);
  sqlite.prepare("INSERT INTO training_booking_quote_links (quote_id,booking_id,created_at) VALUES ('Q1','B1',?)").run(NOW);
  const clean = await call(reconciliationRoute.GET, "GET");
  assert.equal(clean.status, 200, JSON.stringify(clean.body));
  const record = clean.body.data.records.find(r => r.bookingId === "B1");
  assert.deepEqual(record.issues, [], JSON.stringify(record));
  assert.equal(record.status, "reconciled");
  assert.equal(record.commercial.bookingTotal, 8000);
  assert.equal(record.commercial.paymentAmount, 8000);
  assert.equal(record.commercial.amountDueNow, 4000);
  assert.equal(record.commercial.invoiceCommercialTotal, 8000, "finance invoice read model must equal canonical booking pricing");
  assert.equal(clean.body.data.liveMoney, false);
  // Tamper 1: payment ledger drifts from the canonical total
  sqlite.prepare("UPDATE booking_payments SET amount=7000 WHERE booking_id='B1'").run();
  const drift1 = await call(reconciliationRoute.GET, "GET");
  const r1 = drift1.body.data.records.find(r => r.bookingId === "B1");
  assert.equal(r1.status, "exception");
  assert.ok(r1.issues.some(i => /Payment commercial amount does not match/.test(i)), JSON.stringify(r1.issues));
  sqlite.prepare("UPDATE booking_payments SET amount=8000 WHERE booking_id='B1'").run();
  // Tamper 2: quote totals no longer match the booking
  sqlite.prepare("UPDATE training_commercial_quotes SET total_amount=9000 WHERE id='Q1'").run();
  const drift2 = await call(reconciliationRoute.GET, "GET");
  const r2 = drift2.body.data.records.find(r => r.bookingId === "B1");
  assert.ok(r2.issues.some(i => /quote total does not match booking/i.test(i)), JSON.stringify(r2.issues));
  sqlite.prepare("UPDATE training_commercial_quotes SET total_amount=8000 WHERE id='Q1'").run();
  // Tamper 3: a phantom earning on a non-completed session is called out
  sqlite.prepare("INSERT INTO training_session_earnings (session_id,programme_id,booking_id,provider_id,city_id,package_code,gross_earning,currency,status,completed_at,calculated_at,updated_at) SELECT id,programme_id,booking_id,provider_id,'blr','obedience-starter',700,'INR','earned',?,?,? FROM training_sessions LIMIT 1")
    .run(NOW, NOW, NOW);
  const drift3 = await call(reconciliationRoute.GET, "GET");
  const r3 = drift3.body.data.records.find(r => r.bookingId === "B1");
  assert.ok(r3.issues.some(i => /Earning exists for non-completed session/.test(i)), JSON.stringify(r3.issues));
});

test("real execution: reconciliation totals still agree after real completions and the finance read model refresh", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1", total: 8000, dueNow: 4000, sessions: 2 });
  const db = globalThis.__TRN_DB__;
  const { sessions } = await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  await completeSession(db, sessions[0], "c1");
  await saveTrainingCompensationRule(db, { cityId: "blr", rateValue: 700, effectiveFrom: "2026-08-01", reason: "trainer per-session compensation", actorId: "finance:uat" });
  const res = await call(reconciliationRoute.GET, "GET");
  const record = res.body.data.records.find(r => r.bookingId === "B1");
  assert.equal(record.sessions.completed, 1);
  assert.equal(record.sessions.consumed, 1);
  assert.equal(record.sessions.earnings, 1);
  // Only the missing quote link (legacy record) may be flagged — every money total must agree
  assert.deepEqual(record.issues, ["Training booking has no canonical server quote link (legacy/pre-Gate-3 record)"], JSON.stringify(record.issues));
});

// ---- 8. Ops read surface + contracts -----------------------------------------------------------

test("real execution: training-ops masks customer names and reports real metrics", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", group: "G1" });
  const db = globalThis.__TRN_DB__;
  await materializeTrainingProgramme(db, { bookingId: "B1", actorId: "uat" });
  const res = await call(opsRoute.GET, "GET");
  assert.equal(res.status, 200);
  const prog = res.body.data.programmes[0];
  assert.notEqual(prog.customer_name, "Trisha Kumar", "full customer name must be masked for ops staff");
  assert.equal(prog.sessions.length, 4);
  assert.equal(res.body.data.metrics.activeProgrammes, 1);
  assert.ok(res.body.data.trainers.some(t => t.id === TRAINER));
  assert.equal(res.body.data.liveMoney, false);
});

test("contract: gateway permission map, DB access rule, and team surfaces for the training stack", () => {
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /training-finance"\)return method==="GET"\?"finance\.view":"finance\.manage"/);
  assert.match(gateway, /training-customer-session-change"\)return "scheduling\.book"/);
  assert.match(gateway, /training-ops"\)return "bookings\.view"/);
  assert.match(gateway, /training-provider-earnings"\)return "bookings\.view"/);
  assert.match(gateway, /training-reconciliation"\)return "reports\.view"/);
  assert.match(gateway, /training-cancellation"[\s\S]{0,200}"request"\?"scheduling\.book":"finance\.manage"/);
  for (const route of ["training-ops", "training-sessions", "training-customer-session-change", "training-cancellation", "training-provider-earnings", "training-finance", "training-reconciliation"]) {
    const source = fs.readFileSync(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /globalThis/, `${route} must get the DB via cloudflare:workers env, never globalThis`);
  }
  const lifecycle = fs.readFileSync(new URL("../lib/training-session-lifecycle.ts", import.meta.url), "utf8");
  assert.match(lifecycle, /rosterCovers/, "reschedule/replace must keep the roster availability check");
  assert.match(lifecycle, /scheduling_availability WHERE provider_id=\? AND date=\?/);
  const panel = fs.readFileSync(new URL("../app/admin/training-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\/api\/training-(ops|sessions)/);
  const financePage = fs.readFileSync(new URL("../app/team/finance/training/page.tsx", import.meta.url), "utf8");
  assert.match(financePage, /\/api\/training-(finance|cancellation)/);
});
