import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// /api/canonical-bookings is authorized by the WORKER, not by route-local code. These tests prove that
// layer actually protects it, under the policy that is authoritative for this release:
//
//   GET  /api/canonical-bookings -> bookings.manage (platform-wide list)
//   POST /api/canonical-bookings -> scheduling.book AND canonical customer ownership
//
// They drive the REAL gateway modules in the REAL order worker/index.ts composes them:
//
//   inspectionRequest = request.clone()                                    // preserve route body
//   sessionAccess = await authorizePlatformSessionRequest(inspectionRequest, env.DB)
//   if (sessionAccess instanceof Response) refuse
//   access = sessionAccess ?? await authorizeApiRequest(inspectionRequest, env)
//   if (access instanceof Response) refuse
//   -> route handler
//
// LIMITATION, stated plainly: worker/index.ts itself cannot be imported in-process, because it pulls
// `vinext/server/app-router-entry`, a `virtual:` module that only exists inside the bundler. So the
// framework's route DISPATCH is substituted here, while every authorization decision comes from the
// production modules, the production policy map and a real database. The last test pins the worker's
// composition against this mirror so the two cannot drift apart silently.
//
// Requests deliberately use a NON-localhost host: authorizeApiRequest short-circuits localhost,
// 127.0.0.1 and terminal.local to a dev-preview superuser, which would make every assertion vacuous.
// ---------------------------------------------------------------------------
installWorkersHooks("__CB_GATEWAY_DB__", "__CB_GATEWAY_ENV__");

