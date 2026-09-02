import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";

installWorkersHooks("__POST_SERVICE_LINK_DB__", "__POST_SERVICE_LINK_ENV__");

const client = await import("../lib/razorpay-client.ts");
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

const input = { bookingId: "BK-900", paymentId: "PAY-900", referenceId: "PAY-900-attempt-1", customerId: "CUS-900", amount: 1149, currency: "INR", expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
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
    return new Response(JSON.stringify({ id: "plink_lane3_900", short_url: "https://rzp.io/i/lane3900", status: "created", expire_by: Math.floor(input.expiresAt / 1000) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, true);
  assert.equal(request.url, "https://api.razorpay.com/v1/payment_links");
  assert.equal(request.body.amount, 114900);
  assert.equal(request.body.accept_partial, false);
  assert.equal(request.body.expire_by, Math.floor(input.expiresAt / 1000));
  assert.equal(request.body.reference_id, input.referenceId);
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
  function statement(sql, args = []) { return { bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...args) ?? null, run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; }, all: async () => ({ results: sqlite.prepare(sql).all(...args) }) }; }
  return { prepare: sql => statement(sql), batch: async statements => { sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } };
}

test("legacy payment-link mappings cannot bypass canonical provider-reference uniqueness", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE payment_gateway_links (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,payment_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,environment TEXT NOT NULL,gateway_order_id TEXT,gateway_payment_link_id TEXT,gateway_payment_id TEXT,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); INSERT INTO payment_gateway_links VALUES ('L1','B1','P1','razorpay','sandbox',NULL,'plink_duplicate',NULL,'active',0,0); INSERT INTO payment_gateway_links VALUES ('L2','B2','P2','razorpay','sandbox',NULL,'plink_duplicate',NULL,'active',0,0);");
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await assert.rejects(() => reconciliation.ensurePaymentReconciliationTables(makeD1(sqlite)), /UNIQUE/i, "duplicate legacy provider references must surface instead of leaving ambiguous webhook resolution");
});

test("payment-link expiry, webhook mapping and refund-required payment ID stay canonical", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,status TEXT NOT NULL,provider_id TEXT NOT NULL,customer_id TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL,mode TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL);
    INSERT INTO canonical_bookings VALUES ('BK-LINK','completed','PROVIDER-1','CUS-1');
    INSERT INTO booking_payments VALUES ('PAY-LINK','BK-LINK','CUS-1',1149,'INR','created','pay_after_service','uat_sandbox','{}',0);
  `);
  installFinancialLifecycleSchema(sqlite);
  const db = makeD1(sqlite), reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  const expectedExpirySeconds = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);
  let providerExpirySeconds = 0, linkAttempt = 0;
  const references = new Set();
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    providerExpirySeconds = body.expire_by;
    assert.ok(Math.abs(providerExpirySeconds - expectedExpirySeconds) <= 1);
    assert.ok(body.reference_id.length <= 40);
    if (references.has(body.reference_id)) return new Response(JSON.stringify({ error: { description: "reference_id already exists" } }), { status: 400, headers: { "content-type": "application/json" } });
    references.add(body.reference_id);
    assert.equal(body.notes.payment_id, "PAY-LINK");
    linkAttempt += 1;
    const suffix = linkAttempt === 1 ? "map" : "replacement";
    return new Response(JSON.stringify({ id: `plink_lane3_${suffix}`, short_url: `https://rzp.io/i/lane3${suffix}`, status: "created", expire_by: providerExpirySeconds }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const created = await reconciliation.createPostServicePaymentRequest(db, env, { bookingId: "BK-LINK", providerId: "PROVIDER-1", actorId: "provider@pawspace.test" });
  assert.equal(created.expiresAt, providerExpirySeconds * 1000);
  assert.equal(created.collectable, true);
  const mapped = sqlite.prepare("SELECT gateway_payment_link_id,gateway_payment_id FROM payment_gateway_links WHERE booking_id='BK-LINK'").get();
  assert.deepEqual({ ...mapped }, { gateway_payment_link_id: "plink_lane3_map", gateway_payment_id: null });
  assert.equal(sqlite.prepare("SELECT gateway_status FROM payment_reconciliation_records WHERE payment_id='PAY-LINK'").get().gateway_status, "payment_link_created");

  sqlite.prepare("UPDATE post_service_payment_requests SET expires_at=? WHERE booking_id='BK-LINK'").run(Date.now() - 1);
  const expired = await reconciliation.getPostServicePaymentRequest(db, { bookingId: "BK-LINK", providerId: "PROVIDER-1" });
  assert.equal(expired.status, "expired");
  assert.equal(expired.collectable, false);
  const replacement = await reconciliation.createPostServicePaymentRequest(db, env, { bookingId: "BK-LINK", providerId: "PROVIDER-1", actorId: "provider@pawspace.test" });
  assert.equal(replacement.providerReference, "plink_lane3_replacement");
  assert.equal(references.size, 2, "replacement must use a distinct attempt-specific reference_id");
  assert.equal(replacement.collectable, true);
  assert.equal(sqlite.prepare("SELECT id FROM post_service_payment_requests WHERE booking_id='BK-LINK'").get().id, "plink_lane3_replacement");
  assert.equal(sqlite.prepare("SELECT gateway_payment_link_id FROM payment_gateway_links WHERE booking_id='BK-LINK'").get().gateway_payment_link_id, "plink_lane3_replacement");

  globalThis.__POST_SERVICE_LINK_DB__ = db;
  globalThis.__POST_SERVICE_LINK_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: "lane3-webhook-secret" };
  const webhook = await import("../app/api/razorpay-webhook/route.ts");
  const payload = { event: "payment_link.paid", created_at: Math.floor(Date.now() / 1000), payload: { payment_link: { entity: { id: "plink_lane3_replacement", status: "paid", amount: 114900, amount_paid: 114900, notes: {} } }, payment: { entity: { id: "pay_lane3_map", amount: 114900, currency: "INR" } }, order: { entity: {} } } };
  const raw = JSON.stringify(payload), key = await crypto.subtle.importKey("raw", new TextEncoder().encode("lane3-webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))).map(value => value.toString(16).padStart(2, "0")).join("");
  const webhookResponse = await webhook.POST(new Request("http://localhost/api/razorpay-webhook", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-event-id": "evt_link_capture", "x-razorpay-signature": signature }, body: raw }));
  assert.equal(webhookResponse.status, 200, await webhookResponse.text());
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-LINK'").get().status, "captured");
  assert.equal(sqlite.prepare("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id='BK-LINK'").get().gateway_payment_id, "pay_lane3_map", "the refund endpoint's required gateway payment ID is now reachable from a payment-link capture");
  const paid = await reconciliation.getPostServicePaymentRequest(db, { bookingId: "BK-LINK", providerId: "PROVIDER-1" });
  assert.equal(paid.paymentStatus, "captured");
  assert.equal(paid.collectable, false);
});

test("Partner app polls canonical job and payment state and hides uncollectable checkout links", () => {
  const source = fs.readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /setInterval\(\(\)=>setPaymentPollKey/);
  assert.match(source, /\[identity\?\.subjectId, refreshKey, paymentPollKey\]/);
  assert.match(source, /\[selected\?\.bookingId, refreshKey, paymentPollKey\]/);
  assert.match(source, /paymentRequest\.collectable \? <>/);
});
