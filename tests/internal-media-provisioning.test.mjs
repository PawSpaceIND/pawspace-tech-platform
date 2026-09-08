import test from "node:test";
import assert from "node:assert/strict";
import { provisionInternalMedia, INTERNAL_BUCKET } from "../scripts/provision-internal-media.mjs";
const env = { APP_ENV: "staging", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "test-only-not-a-credential" };
function world({ exists = false, managed = false, domains = [], denied = false } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (denied) return new Response("denied", { status: 403 });
    if (url.endsWith("/domains/managed")) return Response.json({ success: true, result: { enabled: managed } });
    if (url.endsWith("/domains/custom")) return Response.json({ success: true, result: { domains } });
    if (options.method === "GET" && !exists) return new Response("missing", { status: 404 });
    return Response.json({ success: true, result: { name: INTERNAL_BUCKET } });
  } };
}
test("internal provisioning creates only the dedicated bucket and verifies private access", async () => {
  const state = world();
  assert.deepEqual(await provisionInternalMedia({ env, ...state }), { bucketName: INTERNAL_BUCKET, created: true, private: true });
  assert.equal(state.calls.filter(call => call.method === "POST").length, 1);
  assert.deepEqual(JSON.parse(state.calls.find(call => call.method === "POST").body), { name: INTERNAL_BUCKET });
  assert.ok(state.calls.every(call => call.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`)));
  assert.ok(state.calls.every(call => ["GET", "POST"].includes(call.method)));
  const existing = world({ exists: true });
  assert.equal((await provisionInternalMedia({ env, ...existing })).created, false);
  assert.ok(existing.calls.every(call => call.method === "GET"));
});
test("internal provisioning refuses unsafe locks, public access and denied credentials", async () => {
  for (const key of ["APP_ENV", "FORBID_PRODUCTION", "PAWSPACE_PAYMENT_ENV", "PAWSPACE_PAYMENT_LIVE_APPROVED"]) {
    const state = world();
    await assert.rejects(provisionInternalMedia({ env: { ...env, [key]: "unsafe" }, ...state }));
    assert.equal(state.calls.length, 0);
  }
  for (const options of [{ managed: true }, { domains: [{ domain: "media.example.test" }] }, { denied: true }]) await assert.rejects(provisionInternalMedia({ env, ...world(options) }));
});
