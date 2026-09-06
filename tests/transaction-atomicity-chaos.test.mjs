import assert from "node:assert/strict";
import test from "node:test";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { assertRolledBack, createTransactionalChaosD1, SimulatedTransactionFailure } from "./helpers/transaction-chaos-harness.mjs";

installWorkersHooks("__CHAOS_DB__", "__CHAOS_ENV__");

let finance;
let serviceControl;
let captureAtomic;
let orderSaga;
test.before(async () => {
  finance = await import("../lib/financial-lifecycle.ts");
  serviceControl = await import("../lib/service-control.ts");
  captureAtomic = await import("../lib/razorpay-capture-atomic.ts");
  orderSaga = await import("../lib/razorpay-order-outbox-saga.ts");
});

function financeWorld(options = {}) {
  const harness = createTransactionalChaosD1(options);
  harness.sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  installFinancialLifecycleSchema(harness.sqlite);
  globalThis.__CHAOS_DB__ = harness.db;
  globalThis.__CHAOS_ENV__ = {};
  return harness;
}

function seedPaymentIntent(sqlite, { bookingId = "BOOK-CHAOS", intentId = "PI-CHAOS", status = "CREATED", paymentId = "PAY-CHAOS", amountPaise = 10000 } = {}) {
  const now = Date.now();
  sqlite.prepare(`INSERT INTO payment_intents
    (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,
     gross_service_value_paise,platform_fee_paise,partner_earning_paise,tds_paise,gst_paise,commission_rate_bps,
     commission_rate_version,tax_rule_version,commercial_snapshot_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(intentId, bookingId, "CUS-CHAOS", paymentId, "razorpay", "sandbox", `idem-${intentId}`, amountPaise, "INR", status,
      "PAYMENT_ORDER_REQUESTED", amountPaise, 1500, Math.max(0, amountPaise - 1500), 0, 0, 1500, "chaos-v1", "chaos-tax-v1", "{}", now, now);
}

function installCaptureProjectionSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE booking_payments (
      id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,currency TEXT NOT NULL,
      method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER
    );
    CREATE TABLE payment_gateway_links (
      id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,payment_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,environment TEXT NOT NULL,
      gateway_order_id TEXT UNIQUE,gateway_payment_link_id TEXT UNIQUE,gateway_payment_id TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE TABLE payment_gateway_events (
      id TEXT PRIMARY KEY,provider TEXT NOT NULL,environment TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,booking_id TEXT,payment_id TEXT,
      gateway_order_id TEXT,gateway_payment_id TEXT,gateway_refund_id TEXT,amount_subunits INTEGER,currency TEXT,signature_verified INTEGER NOT NULL,payload_hash TEXT NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'received',failure_reason TEXT,detail_json TEXT NOT NULL DEFAULT '{}',received_at INTEGER NOT NULL,processed_at INTEGER,UNIQUE(provider,event_id)
    );
    CREATE TABLE payment_reconciliation_records (
      payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT NOT NULL,environment TEXT NOT NULL,expected_amount REAL NOT NULL,
      captured_amount REAL NOT NULL DEFAULT 0,refunded_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,gateway_status TEXT NOT NULL DEFAULT 'not_started',
      reconciliation_status TEXT NOT NULL DEFAULT 'pending',variance_amount REAL NOT NULL DEFAULT 0,last_event_id TEXT,updated_at INTEGER NOT NULL
    );
  `);
}

