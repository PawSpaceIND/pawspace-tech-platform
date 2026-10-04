/*
 * The booking's gateway link must name the first VERIFIED CAPTURED payment - never a failed or authorized-only
 * attempt on the same order.
 *
 * Staging evidence (prepaid booking, one Razorpay TEST order): the first Netbanking attempt failed
 * (payment_cancelled), the same-order retry captured, the signed capture was processed and the ledger balanced -
 * but payment_gateway_links.gateway_payment_id still named the FAILED attempt. processGatewayEvent wrote the first
 * non-null payment id of ANY event before looking at its type, and the capture's COALESCE kept it. The refund
 * paths that read the link (sandbox initiate_refund, Dog Training late-capture refund) would then target a payment
 * that never captured.
 *
 * Everything below runs the real signed webhook route against SQLite with the real finance migrations. Values are
 * synthetic, provider calls are stubbed, nothing reaches Razorpay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";

installWorkersHooks("__LINK_WINNER_DB__", "__LINK_WINNER_ENV__");

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
const WEBHOOK_SECRET = "synthetic-webhook-secret";
const FINANCE = { "oai-authenticated-user-email": "finance.manager@pawspace.test", "oai-authenticated-user-full-name": "Finance%20manager", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" };

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const ORDER = "order_retry_same";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,status TEXT NOT NULL,provider_id TEXT NOT NULL,customer_id TEXT NOT NULL,city_id TEXT NOT NULL DEFAULT 'blr',service_code TEXT NOT NULL DEFAULT 'grooming',total_amount REAL NOT NULL DEFAULT 1241,currency TEXT NOT NULL DEFAULT 'INR',updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,status TEXT NOT NULL,mode TEXT NOT NULL,method TEXT NOT NULL DEFAULT 'upi',gateway TEXT NOT NULL DEFAULT 'uat_sandbox',detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL DEFAULT 'full_time',status TEXT NOT NULL DEFAULT 'payment_pending',updated_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO provider_work_orders (id,booking_id,provider_id) VALUES ('WO-RT','BK-RT','PRV-1'),('WO-OTHER','BK-OTHER','PRV-1');
    CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO canonical_bookings (id,status,provider_id,customer_id) VALUES ('BK-RT','payment_pending','PRV-1','CUS-RT'),('BK-OTHER','payment_pending','PRV-1','CUS-OT');
    INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,status,mode,updated_at) VALUES ('PAY-RT','BK-RT','CUS-RT',1241,1241,'INR','created','prepaid',0),('PAY-OTHER','BK-OTHER','CUS-OT',1241,1241,'INR','created','prepaid',0);
  `);
  installFinancialLifecycleSchema(sqlite);
  const db = makeD1(sqlite);
  globalThis.__LINK_WINNER_DB__ = db;
  globalThis.__LINK_WINNER_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_KEY_ID_SANDBOX: "rzp_test_synthetic", RAZORPAY_KEY_SECRET_SANDBOX: "synthetic-secret", RAZORPAY_WEBHOOK_SECRET_SANDBOX: WEBHOOK_SECRET };
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await reconciliation.ensurePaymentReconciliationTables(db);
  const { ensureFinancialRuntimeTables } = await import("../lib/financial-runtime-schema.ts");
  await ensureFinancialRuntimeTables(db);
  const intent = (id, bookingId, paymentId, orderId, paise, snapshot = "{}") => sqlite.prepare(`INSERT INTO payment_intents (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gateway_order_id,gross_service_value_paise,platform_fee_paise,partner_earning_paise,commission_rate_version,tax_rule_version,commercial_snapshot_json,created_at,updated_at)
    VALUES (?,?,?,?,'razorpay','sandbox',?,?,'INR','CREATED','ORDER_CREATED',?,?,0,0,'test','test',?,0,0)`).run(id, bookingId, bookingId === "BK-RT" ? "CUS-RT" : "CUS-OT", paymentId, `ik-${id}`, paise, orderId, paise, snapshot);
  // The checkout order for each booking: one intent and the booking's gateway link (DB effect of order creation).
  intent("PI-RT", "BK-RT", "PAY-RT", ORDER, 124100);
  intent("PI-OTHER", "BK-OTHER", "PAY-OTHER", "order_other_booking", 124100);
  await reconciliation.linkSandboxGatewayOrder(db, { bookingId: "BK-RT", gatewayOrderId: ORDER, actorId: "checkout" });
  await reconciliation.linkSandboxGatewayOrder(db, { bookingId: "BK-OTHER", gatewayOrderId: "order_other_booking", actorId: "checkout" });
  const linkPayment = () => sqlite.prepare("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id='BK-RT'").get().gateway_payment_id;
  const ledger = () => ({
    journals: sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture' AND status='POSTED'").get().n,
    captured: Number(sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id='PAY-RT'").get()?.captured_amount || 0),
    payment: sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-RT'").get().status,
  });
  return { sqlite, db, intent, linkPayment, ledger, reconciliation };
}

let sequence = 0;
async function signed(event, { paymentId, orderId = ORDER, paise = 124100, status = event === "payment.failed" ? "failed" : event === "payment.authorized" ? "authorized" : "captured", bookingId = "BK-RT", currency = "INR", errorCode } = {}) {
  const webhook = await import("../app/api/razorpay-webhook/route.ts");
  sequence += 1;
  const entity = { id: paymentId, order_id: orderId, amount: paise, currency, status, method: "netbanking", captured: status === "captured", notes: { booking_id: bookingId }, ...(errorCode ? { error_code: "BAD_REQUEST_ERROR", error_reason: errorCode, error_source: "customer", error_step: "payment_authentication" } : {}) };
  const raw = JSON.stringify({ event, created_at: 1_790_000_000 + sequence, payload: { payment: { entity }, ...(event === "order.paid" ? { order: { entity: { id: orderId, amount_paid: paise } } } : {}) } });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))).map(v => v.toString(16).padStart(2, "0")).join("");
  const response = await webhook.POST(new Request("http://localhost/api/razorpay-webhook", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-event-id": `evt_${sequence}_${event}_${paymentId}`, "x-razorpay-signature": signature }, body: raw }));
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("failed attempt, then same-order captured retry: the CAPTURED payment owns the link", async () => {
  const w = await world();
  const failed = await signed("payment.failed", { paymentId: "pay_failed_first", errorCode: "payment_cancelled" });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(w.linkPayment(), null, "a failed attempt never writes the link");
  const captured = await signed("payment.captured", { paymentId: "pay_retry_ok" });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(w.linkPayment(), "pay_retry_ok");
  assert.deepEqual(w.ledger(), { journals: 1, captured: 1241, payment: "captured" });
  // The failure is still persisted as signed evidence; it just does not own the captured identity.
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_events WHERE gateway_payment_id='pay_failed_first' AND event_type='payment.failed' AND signature_verified=1").get().n, 1);
});

test("an authorized-but-never-captured attempt does not own the link; the captured one does", async () => {
  const w = await world();
  const authorized = await signed("payment.authorized", { paymentId: "pay_authorized_only" });
  assert.ok([200, 202].includes(authorized.status), JSON.stringify(authorized.body));
  assert.equal(w.linkPayment(), null);
  assert.equal(w.sqlite.prepare("SELECT gateway_payment_id FROM payment_intents WHERE id='PI-RT'").get().gateway_payment_id, "pay_authorized_only", "the authorization pins the intent (unchanged behaviour)");
  const captured = await signed("payment.captured", { paymentId: "pay_second_ok" });
  assert.equal(captured.status, 200, `the captured retry must be recorded, not refused at commit verification: ${JSON.stringify(captured.body)}`);
  assert.equal(w.linkPayment(), "pay_second_ok");
  assert.deepEqual({ ...w.sqlite.prepare("SELECT state,gateway_payment_id FROM payment_intents WHERE id='PI-RT'").get() }, { state: "CAPTURED", gateway_payment_id: "pay_second_ok" });
  assert.deepEqual(w.ledger(), { journals: 1, captured: 1241, payment: "captured" });
});

test("a second capture notification on an already-CAPTURED order keeps the first captured payment everywhere", async () => {
  const w = await world();
  assert.equal((await signed("payment.captured", { paymentId: "pay_first" })).status, 200);
  const second = await signed("payment.captured", { paymentId: "pay_double" });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(w.linkPayment(), "pay_first");
  assert.equal(w.sqlite.prepare("SELECT gateway_payment_id FROM payment_intents WHERE id='PI-RT'").get().gateway_payment_id, "pay_first");
  // Unchanged behaviour: an order is paid once, so the existing replay check treats another capture of the SAME order
  // and amount as a repeat of the collected capture. Nothing is recounted and nothing is relinked.
  const recon = w.sqlite.prepare("SELECT captured_amount,reconciliation_status FROM payment_reconciliation_records WHERE payment_id='PAY-RT'").get();
  assert.equal(Number(recon.captured_amount), 1241);
  assert.equal(recon.reconciliation_status, "matched");
  assert.equal(w.ledger().journals, 1);
});

test("arrival order and duplicates: capture first, late failure and duplicate notifications change nothing", async () => {
  const w = await world();
  assert.equal((await signed("payment.captured", { paymentId: "pay_ok" })).status, 200);
  assert.equal((await signed("order.paid", { paymentId: "pay_ok" })).status, 200);
  assert.equal((await signed("payment.captured", { paymentId: "pay_ok" })).status, 200);
  const lateFailure = await signed("payment.failed", { paymentId: "pay_failed_late", errorCode: "payment_cancelled" });
  assert.ok(lateFailure.status < 500, JSON.stringify(lateFailure.body));
  await signed("payment.failed", { paymentId: "pay_failed_late", errorCode: "payment_cancelled" });
  assert.equal(w.linkPayment(), "pay_ok");
  assert.deepEqual(w.ledger(), { journals: 1, captured: 1241, payment: "captured" }, "no duplicate ledger");
});

test("duplicate failures before the capture still leave the link to the capture", async () => {
  const w = await world();
  await signed("payment.failed", { paymentId: "pay_failed_a", errorCode: "payment_cancelled" });
  await signed("payment.failed", { paymentId: "pay_failed_a", errorCode: "payment_cancelled" });
  await signed("payment.failed", { paymentId: "pay_failed_b", errorCode: "payment_cancelled" });
  assert.equal(w.linkPayment(), null);
  assert.equal((await signed("payment.captured", { paymentId: "pay_third_ok" })).status, 200);
  assert.equal(w.linkPayment(), "pay_third_ok");
  assert.deepEqual(w.ledger(), { journals: 1, captured: 1241, payment: "captured" });
});

test("a legitimate first capture keeps the link when an additional capture (reschedule difference) follows", async () => {
  const w = await world();
  assert.equal((await signed("payment.captured", { paymentId: "pay_first_capture" })).status, 200);
  w.intent("PI-DIFF", "BK-RT", "PAY-RT", "order_difference", 28500, '{"paymentStage":"reschedule_difference"}');
  const diff = await signed("payment.captured", { paymentId: "pay_difference", orderId: "order_difference", paise: 28500 });
  assert.equal(diff.status, 200, JSON.stringify(diff.body));
  assert.equal(w.linkPayment(), "pay_first_capture", "the first verified capture stays the link's payment");
  assert.equal(w.ledger().captured, 1526);
});

test("a verified replay repairs a link a failed attempt took before this fix; a verified first capture is never displaced", async () => {
  const w = await world();
  assert.equal((await signed("payment.captured", { paymentId: "pay_verified" })).status, 200);
  // The deployed defect's resulting row: the link names the failed attempt although pay_verified captured.
  w.sqlite.exec("UPDATE payment_gateway_links SET gateway_payment_id='pay_failed_old' WHERE booking_id='BK-RT'");
  w.sqlite.exec("INSERT INTO payment_gateway_events (id,provider,environment,event_id,event_type,booking_id,payment_id,gateway_order_id,gateway_payment_id,amount_subunits,currency,signature_verified,payload_hash,processing_status,detail_json,received_at,processed_at) VALUES ('PAYEV-FAILED-OLD','razorpay','sandbox','evt_failed_old','payment.failed','BK-RT','PAY-RT','order_retry_same','pay_failed_old',124100,'INR',1,'" + "ef".repeat(32) + "','processed','{}',0,0)");
  const before = w.ledger();
  assert.equal((await signed("order.paid", { paymentId: "pay_verified" })).status, 200);
  assert.equal(w.linkPayment(), "pay_verified", "the replay of the verified capture claims the link");
  assert.deepEqual(w.ledger(), before, "and moves no money");
  // A different signed capture id on the same order cannot displace a verified first capture.
  w.sqlite.exec("UPDATE payment_gateway_links SET gateway_payment_id='pay_verified' WHERE booking_id='BK-RT'");
  await signed("payment.captured", { paymentId: "pay_verified" });
  assert.equal(w.linkPayment(), "pay_verified");
});

test("foreign booking, order and environment cannot claim the link", async () => {
  const w = await world();
  // Signed capture of ANOTHER booking's order that claims this booking in its notes: refused, nothing linked here.
  const foreign = await signed("payment.captured", { paymentId: "pay_foreign", orderId: "order_other_booking", bookingId: "BK-RT" });
  assert.equal(foreign.status, 409, JSON.stringify(foreign.body));
  assert.equal(w.linkPayment(), null);
  assert.equal(w.sqlite.prepare("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id='BK-OTHER'").get().gateway_payment_id, null);
  assert.equal(w.ledger().payment, "created");
  // The claim is scoped to the link's environment: a live-attributed capture id cannot take a sandbox link.
  const claim = w.reconciliation.claimCapturedPaymentLinkStatement(w.db, { bookingId: "BK-RT", paymentId: "PAY-RT", environment: "live", gatewayPaymentId: "pay_live_x", now: 1 });
  assert.equal((await claim.run()).meta.changes, 0);
  // Nor can a claim name another booking's payment row.
  const wrongPayment = w.reconciliation.claimCapturedPaymentLinkStatement(w.db, { bookingId: "BK-RT", paymentId: "PAY-OTHER", environment: "sandbox", gatewayPaymentId: "pay_cross", now: 1 });
  assert.equal((await wrongPayment.run()).meta.changes, 0);
  assert.equal(w.linkPayment(), null);
});

test("refund readers: sandbox initiate_refund targets the captured payment; the sweep's capture list excludes the failure", async () => {
  const w = await world();
  await signed("payment.failed", { paymentId: "pay_failed_first", errorCode: "payment_cancelled" });
  assert.equal((await signed("payment.captured", { paymentId: "pay_retry_ok" })).status, 200);
  const { capturedGatewayPayments } = await import("../lib/automatic-booking-refund.ts");
  assert.deepEqual((await capturedGatewayPayments(w.db, "PAY-RT")).map(item => item.gatewayPaymentId), ["pay_retry_ok"]);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(w.db);
  await w.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-FIN','finance.manager@pawspace.test','Finance manager','finance','active',0,0)").run();
  w.sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,created_at,updated_at) VALUES ('RF-RT','BK-RT','PAY-RT',1241,'test refund','approved','finance@pawspace.test','finance@pawspace.test',0,0)").run();
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ id: "rfnd_synthetic", status: "processed" }), { status: 200, headers: { "content-type": "application/json" } }); };
  const route = await import("../app/api/grooming-payment-sandbox/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/grooming-payment-sandbox", { method: "POST", headers: { "content-type": "application/json", ...FINANCE }, body: JSON.stringify({ bookingId: "BK-RT", action: "initiate_refund", refundCaseId: "RF-RT" }) }));
  assert.ok(response.status < 300, await response.text());
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/v1\/payments\/pay_retry_ok\/refund$/, "the refund goes to the payment that captured, never the failed attempt");
});