const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/canonical-bookings`;
const CUSTOMER = "CUS-GW-1", OTHER_CUSTOMER = "CUS-GW-2", PROVIDER = "PRV-GW-1";
const START = "2026-11-04T09:00:00.000Z", END = "2026-11-04T11:00:00.000Z";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** PAWSPACE_UAT_LOGIN stays unset: the staging sign-in path must not be what authenticates anyone here. */
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CB_GATEWAY_DB__ = db;
  globalThis.__CB_GATEWAY_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };

  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  // manager holds bookings.manage; finance and service_provider do not. These are real seeded roles,
  // so a refusal is a genuine policy outcome rather than an unprovisioned-account accident.
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-mgr", "ops.manager@pawspace.in", "Ops manager", "manager", "active");
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-fin", "finance@pawspace.in", "Finance", "finance", "active");
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-prv", "provider.list@pawspace.in", "Provider", "service_provider", "active");
  return { sqlite, db };
}

/** Exactly the sequence worker/index.ts runs for /api/*. Pinned against the worker by the last test. */
async function throughGateway(request) {
  const env = { DB: globalThis.__CB_GATEWAY_DB__, ...globalThis.__CB_GATEWAY_ENV__ };
  const url = new URL(request.url);
  if (request.method === "POST" && (url.pathname === "/api/uat-scheduling" || url.pathname === "/api/canonical-bookings")) {
    const { cleanupExpiredReservationLeases } = await import("../lib/scheduling-reservation-leases.ts");
    await cleanupExpiredReservationLeases(env.DB);
  }
  const inspectionRequest = request.clone();
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(inspectionRequest, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(inspectionRequest, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

/** Run the request through the gateway and, only if permitted, on to the real route handler. */
async function callEndpoint(request) {
  const gate = await throughGateway(request);
  if (gate.refused) {
    let body = null;
    try { body = JSON.parse(await gate.refused.clone().text()); } catch { /* non-JSON */ }
    return { reachedRoute: false, status: gate.refused.status, body };
  }
  const route = await import("../app/api/canonical-bookings/route.ts");
  const handler = request.method === "GET" ? route.GET : route.POST;
  const response = await handler(request);
  let body = null;
  try { body = JSON.parse(await response.clone().text()); } catch { /* non-JSON */ }
  return { reachedRoute: true, status: response.status, body };
}

/** A real customer or provider session: verified identity binding, then an issued session token. */
async function sessionCookie(db, subjectType, subjectId, principalKey) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey,
    subjectType, subjectId, cityId: null, verificationState: "verified", expiresAt: null,
    metadata: {}, actorId: "test", reason: "gateway authorization test",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType, subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

function bookingPayload(customerId = CUSTOMER) {
  return JSON.stringify({
    idempotencyKey: `gw-${customerId}-1`, scheduleGroupId: `SG-GW-${customerId}`,
    customer: { id: customerId, name: "Gateway tester", primaryPhone: "+919000000001" },
    pets: [{ sourceId: "gw-pet-1", name: "Rex", species: "dog" }],
    cityId: "blr", zoneId: "koramangala",
    serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Pet Sitting",
    scheduledStart: START, scheduledEnd: END,
    provider: { id: PROVIDER, name: "Sitter One", model: "full_time" },
    totalAmount: 1349, amountDueNow: 1349,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0 },
  });
}

const post = (body, headers = {}) => new Request(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body });
const get = (headers = {}) => new Request(ENDPOINT, { headers });

/** Tables a booking write would touch. A gateway refusal must move none of them. */
const TOUCHED = ["canonical_pets", "canonical_bookings", "booking_payments", "provider_work_orders", "booking_lifecycle_events"];
const counts = (sqlite) => Object.fromEntries(TOUCHED.map((t) => {
  try { return [t, sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]; } catch { return [t, 0]; }
}));

/** Seed one confirmed booking so a refused GET has real data available to leak, and none to find. */
function seedBooking(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL DEFAULT '',secondary_phone TEXT,email TEXT,created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL DEFAULT 'pet_sitting',city_id TEXT NOT NULL DEFAULT 'blr',zone_id TEXT NOT NULL DEFAULT 'koramangala',package_code TEXT NOT NULL DEFAULT '',package_name TEXT NOT NULL DEFAULT '',pet_ids_json TEXT NOT NULL DEFAULT '[]',scheduled_start TEXT NOT NULL DEFAULT '',scheduled_end TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',total_amount REAL NOT NULL DEFAULT 0,pricing_json TEXT NOT NULL DEFAULT '{}',schedule_group_id TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL DEFAULT '',provider_model TEXT NOT NULL DEFAULT 'full_time',status TEXT NOT NULL DEFAULT 'assigned',occurrence_count INTEGER NOT NULL DEFAULT 1)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'captured',amount_due_now REAL NOT NULL DEFAULT 0,gateway TEXT NOT NULL DEFAULT 'sandbox')");
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,name,primary_phone) VALUES (?,?,?)").run(CUSTOMER, "Leaky Customer Name", "+919000000001");
  sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,idempotency_key,customer_id,provider_id) VALUES (?,?,?,?)").run("BK-GW-LEAK-1", "seeded-gw-1", CUSTOMER, PROVIDER);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,provider_id,provider_name) VALUES (?,?,?,?)").run("WO-GW-1", "BK-GW-LEAK-1", PROVIDER, "Leaky Provider Name");
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments (id,booking_id) VALUES (?,?)").run("PAY-GW-1", "BK-GW-LEAK-1");
}

// --- GET: platform-wide list requires bookings.manage ------------------------------------------

test("GET with bookings.manage is permitted and keeps its existing success behaviour", async () => {
  const { sqlite } = freshDb();
  seedBooking(sqlite);
  const result = await callEndpoint(get({ "oai-authenticated-user-email": "ops.manager@pawspace.in" }));
  assert.equal(result.reachedRoute, true, `a manager holding bookings.manage must pass the gateway: ${JSON.stringify(result.body)}`);
  assert.equal(result.status, 200, `and the route must still answer: ${JSON.stringify(result.body)}`);
  assert.ok(Array.isArray(result.body?.bookings), "the existing success shape is preserved: { bookings: [...] }");
  // The mirror image of the leak test: what a refused caller cannot see, an authorized one still gets.
  assert.equal(result.body.bookings.length, 1, `the seeded booking is returned: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.bookings[0].id, "BK-GW-LEAK-1");
});