test("chaos: checkout intent + financial outbox rollback together when connection drops after intent insert", async () => {
  const h = financeWorld({ failBatch: 1, failAfterStatement: 1 });
  try {
    await assert.rejects(() => finance.claimPaymentIntent(h.db, {
      bookingId: "BOOK-CHECKOUT-CHAOS",
      customerId: "CUS-CHECKOUT-CHAOS",
      paymentId: "PAY-CHECKOUT-CHAOS",
      idempotencyKey: "checkout-chaos-1",
      amountPaise: 12500,
      currency: "INR",
      environment: "sandbox",
    }), SimulatedTransactionFailure);

    assert.equal(h.injected(), true, "the requested fault point must have fired");
    await assertRolledBack(assert, h, [
      { sql: "SELECT COUNT(*) value FROM payment_intents WHERE booking_id='BOOK-CHECKOUT-CHAOS'", label: "no orphan payment intent" },
      { sql: "SELECT COUNT(*) value FROM financial_outbox WHERE aggregate_type='payment_intent'", label: "no orphan financial outbox row" },
    ]);
  } finally { h.close(); }
});

test("chaos: journal header and partial journal lines leave zero durable ledger rows on mid-batch failure", async () => {
  const h = financeWorld({ failBatch: 1, failAfterStatement: 2 });
  try {
    await assert.rejects(() => finance.postBalancedJournal(h.db, {
      sourceType: "razorpay_capture",
      sourceId: "PI-JOURNAL-CHAOS",
      sourceEventId: "razorpay:evt-journal-chaos:capture",
      narration: "Chaos journal rollback",
      currency: "INR",
      entries: [
        { accountCode: "gateway_clearing", direction: "DEBIT", amountPaise: 9900, bookingId: "BOOK-JOURNAL-CHAOS" },
        { accountCode: "customer_collections", direction: "CREDIT", amountPaise: 9900, bookingId: "BOOK-JOURNAL-CHAOS" },
      ],
    }), SimulatedTransactionFailure);

    await assertRolledBack(assert, h, [
      { sql: "SELECT COUNT(*) value FROM journal_transactions WHERE source_event_id='razorpay:evt-journal-chaos:capture'", label: "no orphan DRAFT/POSTED journal header" },
      { sql: "SELECT COUNT(*) value FROM journal_entries WHERE booking_id='BOOK-JOURNAL-CHAOS'", label: "no orphan journal line" },
    ]);
  } finally { h.close(); }
});

test("chaos: partner payable release and source earning state rollback as one unit", async () => {
  const h = financeWorld({ failBatch: 1, failAfterStatement: 1 });
  try {
    h.sqlite.exec("INSERT INTO canonical_bookings (id,status) VALUES ('BOOK-PAYOUT-CHAOS','completed')");
    seedPaymentIntent(h.sqlite, { bookingId: "BOOK-PAYOUT-CHAOS", intentId: "PI-PAYOUT-CHAOS" });
    const now = Date.now();
    h.sqlite.prepare(`INSERT INTO partner_earning_pending
      (id,booking_id,partner_id,payment_intent_id,gross_service_value_paise,platform_fee_paise,tds_paise,gst_paise,earning_paise,currency,status,created_at,updated_at)
      VALUES ('PEP-PAYOUT-CHAOS','BOOK-PAYOUT-CHAOS','PARTNER-CHAOS','PI-PAYOUT-CHAOS',10000,1500,0,0,8500,'INR','PENDING',?,?)`)
      .run(now, now);

    await assert.rejects(() => finance.releasePartnerEarning(h.db, {
      bookingId: "BOOK-PAYOUT-CHAOS",
      releaseType: "completion",
    }), SimulatedTransactionFailure);

    assert.equal(h.scalar("SELECT COUNT(*) value FROM partner_payable_released WHERE booking_id='BOOK-PAYOUT-CHAOS'"), 0, "no orphan released payable");
    assert.equal(h.row("SELECT status FROM partner_earning_pending WHERE id='PEP-PAYOUT-CHAOS'")?.status, "PENDING", "source earning remains pending after rollback");
    assert.ok(h.trace.some((entry) => entry.kind === "rollback"));
  } finally { h.close(); }
});

