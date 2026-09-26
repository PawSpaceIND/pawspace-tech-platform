/**
 * PAY-02 / STAFF-04 — money taken twice for one booking is recorded, and never reported as a clean match.
 *
 * On staging a ₹499 booking was paid through two checkout orders (two tabs). The second, distinct capture
 * was posted as an ordinary collection: the ledger showed ₹998 collected, and payment reconciliation said
 * expected ₹499, captured ₹998, variance 0, 'matched'. Nobody was told a customer was owed ₹499.
 *
 * The same batch must still not count one capture twice: Razorpay sends payment.captured and order.paid
 * for one payment ~0.3 s apart, and the webhook can race the provider read past the replay check.
 *
 * And a refund's overage is measured against the money actually collected: expected_amount is the amount
 * of the latest order (one instalment of a split booking), so capping by it flagged every full refund of
 * a fully paid split booking as an overage.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { createTransactionalChaosD1 } from "./helpers/transaction-chaos-harness.mjs";

installWorkersHooks("__OVER_COLLECTION_DB__", "__OVER_COLLECTION_ENV__");
let atomic;
let reconciliation;
test.before(async () => {
  atomic = await import("../lib/razorpay-capture-atomic.ts");
  reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
});

/** One Boarding booking worth `amount`, with one payment intent per checkout order in `orders`. */
async function world({ amount = 499, orders = [["PI-A", "order_A", 49900], ["PI-B", "order_B", 49900]], schedule = null } = {}) {
  const h = createTransactionalChaosD1();
  installFinancialLifecycleSchema(h.sqlite);
  h.sqlite.exec(`CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT NOT NULL,city_id TEXT,service_code TEXT,total_amount REAL,currency TEXT,updated_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,currency TEXT NOT NULL,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER);
    CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER);`);
  const now = Date.now() - 10 * 60_000;
  h.sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-OC','CUS-OC','confirmed','blr','boarding',?,'INR',?)").run(amount, now);
  h.sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-OC','BK-OC','CUS-OC',?,'INR','netbanking','prepaid','created','uat_sandbox','{}',?,?)").run(amount, now, now);
  if (schedule) h.sqlite.prepare("INSERT INTO stay_payment_schedules VALUES ('BK-OC','boarding','CUS-OC',?,?,?,?,'pending_balance',NULL,NULL,?,?)").run(amount, schedule.paidNow, schedule.balance, now + 86_400_000, now, now);
  for (const [id, order, paise] of orders) {
    h.sqlite.prepare(`INSERT INTO payment_intents
      (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gateway_order_id,
       gross_service_value_paise,platform_fee_paise,partner_earning_paise,tds_paise,gst_paise,commission_rate_bps,commission_rate_version,tax_rule_version,commercial_snapshot_json,version,created_at,updated_at)
      VALUES (?,'BK-OC','CUS-OC','PAY-OC','razorpay','sandbox',?,?,'INR','CREATED','ORDER_CREATED',?,?,0,?,0,0,0,'test','test','{}',0,?,?)`).run(id, `idem-${id}`, paise, order, paise, paise, now, now);
  }
  globalThis.__OVER_COLLECTION_DB__ = h.db;
  globalThis.__OVER_COLLECTION_ENV__ = {};
  await reconciliation.ensurePaymentReconciliationTables(h.db);
  return h;
}

async function capture(db, { intentId, order, pay, paise, eventId }) {
  const result = await atomic.commitRazorpayCaptureAtomic(db, {
    authority: "provider_api", eventId, environment: "sandbox", intentId, bookingId: "BK-OC", paymentId: "PAY-OC",
    gatewayOrderId: order, gatewayPaymentId: pay, amountPaise: paise, currency: "INR", payloadHash: `hash-${eventId}`,
  });
  if (result.effectsOutboxId) await atomic.executeRazorpayCapturePostCommit(db, { outboxId: result.effectsOutboxId, workerId: `test-${eventId}` });
  return result;
}

const rec = (h) => h.row("SELECT expected_amount,captured_amount,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='PAY-OC'");
const overCollectionExceptions = (h) => h.sqlite.prepare("SELECT status,severity,detail_json FROM payment_reconciliation_exceptions WHERE exception_type='over_collection'").all();

test("a second distinct capture on a paid booking is recorded but reported as over-collected, with a Finance exception", async () => {
  const h = await world();
  try {
    const first = await capture(h.db, { intentId: "PI-A", order: "order_A", pay: "pay_A", paise: 49900, eventId: "evt_A" });
    assert.equal(first.reconciliationStatus, "matched");
    const second = await capture(h.db, { intentId: "PI-B", order: "order_B", pay: "pay_B", paise: 49900, eventId: "evt_B" });
    assert.equal(second.duplicateCapture, false, "a distinct gateway payment is real money and must be recorded");
    assert.equal(second.reconciliationStatus, "over_collected");

    const row = rec(h);
    assert.equal(Number(row.captured_amount), 998, "reconciliation must hold every rupee captured");
    assert.equal(row.reconciliation_status, "over_collected", "₹998 against a ₹499 booking is not a match");
    assert.equal(Number(row.variance_amount), 499, "the excess is the variance");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM journal_transactions WHERE source_type='razorpay_capture'"), 2, "both captures stay in the books");

    const exceptions = overCollectionExceptions(h);
    assert.equal(exceptions.length, 1, "Finance must get exactly one over-collection exception");
    assert.equal(exceptions[0].status, "open");
    assert.equal(exceptions[0].severity, "critical");
    assert.deepEqual(JSON.parse(exceptions[0].detail_json), { bookingValue: 499, capturedAmount: 998, excessAmount: 499 });
    assert.equal(h.scalar("SELECT COUNT(*) value FROM booking_lifecycle_events WHERE booking_id='BK-OC' AND event_type='payment_over_collected'"), 1, "the booking timeline records it");
  } finally { h.close(); }
});