test("GET without bookings.manage is refused, and the refusal leaks no booking, customer or provider data", async () => {
  const { sqlite } = freshDb();
  seedBooking(sqlite);
  const result = await callEndpoint(get({ "oai-authenticated-user-email": "finance@pawspace.in" }));

  assert.equal(result.reachedRoute, false, "finance does not hold bookings.manage and must never reach the handler");
  assert.equal(result.status, 403, `the established refusal for a known identity lacking the permission: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, "Permission denied");

  const serialized = JSON.stringify(result.body);
  for (const secret of ["BK-GW-LEAK-1", "Leaky Customer Name", "Leaky Provider Name", PROVIDER, CUSTOMER, "PAY-GW-1"]) {
    assert.ok(!serialized.includes(secret), `the refusal must not disclose ${secret}`);
  }
});


test("service_provider cannot use bookings.view to read the platform-wide canonical booking list", async () => {
  const { sqlite } = freshDb();
  seedBooking(sqlite);
  const result = await callEndpoint(get({ "oai-authenticated-user-email": "provider.list@pawspace.in" }));

  assert.equal(result.reachedRoute, false, "assigned-job access must not open the platform-wide booking list");
  assert.equal(result.status, 403, `service_provider must be refused: ${JSON.stringify(result.body)}`);
  const serialized = JSON.stringify(result.body);
  for (const secret of ["BK-GW-LEAK-1", "Leaky Customer Name", "Leaky Provider Name", PROVIDER, CUSTOMER, "PAY-GW-1"]) {
    assert.ok(!serialized.includes(secret), `the refusal must not disclose ${secret}`);
  }
});

test("GET with no identity at all is refused before the handler", async () => {
  freshDb();
  const result = await callEndpoint(get());
  assert.equal(result.reachedRoute, false, "an anonymous read must not reach the handler");
  assert.equal(result.status, 401, `anonymous is unauthenticated, not merely unauthorized: ${JSON.stringify(result.body)}`);
});

// --- POST: scheduling.book AND canonical customer ownership ------------------------------------

test("POST with no identity is refused before validation and writes nothing", async () => {
  const { sqlite } = freshDb();
  const before = counts(sqlite);

  // The payload is deliberately INVALID (no pets, no customer). If validation ran first the answer
  // would be 400; the gateway must answer 401 instead, proving authorization precedes validation.
  const result = await callEndpoint(post(JSON.stringify({ idempotencyKey: "gw-anon" })));
  assert.equal(result.reachedRoute, false, "an anonymous write must not reach the handler");
  assert.equal(result.status, 401, `authorization must precede validation: ${JSON.stringify(result.body)}`);
  assert.notEqual(result.status, 400, "a validation error would mean the payload was inspected first");
  assert.deepEqual(counts(sqlite), before, "a refused write must touch no table");
});

test("POST from an identity without scheduling.book is refused with zero writes", async () => {
  const { sqlite } = freshDb();
  const before = counts(sqlite);
  const result = await callEndpoint(post(bookingPayload(), { "oai-authenticated-user-email": "finance@pawspace.in" }));
  assert.equal(result.reachedRoute, false, "finance does not hold scheduling.book");
  assert.equal(result.status, 403, `refused by policy: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, "Permission denied");
  assert.deepEqual(counts(sqlite), before, "a refused write must touch no table");
});

test("POST from a customer session holding scheduling.book, booking its OWN customer id, reaches the handler", async () => {
  const { db } = freshDb();
  const cookie = await sessionCookie(db, "customer", CUSTOMER, "+919000000001");
  const result = await callEndpoint(post(bookingPayload(CUSTOMER), { cookie }));
  assert.equal(result.reachedRoute, true, `an owning customer session must pass the gateway: ${JSON.stringify(result.body)}`);
  // What the handler then does is its own contract; the gateway's job is done once the request arrives.
  assert.ok(result.status >= 200, "the handler answered");
  assert.notEqual(result.status, 401, "an authorized session is not unauthenticated at the route");
  assert.notEqual(result.status, 403, "an authorized session is not forbidden at the route");
});