test("chaos: sensitive service-control mutation cannot commit without its audit event", async () => {
  const h = createTransactionalChaosD1({ failBatch: 2, failAfterStatement: 1 });
  globalThis.__CHAOS_DB__ = h.db;
  globalThis.__CHAOS_ENV__ = {};
  try {
    await assert.rejects(() => serviceControl.setServiceEnabled(h.db, {
      serviceCode: "grooming",
      enabled: false,
      reason: "chaos atomicity verification",
      actorEmail: "chaos-auditor@pawspace.test",
    }), SimulatedTransactionFailure);

    assert.equal(h.row("SELECT enabled FROM service_controls WHERE service_code='grooming'")?.enabled, 1, "sensitive state change rolled back");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM service_control_audit_events WHERE service_code='grooming'"), 0, "no audit row means no state mutation may survive");
    assert.ok(h.trace.some((entry) => entry.kind === "rollback"));
  } finally { h.close(); }
});

test("chaos: payment capture + booking mutation + journal + webhook finalization roll back as one atomic unit", async () => {
  const h = financeWorld({ failBatch: 1, failAfterStatement: 10 });
  try {
    installCaptureProjectionSchema(h.sqlite);
    const now = Date.now();
    h.sqlite.exec("INSERT INTO canonical_bookings (id,status) VALUES ('BOOK-CAPTURE-CHAOS','confirmed')");
    h.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,currency,method,mode,status,gateway,detail_json,created_at,updated_at) VALUES ('PAY-CAPTURE-CHAOS','BOOK-CAPTURE-CHAOS','CUS-CHAOS',100,'INR','upi','prepaid','created','razorpay','{}',?,?)").run(now, now);
    seedPaymentIntent(h.sqlite, { bookingId: "BOOK-CAPTURE-CHAOS", intentId: "PI-CAPTURE-CHAOS", status: "AUTHORIZED", paymentId: "PAY-CAPTURE-CHAOS", amountPaise: 10000 });
    h.sqlite.prepare("UPDATE payment_intents SET gateway_order_id='order_capture_chaos' WHERE id='PI-CAPTURE-CHAOS'").run();
    h.sqlite.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,gateway_order_id,status,created_at,updated_at) VALUES ('LINK-CAPTURE-CHAOS','BOOK-CAPTURE-CHAOS','PAY-CAPTURE-CHAOS','razorpay','sandbox','order_capture_chaos','active',?,?)").run(now, now);
    h.sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES ('PAY-CAPTURE-CHAOS','BOOK-CAPTURE-CHAOS','razorpay','sandbox',100,0,0,'INR','order_linked','pending',0,NULL,?)").run(now);
    h.sqlite.prepare("INSERT INTO gateway_webhook_events (id,provider,environment,event_id,event_type,raw_payload,payload_sha256,signature,processing_status,received_at) VALUES ('GWE-CAPTURE-CHAOS','razorpay','sandbox','evt_capture_chaos','payment.captured','{}','hash-chaos','sig-chaos','PROCESSING',?)").run(now);

    await assert.rejects(() => captureAtomic.commitRazorpayCaptureAtomic(h.db, {
      inboxId: "GWE-CAPTURE-CHAOS",
      eventId: "evt_capture_chaos",
      environment: "sandbox",
      intentId: "PI-CAPTURE-CHAOS",
      bookingId: "BOOK-CAPTURE-CHAOS",
      paymentId: "PAY-CAPTURE-CHAOS",
      gatewayOrderId: "order_capture_chaos",
      gatewayPaymentId: "pay_capture_chaos",
      amountPaise: 10000,
      currency: "INR",
      payloadHash: "hash-chaos",
    }), SimulatedTransactionFailure);

    assert.equal(h.injected(), true, "fault must fire after journal/outbox work but before webhook finalization");
    assert.equal(h.row("SELECT status FROM booking_payments WHERE id='PAY-CAPTURE-CHAOS'")?.status, "created", "booking payment mutation rolled back");
    assert.equal(h.row("SELECT state FROM payment_intents WHERE id='PI-CAPTURE-CHAOS'")?.state, "AUTHORIZED", "payment intent state rolled back");
    assert.equal(h.row("SELECT processing_status FROM gateway_webhook_events WHERE id='GWE-CAPTURE-CHAOS'")?.processing_status, "PROCESSING", "webhook cannot become processed without the financial commit");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM payment_gateway_events WHERE event_id='evt_capture_chaos'"), 0, "no processed domain event survives");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM journal_transactions WHERE source_event_id='razorpay:capture:pay_capture_chaos'"), 0, "no journal header survives");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM journal_entries WHERE booking_id='BOOK-CAPTURE-CHAOS'"), 0, "no journal line survives");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM financial_outbox WHERE event_type='RAZORPAY_CAPTURE_POST_COMMIT'"), 0, "no post-commit command survives a rolled-back capture");
    const recon = h.row("SELECT captured_amount,gateway_status,reconciliation_status FROM payment_reconciliation_records WHERE payment_id='PAY-CAPTURE-CHAOS'");
    assert.equal(recon?.captured_amount, 0);
    assert.equal(recon?.gateway_status, "order_linked");
    assert.ok(h.trace.some((entry) => entry.kind === "rollback"));
  } finally { h.close(); }
});

