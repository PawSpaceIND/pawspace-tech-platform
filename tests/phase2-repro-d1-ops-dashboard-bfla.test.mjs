import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// =============================================================================
// PHASE 2 REPRODUCTION — D1 (P2, borderline P1): ops-dashboard GET snapshots are
// gated on `bookings.view` (a provider-held permission) instead of the `bookings.manage`
// their own POSTs require. The fixer raised canonical-bookings + booking-command-center to
// bookings.manage but left these nine siblings behind, so any provider platform session
// (incl. an external customer-app provider) reads org-wide, all-customer operational data.
//
// Faithful path: worker/index.ts composes authorizePlatformSessionRequest ?? authorizeApiRequest.
// These routes are NOT in sessionScope, so a provider session falls through to the main gateway, which
// grants because service_provider holds bookings.view (lib/platform-security.ts:25).
// URLs are https://uat.pawspace.in/... so the localhost dev-preview superuser is never engaged.
// Run against the PRE-FIX SHA ca09d06.
// =============================================================================
installWorkersHooks("__D1_DB__", "__D1_ENV__");

function makeD1(sqlite) {
  const s = (sql, args) => ({
    bind: (...b) => s(sql, b),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => s(sql, []), batch: async (l) => { const o = []; for (const it of l) o.push(await it.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  // The main gateway audits denied session actors; that table is not created on the session path.
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  globalThis.__D1_DB__ = db;
  globalThis.__D1_ENV__ = {}; // no PAWSPACE_UAT_LOGIN
  return { sqlite, db };
}

/** worker/index.ts:47-49 compose order. Returns a Response on refusal, else the {actor,permission} grant. */
async function driveGateway(request, db) {
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, db);
  if (sessionAccess instanceof Response) return sessionAccess;
  return sessionAccess ?? await authorizeApiRequest(request, { DB: db });
}
async function providerCookie(db, providerId, principalKey) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, { identitySource: "customer_app", principalType: "phone", principalKey, subjectType: "provider", subjectId: providerId, verificationState: "verified", actorId: "test", reason: "D1 provider session" });
  const issued = await issuePlatformSession(db, { bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone", principalKey: String(binding.principal_key), subjectType: "provider", subjectId: providerId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
async function customerCookie(db, customerId, principalKey) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, { identitySource: "customer_app", principalType: "phone", principalKey, subjectType: "customer", subjectId: customerId, verificationState: "verified", actorId: "test", reason: "D1 customer session" });
  const issued = await issuePlatformSession(db, { bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone", principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
const get = (path, cookie) => new Request(`https://uat.pawspace.in${path}`, { method: "GET", headers: cookie ? { cookie } : {} });
const bodyOf = async (res) => { try { return await res.clone().json(); } catch { return null; } };

// The nine ops-dashboard GET routes still gated on bookings.view (finding D1). POST column records the
// permission the WRITE side requires — the intended bar the GET should match after remediation.
const OPS = [
  { route: "/api/ops-work-queue", post: "bookings.manage" },
  { route: "/api/walking-ops", post: "bookings.manage" },
  { route: "/api/taxi-ops", post: "bookings.manage" },
  { route: "/api/food-ops", post: "bookings.manage" },
  { route: "/api/sitting-ops", post: "bookings.manage" },
  { route: "/api/boarding-ops", post: "bookings.manage" },
  { route: "/api/food-supply-chain", post: "bookings.manage" },
  { route: "/api/training-ops", post: "bookings.view" }, // gateway maps ALL methods to bookings.view (no split) — writes are exposed too
  { route: "/api/unified-cases", post: "bookings.manage" },
];

// ---- REPRODUCED: a provider session is GRANTED each ops GET (one test per route) ----
for (const { route } of OPS) {
  test(`D1 REPRODUCED — provider session is GRANTED ${route} GET (bookings.view)`, async () => {
    const { db } = freshDb();
    const cookie = await providerCookie(db, "PRV-OUTSIDER", "+919911100001");
    const access = await driveGateway(get(route, cookie), db);
    assert.ok(!(access instanceof Response), `${route}: expected a GRANT for a provider session, got a ${access instanceof Response ? access.status : "?"} refusal`);
    assert.equal(access.permission, "bookings.view", `${route}: granted on bookings.view (a provider-held permission)`);
  });
}

// ---- SECURE INVARIANT (post-fix gate): a provider must be DENIED all nine ops GETs ----
test("D1 SECURE INVARIANT (post-fix gate) — a provider session must be DENIED all nine ops-dashboard GETs", async () => {
  const violations = [];
  for (const { route } of OPS) {
    const { db } = freshDb();
    const cookie = await providerCookie(db, "PRV-OUTSIDER", "+919911100001");
    const access = await driveGateway(get(route, cookie), db);
    const denied = access instanceof Response && access.status === 403;
    if (!denied) violations.push(route);
  }
  // Expected after remediation (GET raised to bookings.manage, which providers lack): zero grants.
  // FAILS on ca09d06 with all nine listed — that IS the reproduction.
  assert.deepEqual(violations, [], `SECURE INVARIANT VIOLATED on ca09d06 — provider is granted these ops GETs: ${violations.join(", ")}`);
});

// ---- Deterministic asymmetry: GET==bookings.view while the WRITE bar is higher ----
for (const { route, post } of OPS) {
  test(`D1 asymmetry — ${route}: gateway GET permission is bookings.view (WRITE requires ${post})`, async () => {
    const { db } = freshDb();
    const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
    // Localhost short-circuits to the preview actor, so we can read the RESOLVED required permission.
    const g = await authorizeApiRequest(new Request(`http://localhost${route}`, { method: "GET" }), { DB: db });
    assert.ok(!(g instanceof Response), `${route}: preview actor should resolve GET`);
    assert.equal(g.permission, "bookings.view", `${route}: GET is gated on bookings.view`);
    if (post === "bookings.manage") {
      const p = await authorizeApiRequest(new Request(`http://localhost${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { DB: db });
      assert.ok(!(p instanceof Response), `${route}: preview actor should resolve POST`);
      assert.equal(p.permission, "bookings.manage", `${route}: WRITE requires bookings.manage — the bar the GET should match`);
    }
  });
}

// ---- Contrast: the grant is specific to the provider's bookings.view (not fail-open) ----
test("D1 contrast — anonymous and customer sessions are REFUSED a representative ops GET (/api/taxi-ops)", async () => {
  const { db } = freshDb();
  const anon = await driveGateway(get("/api/taxi-ops"), db);
  assert.ok(anon instanceof Response && [401, 403].includes(anon.status), `anonymous should be refused; got ${anon instanceof Response ? anon.status : "grant"}`);

  const { db: db2 } = freshDb();
  const cookie = await customerCookie(db2, "CUS-1", "+919922200001");
  const cust = await driveGateway(get("/api/taxi-ops", cookie), db2);
  assert.ok(cust instanceof Response && cust.status === 403, `a customer (no bookings.view) should be 403; got ${cust instanceof Response ? cust.status : "grant"}`);
  assert.equal((await bodyOf(cust))?.error, "Permission denied");
});

test("D1 — service_provider role holds bookings.view but NOT bookings.manage (platform-security.ts:25)", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const sp = defaultRoles.find((r) => r.code === "service_provider");
  assert.ok(sp.permissions.includes("bookings.view"), "service_provider holds bookings.view — reaches the ops GETs");
  assert.ok(!sp.permissions.includes("bookings.manage"), "service_provider lacks bookings.manage — the correct bar for org-wide reads");
});