test("POST from a customer session booking ANOTHER customer's id is refused with zero writes", async () => {
  const { sqlite, db } = freshDb();
  const cookie = await sessionCookie(db, "customer", CUSTOMER, "+919000000001");
  const before = counts(sqlite);

  const result = await callEndpoint(post(bookingPayload(OTHER_CUSTOMER), { cookie }));
  assert.equal(result.reachedRoute, false, "a session may not write against a customer it does not own");
  assert.equal(result.status, 403, `cross-customer writes are refused: ${JSON.stringify(result.body)}`);
  assert.deepEqual(counts(sqlite), before, "a refused cross-customer write must touch no table");
});

test("an expired authentic session releases its server-owned reservation before gateway refusal", async () => {
  const { sqlite, db } = freshDb();
  sqlite.exec(`
    CREATE TABLE scheduling_assignment_decisions (
      group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,
      selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL
    );
    CREATE TABLE scheduling_reservations (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,
      city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,
      scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,
      occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,
      explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
    );
  `);
  const { ensureSchedulingReservationLeaseGovernance } = await import("../lib/scheduling-reservation-leases.ts");
  await ensureSchedulingReservationLeaseGovernance(db);
  const cookie = await sessionCookie(db, "customer", CUSTOMER, "+919000000001");
  const now = Date.now();
  const session = sqlite.prepare("SELECT id FROM platform_identity_sessions WHERE subject_type='customer' AND subject_id=? ORDER BY issued_at DESC LIMIT 1").get(CUSTOMER);
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'auto','{}',?,'assigned','system','Auto-assigned',?)").run(`SG-GW-${CUSTOMER}`, PROVIDER, now);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at,lease_expires_at,customer_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'assigned','{}',?,?,?)")
    .run("RES-GW-EXPIRED", `SG-GW-${CUSTOMER}`, PROVIDER, "pet_sitting", "blr", "koramangala", CUSTOMER, '["gw-pet-1"]', START, END, 1, 1, null, now, now + 60_000, session.id);
  sqlite.prepare("UPDATE platform_identity_sessions SET expires_at=? WHERE id=?").run(now - 1, session.id);

  const result = await callEndpoint(post(bookingPayload(CUSTOMER), { cookie }));
  assert.equal(result.reachedRoute, false, "the expired session is still refused by the production gateway order");
  assert.equal(result.status, 401);
  assert.equal(sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id='RES-GW-EXPIRED'").get().status, "cancelled");
  assert.equal(sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(`SG-GW-${CUSTOMER}`).status, "expired");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(`SG-GW-${CUSTOMER}`).n, 1);

  const replay = await callEndpoint(post(bookingPayload(CUSTOMER), { cookie }));
  assert.equal(replay.status, 401);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(`SG-GW-${CUSTOMER}`).n, 1, "gateway retries keep cleanup idempotent");
});

test("POST from a PROVIDER session is refused for a customer-scoped write", async () => {
  const { sqlite, db } = freshDb();
  const cookie = await sessionCookie(db, "provider", PROVIDER, "+919000000777");
  const before = counts(sqlite);

  const result = await callEndpoint(post(bookingPayload(CUSTOMER), { cookie }));
  assert.equal(result.reachedRoute, false, "a provider identity may not create a customer's booking");
  assert.equal(result.status, 403, `cross-subject writes are refused: ${JSON.stringify(result.body)}`);
  assert.deepEqual(counts(sqlite), before, "a refused cross-subject write must touch no table");
});

