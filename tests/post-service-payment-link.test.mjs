import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__POST_SERVICE_DB__", "__POST_SERVICE_ENV__");

const client = await import("../lib/razorpay-client.ts");
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

const input = { bookingId: "BK-900", paymentId: "PAY-900", customerId: "CUS-900", amount: 1149, currency: "INR" };
const env = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_KEY_ID_SANDBOX: "rzp_test_lane3", RAZORPAY_KEY_SECRET_SANDBOX: "sandbox-secret" };

test("post-service collection refuses missing credentials and every live environment", async () => {
  assert.equal((await client.createSandboxPaymentLink({}, input)).connected, false);
  const live = await client.createSandboxPaymentLink({ PAWSPACE_PAYMENT_ENV: "live", RAZORPAY_KEY_ID: "rzp_live_never_used", RAZORPAY_KEY_SECRET: "never-used" }, input);
  assert.deepEqual(live, { connected: false, environment: "live", reason: "Post-service payment links are locked to Razorpay sandbox" });
});

test("post-service collection creates a bound, non-partial Razorpay sandbox link", async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ id: "plink_lane3_900", short_url: "https://rzp.io/i/lane3900", expire_by: request.body.expire_by, status: "created" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const before = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, true);
  assert.equal(request.url, "https://api.razorpay.com/v1/payment_links");
  assert.equal(request.body.amount, 114900);
  assert.equal(request.body.accept_partial, false);
  assert.ok(request.body.expire_by >= before && request.body.expire_by <= before + 1, "the provider receives the recorded 24-hour Unix expiry");
  assert.equal(result.paymentLink.expire_by, request.body.expire_by);
  assert.deepEqual(request.body.notes, { booking_id: "BK-900", payment_id: "PAY-900", customer_id: "CUS-900", pawspace_environment: "sandbox" });
  assert.match(request.init.headers.authorization, /^Basic /);
});

for (const status of [400, 429, 500, 503]) test(`post-service collection preserves Razorpay ${status} as not connected`, async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { description: `provider-${status}` } }), { status, headers: { "content-type": "application/json" } });
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, false);
  assert.match(result.reason, new RegExp(String(status)));
});

test("post-service collection preserves network failure as not connected", async () => {
  globalThis.fetch = async () => { throw new TypeError("network unavailable"); };
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, false);
  assert.match(result.reason, /network unavailable/);
});

function makeD1(sqlite) {
  function statement(sql, args) { return { bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...args) ?? null, run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; }, all: async () => ({ results: sqlite.prepare(sql).all(...args) }) }; }
  return { prepare: sql => statement(sql, []), batch: async list => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async sql => sqlite.exec(sql) };
}

test("post-service expiry is provider-bound, persisted, and an expired request cannot remain collectable", async () => {
  const sqlite = new DatabaseSync(":memory:"), db = makeD1(sqlite);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,status TEXT,provider_id TEXT,customer_id TEXT); CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,currency TEXT,status TEXT,mode TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-EXPIRY','completed','PRO-1','CUS-1')").run();
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-EXPIRY','BK-EXPIRY',1149,'INR','pending','pay_after_service')").run();
  let providerExpiry;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)); providerExpiry = body.expire_by;
    return new Response(JSON.stringify({ id: "plink_contract_test_expiry", short_url: "https://contract-test.invalid/expiry", expire_by: body.expire_by }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { createPostServicePaymentRequest, getPostServicePaymentRequest } = await import("../lib/grooming-payment-reconciliation.ts");
  const created = await createPostServicePaymentRequest(db, env, { bookingId: "BK-EXPIRY", providerId: "PRO-1", actorId: "provider-test" });
  assert.equal(created.expiresAt, providerExpiry * 1000, "D1 expiry is provider truth converted from seconds to milliseconds");
  assert.equal(created.collectable, true);
  sqlite.prepare("UPDATE post_service_payment_requests SET expires_at=? WHERE booking_id='BK-EXPIRY'").run(Date.now() - 1);
  const expired = await getPostServicePaymentRequest(db, { bookingId: "BK-EXPIRY", providerId: "PRO-1" });
  assert.equal(expired.collectable, false, "an expired HTTPS URL must not remain collectable");
  const partnerUi = await readFile(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  assert.match(partnerUi, /paymentRequest\.collectable \? <>/);
  sqlite.close();
});
