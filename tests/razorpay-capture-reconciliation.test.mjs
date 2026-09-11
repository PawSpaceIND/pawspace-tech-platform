import assert from "node:assert/strict";
import test from "node:test";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { createTransactionalChaosD1 } from "./helpers/transaction-chaos-harness.mjs";

installWorkersHooks("__CAPTURE_RECON_DB__", "__CAPTURE_RECON_ENV__");
let captureReconciliation;
let captureAtomic;
test.before(async () => {
  captureReconciliation = await import("../lib/razorpay-capture-reconciliation.ts");
  captureAtomic = await import("../lib/razorpay-capture-atomic.ts");
});

function world() {
  const h = createTransactionalChaosD1();
  installFinancialLifecycleSchema(h.sqlite);
  h.sqlite.exec(`CREATE TABLE canonical_bookings (
    id TEXT PRIMARY KEY,customer_id TEXT,status TEXT NOT NULL,city_id TEXT,service_code TEXT,total_amount REAL,currency TEXT,updated_at INTEGER
  );
  CREATE TABLE booking_payments (
    id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,currency TEXT NOT NULL,
    method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER
  );`);
  const now = Date.now() - 10 * 60_000;
  h.sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BOOK-RECON','CUS-RECON','confirmed','blr','grooming',1,'INR',?)").run(now);
  h.sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-RECON','BOOK-RECON','CUS-RECON',1,'INR','netbanking','prepaid','created','uat_sandbox','{}',?,?)").run(now, now);
  h.sqlite.prepare(`INSERT INTO payment_intents
    (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gateway_order_id,
     gross_service_value_paise,platform_fee_paise,partner_earning_paise,tds_paise,gst_paise,commission_rate_bps,commission_rate_version,tax_rule_version,commercial_snapshot_json,version,created_at,updated_at)
    VALUES ('PI-RECON','BOOK-RECON','CUS-RECON','PAY-RECON','razorpay','sandbox','idem-recon',100,'INR','CREATED','ORDER_CREATED','order_reconcile_1',100,0,100,0,0,0,'test','test','{}',0,?,?)`).run(now, now);
  globalThis.__CAPTURE_RECON_DB__ = h.db;
  globalThis.__CAPTURE_RECON_ENV__ = {};
  return h;
}

const ENV = {
  PAWSPACE_PAYMENT_ENV: "sandbox",
  PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_reconciliation",
  RAZORPAY_KEY_SECRET_SANDBOX: "test-secret",
};

test("provider API capture reconciliation closes a missing-webhook capture without fabricating signature evidence", async () => {
  const h = world();
  const originalFetch = globalThis.fetch;
  let providerReads = 0;
  globalThis.fetch = async (url) => {
    providerReads += 1;
    assert.match(String(url), /\/v1\/orders\/order_reconcile_1\/payments$/);
    return new Response(JSON.stringify({ items: [{
      id: "pay_reconcile_1", order_id: "order_reconcile_1", status: "captured", captured: true,
      amount: 100, currency: "INR", notes: { booking_id: "BOOK-RECON", payment_id: "PAY-RECON" },
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const sweep = await captureReconciliation.runRazorpayCaptureReconciliationSweep(h.db, ENV, { asOf: Date.now(), graceMs: 30_000 });
    assert.equal(providerReads, 1);
    assert.equal(sweep.captured, 1);
    assert.equal(sweep.failed, 0);
    assert.equal(h.row("SELECT state,gateway_payment_id FROM payment_intents WHERE id='PI-RECON'")?.state, "CAPTURED");
    assert.equal(h.row("SELECT status FROM booking_payments WHERE id='PAY-RECON'")?.status, "captured");
    const event = h.row("SELECT signature_verified,processing_status,detail_json FROM payment_gateway_events WHERE gateway_payment_id='pay_reconcile_1'");
    assert.equal(Number(event?.signature_verified), 0, "provider API evidence must never masquerade as a signed webhook");
    assert.equal(event?.processing_status, "processed");
    assert.equal(JSON.parse(String(event?.detail_json)).captureAuthority, "provider_api");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM gateway_webhook_events"), 0, "provider reconciliation must not fabricate a webhook inbox row");
    const outbox = h.row("SELECT id,status FROM financial_outbox WHERE event_type='RAZORPAY_CAPTURE_POST_COMMIT'");
    assert.equal(outbox?.status, "SUCCEEDED", "provider reconciliation must complete the existing post-commit saga in the same run");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM booking_lifecycle_events WHERE booking_id='BOOK-RECON' AND event_type='payment_captured'"), 1);
    assert.equal(h.row("SELECT actor_id FROM booking_lifecycle_events WHERE booking_id='BOOK-RECON' AND event_type='payment_captured'")?.actor_id, "razorpay_provider_api");

    h.sqlite.prepare("INSERT INTO gateway_webhook_events (id,provider,environment,event_id,event_type,raw_payload,payload_sha256,signature,processing_status,received_at) VALUES ('IN-LATE','razorpay','sandbox','evt_late_webhook','payment.captured','{}','late-hash','late-sig','PROCESSING',?)").run(Date.now());
    const replay = await captureAtomic.commitRazorpayCaptureAtomic(h.db, {
      inboxId: "IN-LATE", eventId: "evt_late_webhook", environment: "sandbox", intentId: "PI-RECON", bookingId: "BOOK-RECON", paymentId: "PAY-RECON",
      gatewayOrderId: "order_reconcile_1", gatewayPaymentId: "pay_reconcile_1", amountPaise: 100, currency: "INR", payloadHash: "late-hash",
    });
    assert.equal(replay.duplicateCapture, true, "a late signed webhook must not apply the same provider capture twice");
    assert.equal(h.row("SELECT processing_status FROM gateway_webhook_events WHERE id='IN-LATE'")?.processing_status, "PROCESSED");
    assert.equal(h.row("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id='PAY-RECON'")?.captured_amount, 1);
    assert.equal(h.scalar("SELECT COUNT(*) value FROM journal_transactions WHERE source_type='razorpay_capture'"), 1);
  } finally {
    globalThis.fetch = originalFetch;
    h.close();
  }
});

test("capture reconciliation remains fail-closed for unapproved live payments", async () => {
  const h = world();
  const originalFetch = globalThis.fetch;
  let providerReads = 0;
  globalThis.fetch = async () => { providerReads += 1; throw new Error("live provider must not be called"); };
  try {
    const result = await captureReconciliation.runRazorpayCaptureReconciliationSweep(h.db, {
      PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
      RAZORPAY_KEY_ID: "rzp_live_forbidden", RAZORPAY_KEY_SECRET: "forbidden",
    }, { asOf: Date.now() });
    assert.equal(result.skipped, true);
    assert.match(String(result.reason), /Live payments are not approved/);
    assert.equal(providerReads, 0);
    assert.equal(h.row("SELECT state FROM payment_intents WHERE id='PI-RECON'")?.state, "CREATED");
  } finally { globalThis.fetch = originalFetch; h.close(); }
});