test("client-supplied identity and role headers cannot manufacture authorization", async () => {
  const { sqlite } = freshDb();
  const before = counts(sqlite);

  // Each of these asserts privilege the caller does not have: a forged role, a forged permission set,
  // a forged session subject, and an email that is not a provisioned app_users row.
  for (const [label, headers] of [
    ["forged role header", { "x-role": "founder", "x-role-code": "founder" }],
    ["forged permissions header", { "x-permissions": "*", "x-pawspace-permissions": "*" }],
    ["forged session subject", { "x-subject-type": "customer", "x-subject-id": CUSTOMER }],
    ["unprovisioned email", { "oai-authenticated-user-email": "attacker@example.com" }],
    ["forged role on top of a real but unprivileged identity", { "oai-authenticated-user-email": "finance@pawspace.in", "x-role": "founder", "x-permissions": "*" }],
  ]) {
    const result = await callEndpoint(post(bookingPayload(), headers));
    assert.equal(result.reachedRoute, false, `${label} must not reach the handler`);
    assert.ok([401, 403].includes(result.status), `${label} must be refused (got ${result.status} ${JSON.stringify(result.body)})`);
    assert.deepEqual(counts(sqlite), before, `${label} must touch no table`);
  }
});

test("the route independently enforces the platform-wide booking-list permission", async () => {
  const { sqlite } = freshDb();
  seedBooking(sqlite);

  // The Worker remains the first boundary, but a dispatch/configuration mistake must not expose this
  // platform-wide data set. Route-local authorization is deliberate defense in depth.
  const route = await import("../app/api/canonical-bookings/route.ts");
  const direct = await route.GET(get({ "oai-authenticated-user-email": "finance@pawspace.in" }));
  assert.equal(direct.status, 403, "the handler itself refuses an identity without bookings.manage");
  assert.equal(direct.headers.get("cache-control"), "no-store");
  const body = await direct.json();
  assert.equal(body.error, "Permission denied");
  assert.ok(!JSON.stringify(body).includes("BK-GW-LEAK-1"));
});

// --- the mirror cannot drift from the worker ---------------------------------------------------

test("worker/index.ts routes every /api/* request through this same authorization composition", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");

  // The sequence this suite mirrors. If the worker is reordered or a gateway is dropped, this fails.
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/, "the worker gates on the /api/ prefix");
  assert.match(worker, /cleanupExpiredReservationLeases\(env\.DB\)/, "system-owned lease cleanup runs before request authorization");
  assert.match(worker, /const inspectionRequest=request\.clone\(\)/, "authorization inspects a clone so route bodies remain unread");
  assert.ok(worker.indexOf("cleanupExpiredReservationLeases(env.DB)") < worker.indexOf("authorizePlatformSessionRequest(inspectionRequest,env.DB)"), "an expired session cannot be refused before its server-owned lease is considered");
  assert.match(worker, /authorizePlatformSessionRequest\(inspectionRequest,\s*env\.DB\)/, "the session gateway runs first");
  assert.match(worker, /sessionAccess\s+instanceof\s+Response\s*\)\s*return\s+sessionAccess/, "a session refusal is returned as-is");
  assert.match(worker, /sessionAccess\s*\?\?\s*await\s+authorizeApiRequest\(inspectionRequest,\s*env\)/, "the staff gateway is the fallback, not a replacement");
  assert.match(worker, /access\s+instanceof\s+Response\s*\)\s*return\s+access/, "a staff refusal is returned as-is");

  // Public HTTP cannot reach the handler around the gateway: within the /api/ branch the ONLY documented
  // pre-gateway dispatch is /api/identity-session, which mints sessions and is exempt by design.
  const apiBranch = worker.slice(worker.indexOf('startsWith("/api/")'), worker.indexOf("/_vinext/image"));
  const preGateway = apiBranch.slice(0, apiBranch.indexOf("authorizePlatformSessionRequest"));
  const exemptions = [...preGateway.matchAll(/handler\.fetch/g)];
  assert.equal(exemptions.length, 1, "exactly one pre-gateway dispatch may exist");
  assert.match(preGateway, /\/api\/identity-session/, "and it is /api/identity-session, by design");
});
