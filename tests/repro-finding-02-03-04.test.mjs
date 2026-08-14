import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// REPRODUCTION ONLY — findings 2, 3, 4 against EXACT main (commit 1240359).
//
// These drive the REAL two-gateway worker path exactly as worker/index.ts composes it
// (worker/index.ts:47-49):
//     const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);  // line 47
//     if (sessionAccess instanceof Response) return sessionAccess;                    // line 48
//     const access = sessionAccess ?? await authorizeApiRequest(request, env);        // line 49
// i.e. the platform-session gateway (lib/session-api-gateway.ts) is asked first; if it
// returns null (no session scope for the route) the request falls through to the main
// gateway (lib/api-gateway.ts). driveGateway() below reproduces that compose order.
//
// URLs are https://uat.pawspace.in/... on purpose. A localhost URL short-circuits the main
// gateway to a dev-preview superuser (lib/api-gateway.ts: `["terminal.local","localhost",
// "127.0.0.1"].includes(url.hostname) -> permissions:["*"]`) and every deny below would then
// pass for the wrong reason.
// ---------------------------------------------------------------------------
installWorkersHooks("__REPRO_DB__", "__REPRO_ENV__");

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

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  // The main gateway audits denied session actors into security_audit_events (lib/api-gateway.ts,
  // the `if(session){...await audit(...)...}` branch). That table is not created on the session
  // resolution path, so seed it or the 403 return throws before it is reached.
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  globalThis.__REPRO_DB__ = db;
  globalThis.__REPRO_ENV__ = {}; // PAWSPACE_UAT_LOGIN unset + no Razorpay keys: staging login and online pay are both off.
  return { sqlite, db };
}

/** The real worker gateway path, in worker/index.ts:47-49 compose order. */
async function driveGateway(request, db) {
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, db);
  if (sessionAccess instanceof Response) return sessionAccess;         // platform gateway refused
  return sessionAccess ?? await authorizeApiRequest(request, { DB: db }); // fall through to main gateway
}

async function bodyOf(res) { try { return await res.clone().json(); } catch { return null; } }

/** A real customer platform session: verified identity binding + issued session cookie. */
async function customerCookie(db, customerId, principalKey) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "test", reason: "repro customer session",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

