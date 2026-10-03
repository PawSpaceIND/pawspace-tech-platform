import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

test("TEST coin route passes real customer session gateway and denies providers, cross-origin writes and missing sessions", async t => {
  const ctx = await setupJourney(); t.after(ctx.close);
  Object.assign(globalThis.__GROOM_GOLDEN_ENV__, { PAWSPACE_TEST_COINS: "on", FORBID_PRODUCTION: "true", APP_ENV: "test", PAWSPACE_TEST_COINS_EXPIRY_SECONDS: 3600 });
  const { ensureCanonicalBookingCoreTables } = await import("../lib/canonical-booking-core-schema.ts");
  await ensureCanonicalBookingCoreTables(ctx.db);
  const { GET, POST } = await import("../app/api/v2/test-coins/route.ts");
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { requiredPermission } = await import("../lib/api-gateway.ts");
  const customer = await sessionCookie(ctx.db, "customer", "coin-owner", "customer:coin-owner");
  const provider = await sessionCookie(ctx.db, "provider", "coin-provider", "provider:coin-provider");
  const req = (method = "GET", cookie = customer, body, origin) => new Request("https://uat.pawspace.in/api/v2/test-coins", {
    method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  for (const method of ["GET", "POST"]) {
    const request = req(method, customer, method === "POST" ? { action: "sync" } : undefined);
    assert.equal(await requiredPermission(request), "scheduling.book");
    const gate = await authorizePlatformSessionRequest(request, ctx.db);
    assert.equal(gate.actor.roleCode, "customer");
    const response = await (method === "GET" ? GET(request) : POST(request));
    assert.equal(response.status, 200, await response.clone().text());
    const data = (await response.json()).data; assert.equal(data.balance, 0); assert.match(data.label, /TEST/); assert.equal(data.customerId, "coin-owner"); assert.equal(data.policy.enabled, true); assert.equal(data.grantBalanceAdjustment, 0);
  }
  const deniedProvider = await authorizePlatformSessionRequest(req("GET", provider), ctx.db);
  assert.equal(deniedProvider.status, 403);
  assert.equal((await GET(req("GET", provider))).status, 401);
  assert.ok([401,403].includes((await GET(req("GET", ""))).status));
  assert.equal((await POST(req("POST", customer, { action: "sync" }, "https://attacker.test"))).status, 403);
  assert.equal((await POST(req("POST", customer, { action: "grant", coins: 1000 }))).status, 400);
  assert.equal((await POST(req("POST", customer, { action: "earn", coins: 1000 }))).status, 400);
  assert.equal((await GET(new Request("https://uat.pawspace.in/api/v2/test-coins?source=booking&id=other-owner", { headers: { cookie: customer } }))).status, 404);
  globalThis.__GROOM_GOLDEN_ENV__.APP_ENV = "production";
  assert.equal((await GET(req())).status, 404);
});
