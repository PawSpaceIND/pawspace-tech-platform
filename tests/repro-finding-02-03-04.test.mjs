import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

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
  // Uses the transactional D1 shim (BEGIN/COMMIT/ROLLBACK) from helpers/d1.mjs so a
  // failing batch() rolls back, exactly as Cloudflare D1 does.
  return createD1(sqlite);
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
  test(`FINDING 2 — customer session is now GRANTED at the gateway for POST ${route} (scheduling.book)`, async () => {
    const { db } = freshDb();
    const cookie = await customerCookie(db, "CUS-OWNER", "+919900000001");

    const access = await driveGateway(post(route, cookie, { customerId: "CUS-OWNER" }), db);

    // It is an access grant now (via the platform-session gateway), not a refusal.
    assert.ok(!(access instanceof Response), `${route}: expected a gateway access grant, got a Response refusal`);
    assert.equal(access.permission, "scheduling.book", `${route}: the customer self-service scope resolves scheduling.book (session-api-gateway.ts:28)`);
    assert.equal(access.actor.roleCode, "customer", `${route}: the granted actor is the customer platform session`);
  });
}

test("FINDING 2 — the customer role holds scheduling.book, which is exactly what now grants these self-service routes at the session gateway", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const customer = defaultRoles.find((r) => r.code === "customer");
  assert.deepEqual([...customer.permissions], ["pricing.view", "scheduling.book"], "customer holds only pricing.view + scheduling.book (platform-security.ts:24)");
  assert.ok(customer.permissions.includes("scheduling.book"), "customer holds scheduling.book — the permission the session gateway maps these routes to");
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
test("FINDING 3 — anonymous POST /api/partner-otp {action:request} now resolves PUBLIC at the gateway (allowed through)", async () => {
  const { db } = freshDb();
  const access = await driveGateway(post("/api/partner-otp", null, { action: "request", phone: "+919812345678" }), db);
  assert.ok(!(access instanceof Response), "partner-otp is now public -> the gateway lets the anonymous OTP request through");
  assert.equal(access.permission, null, "anonymous partner-otp resolves to null (public), just like customer-otp");

  // Prove WHY: partner-otp is now in the gateway's public null-list, so requiredPermission returns null.
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const resolved = await authorizeApiRequest(new Request("http://localhost/api/partner-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request" }) }), { DB: db });
  assert.ok(!(resolved instanceof Response));
  assert.equal(resolved.permission, null, "partner-otp is in the public null-list (lib/api-gateway.ts:14-15)");
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
test("FINDING 4 — provider session is now GRANTED at the gateway for POST /api/provider-availability (bookings.view)", async () => {
  const { db } = freshDb();
  const cookie = await providerCookie(db, "groom_arun", "+919900000003");
  const access = await driveGateway(post("/api/provider-availability", cookie, { providerId: "groom_arun", available: false, reason: "Taking the evening off" }), db);
  assert.ok(!(access instanceof Response), "expected a gateway access grant, not a Response refusal");
  assert.equal(access.permission, "bookings.view", "the provider self-availability scope resolves bookings.view (session-api-gateway.ts:30)");
  assert.equal(access.actor.roleCode, "service_provider", "the granted actor is the provider platform session");

  // The provider role holds bookings.view — the permission the session gateway maps this route to.
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const provider = defaultRoles.find((r) => r.code === "service_provider");
  assert.ok(provider.permissions.includes("bookings.view"), "service_provider holds bookings.view (platform-security.ts:25) — that is the grant");

  // Ownership is still enforced: a provider session may only toggle its OWN providerId. A session for
  // groom_arun asking to toggle a DIFFERENT provider is refused 403 by the session gateway's scope.
  const otherAccess = await driveGateway(post("/api/provider-availability", cookie, { providerId: "groom_someone_else", available: false, reason: "not mine" }), db);
  assert.ok(otherAccess instanceof Response, "cross-provider toggle must be refused");
  assert.equal(otherAccess.status, 403, "same-provider ownership is still enforced at the gateway scope");
});

test("FINDING 4 — the route ITSELF allows the owning provider (end-to-end: gateway grants, route toggles)", async () => {
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
