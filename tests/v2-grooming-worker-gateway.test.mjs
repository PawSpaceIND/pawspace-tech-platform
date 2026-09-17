import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__V2_GATEWAY_DB__", "__V2_GATEWAY_ENV__");
const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
const { requestForAuthorization } = await import("../lib/trusted-workspace-identity.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
const catalogue = await import("../app/api/v2/grooming-catalogue/route.ts");
const checkout = await import("../app/api/v2/grooming-checkout/route.ts");
const returns = await import("../app/api/v2/grooming-checkout-return/route.ts");
const ORIGIN = "https://pawspace-gateway-test.workers.dev";
const CATALOGUE = "/api/v2/grooming-catalogue";
const CHECKOUT = "/api/v2/grooming-checkout";
const RETURN = "/api/v2/grooming-checkout-return";

async function world(t) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db = d1(sqlite);
  const env = { DB: db, PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_PAYMENT_ENV: "sandbox",
    FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
  globalThis.__V2_GATEWAY_DB__ = db; globalThis.__V2_GATEWAY_ENV__ = env;
  await ensureSecurityTables(db); await ensurePricingControlRuntime(db);
  sqlite.exec(`UPDATE service_packages SET active=1 WHERE package_code='dog-basic';
    CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,service_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,total_amount REAL,currency TEXT,pet_ids_json TEXT);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,status TEXT,amount REAL,amount_due_now REAL,currency TEXT,mode TEXT);
    CREATE TABLE provider_work_orders(id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,status TEXT);
    CREATE TABLE canonical_pets(id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT);
    CREATE TABLE booking_service_locations(booking_id TEXT,customer_id TEXT,provider_id TEXT,latitude REAL,longitude REAL,status TEXT,source TEXT);
    INSERT INTO canonical_bookings VALUES('B1','C1','payment_pending','grooming','Bath & Basic','PRV1','2026-10-01T05:30:00.000Z','2026-10-01T07:30:00.000Z',1899,'INR','["PET-1"]');
    INSERT INTO booking_payments VALUES('P1','B1','C1','created',1899,1899,'INR','prepaid');
    INSERT INTO provider_work_orders VALUES('WO1','B1','PRV1','Test care professional','full_time','payment_pending');
    INSERT INTO canonical_pets VALUES('PET-1','C1','Gateway test pet','dog','Labrador');
    INSERT INTO booking_service_locations VALUES('B1','C1','PRV1',12.91,77.64,'active','server_geocode');`);
  const sessions = {};
  for (const [name, subjectType, subjectId] of [["owner", "customer", "C1"], ["other", "customer", "C2"], ["provider", "provider", "PRV1"]]) {
    const identitySource = subjectType === "customer" ? "customer_otp" : "partner_otp";
    const binding = await upsertIdentityBinding(db, { identitySource, principalType: "identity_subject", principalKey: `${subjectType}:${subjectId}`,
      subjectType, subjectId, verificationState: "verified", actorId: "fixture", reason: "V2 gateway regression" });
    const issued = await issuePlatformSession(db, { bindingId: binding.id, identitySource, principalType: "identity_subject",
      principalKey: binding.principal_key, subjectType, subjectId });
    sessions[name] = { id: issued.session.id, cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` };
  }
  return { sqlite, db, env, sessions };
}
function req(path, cookie = "", method = "GET", body, headers = {}) {
  return new Request(ORIGIN + path, { method, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body }) });
}
// Execute the same trusted-ingress -> subject-session -> fallback-RBAC composition used by
// worker/index.ts, then invoke the real handler with the untouched original request. No route mocks.
async function gate(w, request) {
  const inspection = requestForAuthorization(request, w.env);
  const session = await authorizePlatformSessionRequest(inspection, w.db);
  if (session instanceof Response) return session;
  return session ?? await authorizeApiRequest(inspection, w.env);
}
async function dispatch(w, request) {
  return runWithWorkersDb(w.db, async () => {
    const access = await gate(w, request);
    if (access instanceof Response) return { reachedRoute: false, response: access };
    const path = new URL(request.url).pathname;
    const route = path === CATALOGUE ? catalogue : path === CHECKOUT ? checkout : path === RETURN ? returns : null;
    assert.ok(route?.[request.method], "test must dispatch to an actual implemented handler");
    return { reachedRoute: true, response: await route[request.method](request) };
  });
}
function bookingSnapshot(sqlite) {
  return ["canonical_bookings", "booking_payments", "provider_work_orders"].map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

for (const path of [CATALOGUE, CHECKOUT + "?bookingId=B1"]) {
  test(`V2 owner GET reaches real handler through edge authorization: ${path}`, async t => {
    const w = await world(t), before = bookingSnapshot(w.sqlite);
    const result = await dispatch(w, req(path, w.sessions.owner.cookie));
    assert.equal(result.reachedRoute, true, `authenticated V2 GET blocked: ${result.response.status}`);
    assert.equal(result.response.status, 200, await result.response.clone().text());
    const body = await result.response.json();
    if (path === CATALOGUE) assert.equal(body.data.packages[0].code, "dog-basic");
    else { assert.equal(body.data.customerId, "C1"); assert.equal(body.data.locationReady, true); assert.equal(body.data.confirmation.ready, false); }
    assert.deepEqual(bookingSnapshot(w.sqlite), before, "a read must never create booking, payment or work-order state");
  });
  test(`V2 read remains protected from anonymous and provider callers: ${path}`, async t => {
    const w = await world(t);
    for (const [cookie, status] of [["", 401], [w.sessions.provider.cookie, 403]]) {
      const result = await dispatch(w, req(path, cookie));
      assert.equal(result.reachedRoute, false); assert.equal(result.response.status, status);
    }
  });
  test(`V2 fallback gateway also maps only the intended GET permission: ${path}`, async t => {
    const w = await world(t), access = await authorizeApiRequest(req(path, w.sessions.owner.cookie), w.env);
    assert.ok(!(access instanceof Response), "fallback RBAC must not require staff dashboard permission");
    assert.equal(access.permission, "scheduling.book"); assert.equal(access.actor.roleCode, "customer");
  });
}

test("V2 checkout gateway authenticates first; handler still rejects another customer's booking", async t => {
  const w = await world(t), before = bookingSnapshot(w.sqlite);
  const result = await dispatch(w, req(CHECKOUT + "?bookingId=B1&customerId=C1", w.sessions.other.cookie));
  assert.equal(result.reachedRoute, true); assert.equal(result.response.status, 404);
  assert.deepEqual(bookingSnapshot(w.sqlite), before);
});
test("V2 checkout rejects invalid references after authenticating the real owner", async t => {
  const w = await world(t);
  const result = await dispatch(w, req(CHECKOUT + "?bookingId=%2Fetc%2Fpasswd", w.sessions.owner.cookie));
  assert.equal(result.reachedRoute, true); assert.equal(result.response.status, 400);
});
for (const invalidation of ["status='revoked'", "expires_at=0"]) {
  test(`V2 gate rejects invalid sessions: ${invalidation}`, async t => {
    const w = await world(t);
    w.sqlite.prepare(`UPDATE platform_identity_sessions SET ${invalidation} WHERE id=?`).run(w.sessions.owner.id);
    for (const path of [CATALOGUE, CHECKOUT + "?bookingId=B1"]) {
      const result = await dispatch(w, req(path, w.sessions.owner.cookie));
      assert.equal(result.reachedRoute, false); assert.equal(result.response.status, 401);
    }
  });
}
test("V2 gateway does not trust spoofed workspace headers on workers.dev", async t => {
  const w = await world(t);
  const access = await gate(w, req(CATALOGUE, "", "GET", undefined, { "oai-authenticated-user-email": "founder@pawspace.test", "x-pawspace-role": "admin" }));
  assert.ok(access instanceof Response); assert.equal(access.status, 401);
});

for (const method of ["GET", "POST"]) {
  test(`Razorpay V2 ${method} return reaches stateless parser without a PawSpace cookie`, async t => {
    const w = await world(t), before = bookingSnapshot(w.sqlite);
    const body = method === "POST" ? new URLSearchParams({ razorpay_order_id: "order_fixture", razorpay_payment_id: "pay_fixture", razorpay_signature: "a".repeat(64) }) : undefined;
    const result = await dispatch(w, req(RETURN + "?bookingId=B1&next=https://evil.test", "", method, body,
      { origin: "https://api.razorpay.com", "content-type": "application/x-www-form-urlencoded" }));
    assert.equal(result.reachedRoute, true, "external receipt cannot supply a PawSpace session");
    assert.equal(result.response.status, 303);
    const target = new URL(result.response.headers.get("location"));
    assert.equal(target.origin, ORIGIN); assert.equal(target.pathname, "/v2/grooming");
    assert.equal(target.searchParams.get("bookingId"), "B1"); assert.equal(target.searchParams.has("next"), false);
    assert.equal(target.searchParams.get("payment"), method === "POST" ? "returned" : null);
    assert.equal(result.response.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(bookingSnapshot(w.sqlite), before, "receipt redirects must not assert capture or change money");
  });
}
test("oversized and malformed V2 callbacks remain harmless redirects, not confirmed payments", { timeout: 3000 }, async t => {
  const w = await world(t), before = bookingSnapshot(w.sqlite);
  for (const body of ["razorpay_signature=forged", "padding=" + "x".repeat(17000)]) {
    const result = await dispatch(w, req(RETURN + "?bookingId=B1", "", "POST", body, { origin: "https://api.razorpay.com", "content-type": "application/x-www-form-urlencoded" }));
    assert.equal(result.response.status, 303);
    const target = new URL(result.response.headers.get("location"));
    assert.equal(target.searchParams.has("signature"), false); assert.equal(target.searchParams.has("payment"), false);
  }
  assert.deepEqual(bookingSnapshot(w.sqlite), before);
});
for (const [path, method] of [[CATALOGUE, "POST"], [CHECKOUT, "POST"], [RETURN, "PUT"], ["/api/v2/grooming-catalogue-export", "GET"], ["/api/v2/grooming-checkout-return/extra", "GET"], ["/api/v2/admin", "GET"]]) {
  test(`unmapped V2 path or method remains forbidden: ${method} ${path}`, async t => {
    const w = await world(t);
    const access = await gate(w, req(path, w.sessions.owner.cookie, method));
    assert.ok(access instanceof Response); assert.equal(access.status, 403);
  });
}
test("existing V1 customer checkout authorization and cross-origin write protections are unchanged", async t => {
  const w = await world(t);
  const own = await gate(w, req("/api/customer-checkout", w.sessions.owner.cookie, "POST", JSON.stringify({ action: "status", bookingId: "B1" }), { origin: ORIGIN, "content-type": "application/json" }));
  assert.ok(!(own instanceof Response)); assert.equal(own.permission, "scheduling.book");
  const cross = await gate(w, req("/api/customer-checkout", w.sessions.owner.cookie, "POST", "{}", { origin: "https://evil.test", "content-type": "application/json" }));
  assert.ok(cross instanceof Response); assert.equal(cross.status, 403);
  const oldReturn = await gate(w, req("/api/razorpay-checkout-return", "", "POST", "", { origin: "https://api.razorpay.com" }));
  assert.ok(!(oldReturn instanceof Response)); assert.equal(oldReturn.permission, null);
});

test("V1 oversized callback also returns while the edge inspection clone is retained", { timeout: 3000 }, async t => {
  const w = await world(t), before = bookingSnapshot(w.sqlite);
  const request = req("/api/razorpay-checkout-return?bookingId=B1", "", "POST", "padding=" + "x".repeat(17000),
    { origin: "https://api.razorpay.com", "content-type": "application/x-www-form-urlencoded" });
  const inspection = requestForAuthorization(request, w.env);
  const access = await authorizeApiRequest(inspection, w.env);
  assert.ok(!(access instanceof Response));
  const route = await import("../app/api/razorpay-checkout-return/route.ts");
  const response = await route.POST(request);
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.pathname, "/mobile-app/booking-confirmation");
  assert.equal(target.searchParams.has("payment"), false);
  assert.deepEqual(bookingSnapshot(w.sqlite), before);
  assert.equal(inspection.bodyUsed, false, "the retained clone need not consume attacker-supplied bytes to release the redirect");
});

for (const policy of [undefined, "unsafe-url", "no-referrer"]) {
  test(`edge response wrapper retains strict receipt policy and secures fallback: ${policy}`, async () => {
    const { secureApiResponse } = await import("../lib/api-security-headers.ts");
    const response = secureApiResponse(new Response(null, { status: 303,
      headers: { location: "https://pawspace.test/v2/grooming", ...(policy ? { "referrer-policy": policy } : {}) } }));
    assert.equal(response.headers.get("referrer-policy"), policy === "no-referrer" ? "no-referrer" : "same-origin");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
}
