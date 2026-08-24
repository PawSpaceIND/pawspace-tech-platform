import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__T1_PAYMENT_LINK_DB__", "__T1_PAYMENT_LINK_ENV__");

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
    return new Response(JSON.stringify({ id: "plink_lane3_900", short_url: "https://rzp.io/i/lane3900", status: "created", expire_by: request.body.expire_by }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, true);
  assert.equal(request.url, "https://api.razorpay.com/v1/payment_links");
  assert.equal(request.body.amount, 114900);
  assert.equal(request.body.accept_partial, false);
  assert.ok(request.body.expire_by > Math.floor(Date.now() / 1000));
  assert.ok(request.body.expire_by <= Math.floor(Date.now() / 1000) + 24 * 60 * 60);
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
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; } };
}

test("post-service link persists provider expiry and canonical capture/refund mapping", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__T1_PAYMENT_LINK_DB__ = db;
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await reconciliation.ensurePaymentReconciliationTables(db);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,status TEXT NOT NULL,provider_id TEXT NOT NULL,customer_id TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL,method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?)").run("BK-900", "completed", "PRO-900", "CUS-900");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,currency,method,mode,status,detail_json,updated_at) VALUES (?,?,?,?,?,'payment_link','pay_after_service','created','{}',?)").run("PAY-900", "BK-900", "CUS-900", 1149, "INR", now);

  let providerExpiry = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    providerExpiry = body.expire_by;
    return new Response(JSON.stringify({ id: "plink_lane3_900", short_url: "https://rzp.io/i/lane3900", status: "created", expire_by: providerExpiry }), { status: 200 });
  };
  const request = await reconciliation.createPostServicePaymentRequest(db, env, { bookingId: "BK-900", providerId: "PRO-900", actorId: "provider:PRO-900" });
  assert.equal(request.expiresAt, providerExpiry * 1000, "D1 stores the provider-confirmed expiry in milliseconds");
  assert.equal(sqlite.prepare("SELECT expires_at FROM post_service_payment_requests WHERE booking_id='BK-900'").get().expires_at, providerExpiry * 1000);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT booking_id,payment_id,gateway_order_id FROM payment_gateway_links WHERE booking_id='BK-900'").get() },
    { booking_id: "BK-900", payment_id: "PAY-900", gateway_order_id: "plink_lane3_900" },
  );

  sqlite.prepare("UPDATE post_service_payment_requests SET expires_at=? WHERE booking_id='BK-900'").run(Date.now() - 1);
  assert.equal((await reconciliation.getPostServicePaymentRequest(db, { bookingId: "BK-900", providerId: "PRO-900" })).collectable, false, "expired links fail closed");
  sqlite.prepare("UPDATE post_service_payment_requests SET expires_at=? WHERE booking_id='BK-900'").run(Date.now() + 60_000);

  const captured = await reconciliation.processGatewayEvent(db, { provider: "razorpay", environment: "sandbox", eventId: "evt-link-capture", eventType: "payment.captured", bookingId: "BK-900", gatewayOrderId: "order_from_link", gatewayPaymentId: "pay_from_link", amountSubunits: 114900, currency: "INR", signatureVerified: true, payloadHash: "hash-capture" });
  assert.equal(captured.status, "processed");
  assert.equal(sqlite.prepare("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id='BK-900'").get().gateway_payment_id, "pay_from_link");
  assert.equal((await reconciliation.getPostServicePaymentRequest(db, { bookingId: "BK-900", providerId: "PRO-900" })).collectable, false, "captured links stop collecting even before the screen reloads its jobs");

  sqlite.prepare("INSERT INTO booking_refund_cases VALUES (?,?,?,?,?,'approved','customer','finance',NULL,?,?)").run("RF-900", "BK-900", "PAY-900", 1149, "approved cancellation", now, now);
  const refunded = await reconciliation.processGatewayEvent(db, { provider: "razorpay", environment: "sandbox", eventId: "evt-link-refund", eventType: "refund.processed", gatewayPaymentId: "pay_from_link", gatewayRefundId: "rfnd_from_link", amountSubunits: 114900, currency: "INR", signatureVerified: true, payloadHash: "hash-refund" });
  assert.equal(refunded.status, "processed");
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id='RF-900'").get().status, "processed", "the link-origin capture reaches the governed refund path by canonical mapping");

  const partner = fs.readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  assert.match(partner, /setInterval[\s\S]*grooming-payment-sandbox/, "pending link state is refreshed while the screen remains open");
  assert.match(partner, /paymentRequest\.collectable\s*\?/, "the checkout is rendered only while the server says it is collectable");
});