/** A real provider platform session. */
async function providerCookie(db, providerId, principalKey) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey,
    subjectType: "provider", subjectId: providerId, verificationState: "verified",
    actorId: "test", reason: "repro provider session",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const post = (path, cookie, body) => new Request(`https://uat.pawspace.in${path}`, {
  method: "POST",
  headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

// ===========================================================================
// FINDING 2 (P1): customer-owned self-service routes are ABSENT from
// lib/session-api-gateway.ts, so they fall through to the main gateway's
// `dashboard.view` default (lib/api-gateway.ts:136). Customers hold only
// ["pricing.view","scheduling.book"] (lib/platform-security.ts:24) -> the real
// Worker refuses the request with 403 before the route runs.
// ===========================================================================
const FINDING2_ROUTES = [
  "/api/payment-order", "/api/pawspace-wallet", "/api/paw-points", "/api/pet-passport",
  "/api/pet-vaccination", "/api/pet-emergency", "/api/pet-birthday", "/api/service-review",
];

for (const route of FINDING2_ROUTES) {
  test(`FINDING 2 — customer session is DENIED at the gateway for POST ${route}`, async () => {
    const { db } = freshDb();
    const cookie = await customerCookie(db, "CUS-OWNER", "+919900000001");

    const access = await driveGateway(post(route, cookie, { customerId: "CUS-OWNER" }), db);

    // It is a refusal, not an access grant.
    assert.ok(access instanceof Response, `${route}: expected a gateway Response refusal, got an access grant`);
    assert.equal(access.status, 403, `${route}: expected 403 at the gateway`);
    assert.equal((await bodyOf(access))?.error, "Permission denied", `${route}: expected the main gateway's permission-denied body`);

    // Prove WHY: the main gateway resolves this route to the `dashboard.view` default (a localhost
    // request short-circuits to the preview actor so we can read the resolved permission directly).
    const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
    const resolved = await authorizeApiRequest(new Request(`http://localhost${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { DB: db });
    assert.ok(!(resolved instanceof Response), `${route}: preview actor should resolve, not refuse`);
    assert.equal(resolved.permission, "dashboard.view", `${route}: falls to the dashboard.view default (lib/api-gateway.ts:136)`);
  });
}

test("FINDING 2 — the customer role genuinely lacks dashboard.view, so the deny is a permission gap not a bug in the deny path", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const customer = defaultRoles.find((r) => r.code === "customer");
  assert.deepEqual([...customer.permissions], ["pricing.view", "scheduling.book"], "customer holds only pricing.view + scheduling.book (platform-security.ts:24)");
  assert.ok(!customer.permissions.includes("dashboard.view"), "customer does NOT hold dashboard.view — that is why the dashboard.view default refuses it");
});

test("FINDING 2 — ALLOWED baseline: payment-order's OWN ownership check is correct (fix is a gateway mapping, not the route)", async () => {
  const { sqlite, db } = freshDb();
  // Seed a real unpaid booking + payment for CUS-OWNER so the route reaches its ownership + intent logic.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL DEFAULT '',service_code TEXT NOT NULL DEFAULT 'grooming',scheduled_start TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',total_amount REAL NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,amount REAL NOT NULL DEFAULT 0,amount_due_now REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL DEFAULT 'awaiting_payment')");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id) VALUES (?,?)").run("BK-OWN", "CUS-OWNER");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,amount,amount_due_now,currency,status) VALUES (?,?,?,?,?,?)").run("PAY-OWN", "BK-OWN", 5000, 5000, "INR", "awaiting_payment");

  const { POST } = await import("../app/api/payment-order/route.ts");

  // Owner: the route's requireCustomerOwnership passes -> it does NOT 401/403, it proceeds and
  // fails closed on Razorpay (connected:false, HTTP 200) because no keys are configured.
  const ownerCookie = await customerCookie(db, "CUS-OWNER", "+919900000001");
  const ok = await POST(post("/api/payment-order", ownerCookie, { bookingId: "BK-OWN" }));
  assert.ok(![401, 403].includes(ok.status), `owner must clear the route's ownership gate, got HTTP ${ok.status}`);
  const okBody = await ok.clone().json();
  assert.equal(okBody?.data?.connected, false, "no Razorpay keys -> fails closed (connected:false), proving ownership passed and the route ran");

  // Non-owner: a different verified customer asking to pay for CUS-OWNER's booking is refused 403
  // by the route's OWN requireCustomerOwnership (lib/server-auth.ts) — the ownership check is correct.
  const otherCookie = await customerCookie(db, "CUS-OTHER", "+919900000002");
  const denied = await POST(post("/api/payment-order", otherCookie, { bookingId: "BK-OWN", customerId: "CUS-OWNER" }));
  assert.equal(denied.status, 403, `non-owner must be refused by the route's ownership check, got HTTP ${denied.status}`);
  assert.equal((await denied.clone().json())?.error, "Customer ownership denied");
});

// ===========================================================================
// FINDING 3 (P1): /api/partner-otp (request/verify OTP, mint provider session) is
// ABSENT from the main gateway's PUBLIC (null) route list (lib/api-gateway.ts:14-15),
// so an anonymous OTP request falls to the dashboard.view default and is rejected
// BEFORE the route runs. Contrast /api/customer-otp, which IS in that null list.
// ===========================================================================
test("FINDING 3 — anonymous POST /api/partner-otp {action:request} is rejected at the gateway BEFORE the route runs", async () => {
  const { db } = freshDb();
  const access = await driveGateway(post("/api/partner-otp", null, { action: "request", phone: "+919812345678" }), db);
  assert.ok(access instanceof Response, "expected a gateway refusal for the anonymous OTP request");
  // No identity + non-public route + PAWSPACE_UAT_LOGIN unset -> 401 "Authentication required".
  assert.equal(access.status, 401, "anonymous partner-otp is rejected before the route");
  assert.equal((await bodyOf(access))?.error, "Authentication required");

  // Prove WHY: partner-otp resolves to the dashboard.view default (not public), so it needs identity.
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const resolved = await authorizeApiRequest(new Request("http://localhost/api/partner-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request" }) }), { DB: db });
  assert.ok(!(resolved instanceof Response));
  assert.equal(resolved.permission, "dashboard.view", "partner-otp is unmapped -> dashboard.view default (lib/api-gateway.ts:136)");
});

test("FINDING 3 — contrast: /api/customer-otp IS public, so the same anonymous request is allowed through the gateway", async () => {
  const { db } = freshDb();
  const access = await driveGateway(post("/api/customer-otp", null, { action: "request", phone: "+919812345678" }), db);
  assert.ok(!(access instanceof Response), "customer-otp is in the public null list -> gateway lets it through");
  assert.equal(access.permission, null, "customer-otp resolves to null (public) at the main gateway (lib/api-gateway.ts:14-15)");

  // And the mapping proof, method-independent: requiredPermission returns null for customer-otp, dashboard.view for partner-otp.
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const cust = await authorizeApiRequest(new Request("http://localhost/api/customer-otp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { DB: db });
  assert.equal(cust.permission, null, "customer-otp is public");
});

// ===========================================================================
// FINDING 4 (P1): /api/provider-availability resolves the actor and enforces that
// the provider owns its own providerId, but has NO provider-session mapping in
// lib/session-api-gateway.ts, so it falls to the dashboard.view default. The
// service_provider role lacks dashboard.view (lib/platform-security.ts:25) -> an
// authenticated provider cannot toggle their OWN availability.
// ===========================================================================
test("FINDING 4 — provider session is DENIED at the gateway for POST /api/provider-availability", async () => {
  const { db } = freshDb();
  const cookie = await providerCookie(db, "groom_arun", "+919900000003");
  const access = await driveGateway(post("/api/provider-availability", cookie, { providerId: "groom_arun", available: false, reason: "Taking the evening off" }), db);
  assert.ok(access instanceof Response, "expected a gateway Response refusal");
  assert.equal(access.status, 403, "provider is refused at the gateway");
  assert.equal((await bodyOf(access))?.error, "Permission denied");

  // Prove WHY: unmapped -> dashboard.view default, and service_provider lacks dashboard.view.
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const resolved = await authorizeApiRequest(new Request("http://localhost/api/provider-availability", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { DB: db });
  assert.equal(resolved.permission, "dashboard.view", "provider-availability falls to dashboard.view default (lib/api-gateway.ts:136)");

  const { defaultRoles } = await import("../lib/platform-security.ts");
  const provider = defaultRoles.find((r) => r.code === "service_provider");
  assert.ok(!provider.permissions.includes("dashboard.view"), "service_provider does NOT hold dashboard.view (platform-security.ts:25) — that is the deny");
});

test("FINDING 4 — but the route ITSELF would allow the owning provider (deny is purely the gateway mapping)", async () => {
  const { db } = freshDb();
  const { POST } = await import("../app/api/provider-availability/route.ts");
  const cookie = await providerCookie(db, "groom_arun", "+919900000003");
  // Driving the route directly (bypassing the gateway) the provider owns groom_arun -> 200 with a real toggle.
  const res = await POST(post("/api/provider-availability", cookie, { providerId: "groom_arun", available: false, reason: "Taking the evening off" }));
  assert.equal(res.status, 200, `the route's own requireProviderOwnership allows the owner, got HTTP ${res.status}`);
  const body = await res.clone().json();
  assert.equal(body?.data?.providerId, "groom_arun");
  assert.equal(body?.data?.available, false, "the route really performs the availability toggle for its owner");
});