test("chaos: provider order success + local persistence fault recovers without orphaned external identity or second provider call", async () => {
  const h = financeWorld({ failBatch: 1, failAfterStatement: 1 });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ id: "order_saga_recovery_1", status: "created" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    seedPaymentIntent(h.sqlite, { bookingId: "BOOK-ORDER-SAGA", intentId: "PI-ORDER-SAGA", status: "CREATED", paymentId: "PAY-ORDER-SAGA", amountPaise: 12500 });
    const now = Date.now();
    h.sqlite.prepare(`INSERT INTO financial_outbox
      (id,aggregate_type,aggregate_id,event_type,dedupe_key,payload_json,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES ('FO-ORDER-SAGA','payment_intent','PI-ORDER-SAGA','CREATE_RAZORPAY_ORDER','razorpay-order:PI-ORDER-SAGA','{}','PENDING',0,?,?,?)`).run(now, now, now);

    const result = await orderSaga.executeRazorpayOrderOutbox(h.db, {
      PAWSPACE_PAYMENT_ENV: "sandbox",
      RAZORPAY_KEY_ID_SANDBOX: "rzp_test_chaos",
      RAZORPAY_KEY_SECRET_SANDBOX: "chaos-secret",
    }, { outboxId: "FO-ORDER-SAGA", workerId: "chaos-order-worker" });

    assert.equal(providerCalls, 1, "local recovery must never create a second Razorpay order");
    assert.equal(result.connected, true);
    assert.equal(result.orderId, "order_saga_recovery_1");
    assert.equal(result.recoveredFromPersistenceFailure, true, "the injected first persistence batch must be recovered by the saga");
    assert.equal(result.reconciliationRequired, false);
    assert.equal(h.row("SELECT gateway_order_id FROM payment_intents WHERE id='PI-ORDER-SAGA'")?.gateway_order_id, "order_saga_recovery_1");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM gateway_object_identities WHERE provider='razorpay' AND object_type='order' AND external_id='order_saga_recovery_1' AND owner_id='PI-ORDER-SAGA'"), 1, "provider order has exactly one durable owner");
    assert.equal(h.row("SELECT status FROM financial_outbox WHERE id='FO-ORDER-SAGA'")?.status, "SUCCEEDED", "outbox converges after recovery");
    assert.ok(h.trace.some((entry) => entry.kind === "rollback"), "first local persistence transaction really failed");
    assert.ok(h.trace.some((entry) => entry.kind === "commit" && entry.batch === 2), "saga recovery committed on the second local transaction");
  } finally {
    globalThis.fetch = originalFetch;
    h.close();
  }
});