test("one capture reaching the batch twice at once is counted once and stays matched", async () => {
  const h = await world({ orders: [["PI-A", "order_A", 49900]] });
  // Both calls pass the replay check before either commits: payment.captured and order.paid racing.
  let waiting = [], arrived = 0;
  const gated = new Proxy(h.db, { get(target, prop) {
    if (prop === "batch") return async (statements) => {
      if (statements.some(item => /INSERT INTO journal_transactions/.test(String(item.sql)))) {
        arrived += 1;
        if (arrived < 2) await new Promise(resolve => waiting.push(resolve));
        else waiting.splice(0).forEach(resolve => resolve());
      }
      return target.batch(statements);
    };
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    const results = await Promise.all([
      capture(gated, { intentId: "PI-A", order: "order_A", pay: "pay_A", paise: 49900, eventId: "evt_payment_captured" }),
      capture(gated, { intentId: "PI-A", order: "order_A", pay: "pay_A", paise: 49900, eventId: "evt_order_paid" }),
    ]);
    assert.equal(arrived, 2, "the test must actually race both commits past the replay check");
    assert.ok(results.every(result => result.duplicateCapture === false));
    const row = rec(h);
    assert.equal(Number(row.captured_amount), 499, "one gateway payment is one collection");
    assert.equal(row.reconciliation_status, "matched");
    assert.equal(Number(row.variance_amount), 0);
    assert.equal(overCollectionExceptions(h).length, 0, "no false over-collection");
    assert.equal(h.scalar("SELECT COUNT(*) value FROM journal_transactions WHERE source_type='razorpay_capture'"), 1);
  } finally { h.close(); }
});

test("a split stay's deposit and balance add up to a match, not an over-collection", async () => {
  const h = await world({ amount: 3495, schedule: { paidNow: 1747.5, balance: 1747.5 }, orders: [["PI-DEP", "order_dep", 174750], ["PI-BAL", "order_bal", 174750]] });
  try {
    const deposit = await capture(h.db, { intentId: "PI-DEP", order: "order_dep", pay: "pay_dep", paise: 174750, eventId: "evt_dep" });
    assert.equal(deposit.reconciliationStatus, "partially_captured");
    const balance = await capture(h.db, { intentId: "PI-BAL", order: "order_bal", pay: "pay_bal", paise: 174750, eventId: "evt_bal" });
    assert.equal(balance.reconciliationStatus, "matched");
    const row = rec(h);
    assert.equal(Number(row.captured_amount), 3495);
    assert.equal(Number(row.variance_amount), 0);
    assert.equal(overCollectionExceptions(h).length, 0);
  } finally { h.close(); }
});

function refundWorld({ expected, captured, refund }) {
  const sqlite = new DatabaseSync(":memory:");
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  const db = { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async (sql) => sqlite.exec(sql) };
  globalThis.__OVER_COLLECTION_DB__ = db;
  return { sqlite, db, setup: async () => {
    await reconciliation.ensurePaymentReconciliationTables(db);
    const now = Date.now();
    sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,status TEXT)");
    sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
    sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,amount REAL,status TEXT,gateway_reference TEXT,created_at INTEGER,updated_at INTEGER)");
    sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-SP','CUS-SP','blr','boarding','cancelled')").run();
    sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-SP','BK-SP','CUS-SP',?,?,'INR','card','split_50_50','captured','razorpay','idem-sp','{}',?,?)").run(captured, expected, now, now);
    sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,updated_at) VALUES ('PAY-SP','BK-SP','razorpay','sandbox',?,?,0,'INR','captured','matched',0,?)").run(expected, captured, now);
    sqlite.prepare("INSERT INTO booking_refund_cases VALUES ('RFD-SP','BK-SP','PAY-SP',?,'approved',NULL,?,?)").run(refund, now, now);
    return reconciliation.processGatewayEvent(db, {
      provider: "razorpay", environment: "sandbox", eventId: "evt-sp-refund", eventType: "refund.processed", bookingId: "BK-SP",
      amountSubunits: Math.round(refund * 100), gatewayRefundId: "rfnd_sp", payloadHash: "sha256:sp", signatureVerified: true,
    });
  } };
}

test("a full refund of a fully paid split booking is not an overage", async () => {
  // expected_amount is the balance order (₹1,747.50); the booking collected ₹3,495 in two instalments.
  const w = refundWorld({ expected: 1747.5, captured: 3495, refund: 3495 });
  await w.setup();
  const row = w.sqlite.prepare("SELECT refunded_amount,gateway_status,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='PAY-SP'").get();
  assert.equal(Number(row.refunded_amount), 3495);
  assert.equal(row.reconciliation_status, "matched", "refunding exactly what was collected is not an overage");
  assert.equal(Number(row.variance_amount), 0);
  assert.equal(row.gateway_status, "refunded");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions WHERE exception_type='refund_overage'").get().n, 0);
});
