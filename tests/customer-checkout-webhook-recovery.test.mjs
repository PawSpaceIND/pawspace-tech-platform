/**
 * Customer checkout -> signed webhook -> customer confirmation and durable finance.
 * Real route handlers, session/ownership checks and transactional SQLite D1 adapter.
 * Provider order response and signed delivery are SYNTHETIC: not a Razorpay capture,
 * real webhook transport, physical browser journey, refund or payout certification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__CHECKOUT_RECOVERY_DB__", "__CHECKOUT_RECOVERY_ENV__");
const checkout = await import("../app/api/customer-checkout/route.ts");
const webhook = await import("../app/api/razorpay-webhook/route.ts");
const env = {
  PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true",
  PAWSPACE_DEPLOYMENT_ENV: "e2e", NODE_ENV: "test", APP_ENV: "staging",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_recoveryFixture",
  RAZORPAY_KEY_SECRET_SANDBOX: "synthetic-checkout-secret-not-a-credential",
  RAZORPAY_WEBHOOK_SECRET_SANDBOX: "synthetic-webhook-secret-not-a-credential",
};
const origin = "https://checkout-recovery.pawspace.test";
const sign = (secret, raw) => createHmac("sha256", secret).update(raw).digest("hex");

async function setup(t, { createOrder = true, runtimePatch = {} } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1(sqlite); enterWorkersDbScope(db);
  globalThis.__CHECKOUT_RECOVERY_DB__ = db;
  const runtime = { ...env, ...runtimePatch };
  globalThis.__CHECKOUT_RECOVERY_ENV__ = runtime;
  sqlite.exec(`
    CREATE TABLE canonical_customers(id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,email TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO canonical_customers VALUES ('C1','blr','Synthetic recovery customer','9800000991','recovery@pawspace.test',0,0);
    INSERT INTO canonical_bookings VALUES ('B1','recovery-booking','C1','[]','[]','blr','blr-east','grooming','dog-basic','Bath & Basic','GROUP1','PRV1','2030-01-01T10:00:00Z','2030-01-01T12:00:00Z','confirmed','customer_app',499.50,'INR','{}','recovery-test',0,0);
    INSERT INTO booking_payments VALUES ('P1','B1','C1',499.50,499.50,'INR','upi','prepaid','created','razorpay_sandbox','recovery-payment','{}',0,0);
  `);
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const principalKey = "customer:C1";
  const binding = await upsertIdentityBinding(db, { identitySource: "customer_otp", principalType: "identity_subject", principalKey,
    subjectType: "customer", subjectId: "C1", actorId: "checkout-recovery-test", reason: "Synthetic session fixture" });
  const session = await issuePlatformSession(db, { bindingId: binding.id, identitySource: "customer_otp", principalType: "identity_subject",
    principalKey, subjectType: "customer", subjectId: "C1" });
  const cookie = `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
  let providerCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.razorpay.com/v1/orders", "no other outbound network is allowed");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body); assert.equal(body.amount, 49950); assert.equal(body.currency, "INR");
    providerCalls++;
    return Response.json({ id: "order_recoveryFixture", amount: body.amount, currency: "INR", status: "created" });
  });
  async function customer(body) {
    const response = await checkout.POST(new Request(`${origin}/api/customer-checkout`, {
      method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  }
  if (createOrder) {
    const order = await customer({ action: "start", bookingId: "B1" });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.data.orderId, "order_recoveryFixture");
  }
  const receipt = { bookingId: "B1", orderId: "order_recoveryFixture", paymentId: "pay_recoveryFixture",
    signature: sign(env.RAZORPAY_KEY_SECRET_SANDBOX, "order_recoveryFixture|pay_recoveryFixture") };
  function payload(event) {
    return JSON.stringify({ event, created_at: 1800000000, payload: { payment: { entity: {
      id: receipt.paymentId, order_id: receipt.orderId, amount: 49950, currency: "INR", status: event === "payment.authorized" ? "authorized" : "captured",
      notes: { booking_id: "B1" },
    } } } });
  }
  async function deliver(event, eventId, raw = payload(event), secret = env.RAZORPAY_WEBHOOK_SECRET_SANDBOX) {
    const response = await webhook.POST(new Request(`${origin}/api/razorpay-webhook`, { method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-event-id": eventId, "x-razorpay-signature": sign(secret, raw) }, body: raw }));
    return { status: response.status, body: await response.json() };
  }
  const confirm = () => customer({ action: "confirm", ...receipt });
  return { sqlite, db, runtime, deliver, confirm, customer, payload, receipt, providerCalls: () => providerCalls };
}

for (const captureType of ["payment.captured", "order.paid"]) {
  test(`${captureType} arriving before authorization remains retryable, then confirms once without another checkout`, async t => {
    const w = await setup(t);
    const initial = await w.confirm();
    assert.equal(initial.status, 200); assert.equal(initial.body.data.status, "awaiting_confirmation");
    const early = await w.deliver(captureType, "evt_recovery_capture");
    assert.equal(early.body.deferred, true, JSON.stringify(early));
    assert.equal(early.body.ok, false);
    assert.equal(early.body.code, "payment_state_transition_deferred");
    const stillEarly = await w.deliver(captureType, "evt_recovery_capture");
    assert.equal(stillEarly.status, 503, "a repeat before authorization must remain retryable");
    const inbox = w.sqlite.prepare("SELECT processing_status,processed_at FROM gateway_webhook_events WHERE event_id='evt_recovery_capture'").get();
    assert.equal(inbox.processing_status, "DEFERRED"); assert.equal(inbox.processed_at, null);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM gateway_webhook_events").get().n, 1);
    assert.equal(w.sqlite.prepare("SELECT state FROM payment_intents").get().state, "CREATED");
    assert.equal(w.sqlite.prepare("SELECT status FROM booking_payments").get().status, "created");
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions").get().n, 0);
    assert.equal((await w.confirm()).body.data.status, "awaiting_confirmation");
    const authorized = await w.deliver("payment.authorized", "evt_recovery_authorized");
    assert.equal(authorized.status, 200, JSON.stringify(authorized));
    assert.equal(w.sqlite.prepare("SELECT state FROM payment_intents").get().state, "AUTHORIZED");
    // Authorization must not manufacture capture. The signed deferred delivery needs a real retry.
    assert.equal((await w.confirm()).body.data.status, "awaiting_confirmation");
    const recovered = await w.deliver(captureType, "evt_recovery_capture");
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    assert.equal((await w.confirm()).body.data.status, "captured");
    const repeated = await w.deliver(captureType, "evt_recovery_capture");
    assert.equal(repeated.status, 200); assert.equal(repeated.body.duplicate, true);
    const alias = await w.deliver(captureType === "payment.captured" ? "order.paid" : "payment.captured", "evt_recovery_alias");
    assert.equal(alias.status, 200); assert.equal(alias.body.duplicateCapture, true);
    const settled = await w.customer({ action: "start", bookingId: "B1" });
    assert.equal(settled.status, 200); assert.equal(settled.body.data.status, "nothing_due");
    assert.equal(w.providerCalls(), 1, "no second gateway order");
    assert.equal(w.sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records").get().captured_amount, 499.50);
    const journal = w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture' AND status='POSTED'").get();
    assert.equal(journal.n, 1, "the payment posts exactly one atomic journal");
    const entries = w.sqlite.prepare("SELECT direction,SUM(amount_paise) amount FROM journal_entries GROUP BY direction ORDER BY direction").all();
    assert.deepEqual(entries.map(row => [row.direction, row.amount]), [["CREDIT", 49950], ["DEBIT", 49950]]);
    console.log(`[CHECKOUT-RECOVERY] ${JSON.stringify({ captureType, earlyHttp: early.status, recoveredHttp: recovered.status, confirmed: "captured", providerOrders: w.providerCalls(), journalCount: journal.n, delivery: "synthetic_signed_replay" })}`);
    assert.equal(early.status, 503, "a deferred capture must not acknowledge delivery success and suppress gateway retries");
  });
}

test("authorization-first checkout confirms from a signed capture without a deferral", async t => {
  const w = await setup(t);
  const authorized = await w.deliver("payment.authorized", "evt_ordered_authorized");
  assert.equal(authorized.status, 200, JSON.stringify(authorized));
  assert.equal((await w.confirm()).body.data.status, "awaiting_confirmation");
  const capture = await w.deliver("payment.captured", "evt_ordered_capture");
  assert.equal(capture.status, 200, JSON.stringify(capture));
  assert.equal(capture.body.atomicCapture, true);
  assert.equal((await w.confirm()).body.data.status, "captured");
  assert.equal(w.providerCalls(), 1);
});

test("deferred recovery still rejects wrong signatures and an event-ID body swap without capture", async t => {
  const w = await setup(t);
  const first = await w.deliver("payment.captured", "evt_attack_capture");
  assert.equal(first.status, 503);
  const before = w.sqlite.prepare("SELECT * FROM gateway_webhook_events").all();
  const wrong = await w.deliver("payment.captured", "evt_attack_capture", w.payload("payment.captured"), "wrong-synthetic-secret");
  assert.equal(wrong.status, 401);
  const tampered = JSON.parse(w.payload("payment.captured"));
  tampered.payload.payment.entity.amount = 1;
  const swapped = await w.deliver("payment.captured", "evt_attack_capture", JSON.stringify(tampered));
  assert.equal(swapped.status, 409);
  assert.deepEqual(w.sqlite.prepare("SELECT * FROM gateway_webhook_events").all(), before);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions").get().n, 0);
  assert.equal(w.sqlite.prepare("SELECT status FROM booking_payments").get().status, "created");
  assert.equal((await w.confirm()).body.data.status, "awaiting_confirmation");
  assert.equal((await w.deliver("payment.authorized", "evt_attack_authorized")).status, 200);
  assert.equal((await w.deliver("payment.captured", "evt_attack_capture")).status, 200);
  assert.equal((await w.confirm()).body.data.status, "captured");
});

for (const state of ["FAILED", "CANCELLED"]) {
  test(`a signed capture cannot bypass the protected ${state} intent state`, async t => {
    const w = await setup(t);
    w.sqlite.prepare("UPDATE payment_intents SET state=?").run(state);
    const blocked = await w.deliver("payment.captured", "evt_terminal_capture");
    assert.equal(blocked.status, 503); assert.equal(blocked.body.state, state);
    assert.equal(w.sqlite.prepare("SELECT state FROM payment_intents").get().state, state);
    assert.equal(w.sqlite.prepare("SELECT status FROM booking_payments").get().status, "created");
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions").get().n, 0);
    assert.equal((await w.confirm()).body.data.status, "awaiting_confirmation");
    assert.equal(w.providerCalls(), 1);
  });
}

// Opening checkout without a receiver secret strands a valid receipt: the actual webhook
// route cannot accept any capture. These cases join both real routes, not just a config read.
for (const [name, patch] of [
  ["absent", { RAZORPAY_WEBHOOK_SECRET_SANDBOX: undefined }],
  ["empty", { RAZORPAY_WEBHOOK_SECRET_SANDBOX: "" }],
  ["whitespace", { RAZORPAY_WEBHOOK_SECRET_SANDBOX: "  " }],
  ["live-only", { RAZORPAY_WEBHOOK_SECRET_SANDBOX: "", RAZORPAY_WEBHOOK_SECRET_LIVE: "synthetic-live-secret" }],
  ["legacy-only", { RAZORPAY_WEBHOOK_SECRET_SANDBOX: "", RAZORPAY_WEBHOOK_SECRET: "synthetic-legacy-secret" }],
]) {
  test(`checkout refuses a payable order when its sandbox webhook secret is ${name}`, async t => {
    const w = await setup(t, { createOrder: false, runtimePatch: patch });
    const paymentBefore = w.sqlite.prepare("SELECT * FROM booking_payments").all();
    const rejectedWebhook = await w.deliver("payment.captured", "evt_missing_receiver");
    assert.equal(rejectedWebhook.status, 503, "the real receiver cannot process this configuration");
    const start = await w.customer({ action: "start", bookingId: "B1" });
    assert.equal(start.status, 503, `checkout must refuse before creating an unconfirmable order: ${JSON.stringify(start)}`);
    assert.equal(start.body.code, "checkout_webhook_unconfigured");
    assert.match(start.body.error, /confirmation.*not configured/i);
    assert.equal(w.providerCalls(), 0, "no provider request when the receiver is unavailable");
    const { ensureFinancialRuntimeTables } = await import("../lib/financial-runtime-schema.ts");
    await ensureFinancialRuntimeTables(w.db);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payment_intents").get().n, 0);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM financial_outbox").get().n, 0);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM gateway_webhook_events").get().n, 0);
    assert.deepEqual(w.sqlite.prepare("SELECT * FROM booking_payments").all(), paymentBefore);
    assert.doesNotMatch(JSON.stringify(start.body), /synthetic-|rzp_test_|RAZORPAY_WEBHOOK_SECRET/);
  });
}

test("restoring receiver configuration allows the same customer intent to retry without a duplicate order", async t => {
  const w = await setup(t, { createOrder: false, runtimePatch: { RAZORPAY_WEBHOOK_SECRET_SANDBOX: "" } });
  const blocked = await w.customer({ action: "start", bookingId: "B1" });
  assert.equal(blocked.status, 503);
  assert.equal(w.providerCalls(), 0);
  w.runtime.RAZORPAY_WEBHOOK_SECRET_SANDBOX = env.RAZORPAY_WEBHOOK_SECRET_SANDBOX;
  for (let i = 0; i < 2; i++) {
    const started = await w.customer({ action: "start", bookingId: "B1" });
    assert.equal(started.status, 201, JSON.stringify(started));
    assert.equal(started.body.data.orderId, w.receipt.orderId);
    assert.equal(started.body.data.amountPaise, 49950);
  }
  assert.equal(w.providerCalls(), 1);
  assert.equal((await w.confirm()).body.data.status, "awaiting_confirmation");
  assert.equal((await w.deliver("payment.authorized", "evt_restored_authorized")).status, 200);
  assert.equal((await w.deliver("payment.captured", "evt_restored_capture")).status, 200);
  assert.equal((await w.confirm()).body.data.status, "captured");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE status='POSTED'").get().n, 1);
});

test("receiver outage never prevents confirmation of a capture that was already verified and recorded", async t => {
  const w = await setup(t);
  assert.equal((await w.deliver("payment.authorized", "evt_recorded_authorized")).status, 200);
  assert.equal((await w.deliver("payment.captured", "evt_recorded_capture")).status, 200);
  w.runtime.RAZORPAY_WEBHOOK_SECRET_SANDBOX = "";
  const confirmed = await w.confirm();
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.status, "captured");
  const settled = await w.customer({ action: "start", bookingId: "B1" });
  assert.equal(settled.status, 200);
  assert.equal(settled.body.data.status, "nothing_due");
  assert.equal(w.providerCalls(), 1, "status recovery must not open another order");
});

test("receiver outage leaves an existing receipt pending rather than manufacturing a payment or starting another order", async t => {
  const w = await setup(t);
  w.runtime.RAZORPAY_WEBHOOK_SECRET_SANDBOX = "";
  const pending = await w.confirm();
  assert.equal(pending.status, 200);
  assert.equal(pending.body.data.status, "awaiting_confirmation");
  assert.equal((await w.deliver("payment.captured", "evt_receiver_offline")).status, 503);
  assert.equal(w.sqlite.prepare("SELECT status FROM booking_payments").get().status, "created");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions").get().n, 0);
  assert.equal(w.providerCalls(), 1);
});
