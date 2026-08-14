import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Gateway routing for customer/partner self-service flows.
//
// worker/index.ts gates every /api/* request: authorizePlatformSessionRequest (session cookie) runs
// first, else authorizeApiRequest (staff header/UAT). Routes absent from BOTH gateways fall to the
// dashboard.view default, which customer (["pricing.view","scheduling.book"]) and provider
// (["bookings.view",...]) sessions do NOT hold — so those callers were 403'd, and anonymous partner
// login was 401'd, in production. It all worked on localhost only because authorizeApiRequest
// short-circuits localhost to a preview superuser, which is why dev never caught it.
//
// This suite drives the REAL gateway functions with REAL verified sessions (the same identity-binding +
// issued-session path the apps use), on a non-localhost URL.
// ---------------------------------------------------------------------------
installWorkersHooks("__CPFLOW_DB__", "__CPFLOW_ENV__");

const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");

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

async function sessionCookie(db, subjectType, subjectId, principalKey) {
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey,
    subjectType, subjectId, verificationState: "verified", actorId: "test", reason: "flow auth test",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType, subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const CUSTOMER_ROUTES = ["/api/payment-order", "/api/pawspace-wallet", "/api/paw-points", "/api/pet-passport", "/api/pet-vaccination", "/api/pet-emergency", "/api/pet-birthday", "/api/service-review"];

test("public login/share endpoints are reachable without any session (partner-otp, pet-passport-public)", async () => {
  const db = makeD1(new DatabaseSync(":memory:"));
  for (const [path, method] of [["/api/partner-otp", "POST"], ["/api/pet-passport-public", "GET"]]) {
    const req = new Request(`https://uat.pawspace.in${path}`, { method, headers: { origin: "https://uat.pawspace.in" }, ...(method === "POST" ? { body: "{}" } : {}) });
    const result = await authorizeApiRequest(req, { DB: db });
    assert.ok(!(result instanceof Response), `${path}: must be public, got ${result instanceof Response ? result.status : "actor"}`);
    assert.equal(result.permission, null, `${path}: must resolve as public (permission null)`);
    assert.equal(result.actor.roleCode, "public");
  }
});

test("a customer session is granted at the gateway on every customer self-service route", async () => {
  for (const path of CUSTOMER_ROUTES) {
    const db = makeD1(new DatabaseSync(":memory:"));
    const cookie = await sessionCookie(db, "customer", "CUS-1", "+919900000010");
    const req = new Request(`https://uat.pawspace.in${path}`, { method: "POST", headers: { cookie, origin: "https://uat.pawspace.in" }, body: "{}" });
    const result = await authorizePlatformSessionRequest(req, db);
    assert.ok(result && !(result instanceof Response), `${path}: a customer session must be granted, got ${result instanceof Response ? result.status : result}`);
    assert.equal(result.permission, "scheduling.book", `${path}: mapped to the customer's scheduling.book`);
  }
});

test("a provider session is granted on provider-availability and bound to its own providerId", async () => {
  const db = makeD1(new DatabaseSync(":memory:"));
  const cookie = await sessionCookie(db, "provider", "PRV-1", "+919900000020");
  const ok = new Request("https://uat.pawspace.in/api/provider-availability", { method: "POST", headers: { cookie, origin: "https://uat.pawspace.in" }, body: JSON.stringify({ providerId: "PRV-1", available: true, reason: "on shift" }) });
  const granted = await authorizePlatformSessionRequest(ok, db);
  assert.ok(granted && !(granted instanceof Response), "provider must be granted for its own id");
  assert.equal(granted.permission, "bookings.view");
  // And a provider cannot flip a DIFFERENT provider's availability: the scope binds subjectId.
  const spoof = new Request("https://uat.pawspace.in/api/provider-availability", { method: "POST", headers: { cookie, origin: "https://uat.pawspace.in" }, body: JSON.stringify({ providerId: "PRV-OTHER", available: true, reason: "x" }) });
  const refused = await authorizePlatformSessionRequest(spoof, db);
  assert.ok(refused instanceof Response && refused.status === 403, "a provider must not pass the gateway for another provider's id");
});
