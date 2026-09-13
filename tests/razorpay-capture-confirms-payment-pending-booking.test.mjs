/**
 * Signed Razorpay capture -> canonical booking confirmation -> partner work order + CRM visibility.
 *
 * Real webhook route, real atomic capture saga and real post-commit effects against transactional
 * SQLite. The provider order response and the signed delivery are SYNTHETIC; nothing external moves.
 *
 * This is the data flow a human sandbox payment must complete on staging:
 *   canonical_bookings.status      payment_pending -> confirmed
 *   provider_work_orders.status    payment_pending -> assigned | awaiting_acceptance
 *   booking_lifecycle_events       booking_confirmed_after_verified_payment
 *   financial_outbox               RAZORPAY_CAPTURE_POST_COMMIT SUCCEEDED
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__CAPTURE_CONFIRMS_BOOKING_DB__", "__CAPTURE_CONFIRMS_BOOKING_ENV__");
const webhook = await import("../app/api/razorpay-webhook/route.ts");
const { createBookingPaymentOrder } = await import("../lib/payment-order-intent.ts");

const env = {
  PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true",
  PAWSPACE_DEPLOYMENT_ENV: "e2e", NODE_ENV: "test", APP_ENV: "staging",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_confirmFixture",
  RAZORPAY_KEY_SECRET_SANDBOX: "synthetic-checkout-secret-not-a-credential",
  RAZORPAY_WEBHOOK_SECRET_SANDBOX: "synthetic-webhook-secret-not-a-credential",
};
const origin = "https://capture-confirms.pawspace.test";
const sign = (raw) => createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET_SANDBOX).update(raw).digest("hex");

async function setup(t, { serviceCode = "grooming", providerModel = "commission", amount = 499.5, dueNow = 499.5 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1(sqlite); enterWorkersDbScope(db);
  globalThis.__CAPTURE_CONFIRMS_BOOKING_DB__ = db;
  globalThis.__CAPTURE_CONFIRMS_BOOKING_ENV__ = { ...env };
  sqlite.exec(`
    CREATE TABLE canonical_customers(id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,email TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_work_orders(id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER,status TEXT,assignment_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO canonical_customers VALUES ('C1','blr','Synthetic confirm customer','9800000992','confirm@pawspace.test',0,0);
    INSERT INTO canonical_bookings VALUES ('B1','confirm-booking','C1','[]','[]','blr','blr-east','${serviceCode}','dog-basic','Bath & Basic','GROUP1','PRV1','2030-01-01T10:00:00Z','2030-01-01T12:00:00Z','payment_pending','customer_app',${amount},'INR','{}','confirm-test',0,0);
    INSERT INTO provider_work_orders VALUES ('WO1','B1','GROUP1','PRV1','Synthetic groomer','${providerModel}','${serviceCode}','2030-01-01T10:00:00Z','2030-01-01T12:00:00Z',1,'payment_pending','{}',0,0);
    INSERT INTO booking_payments VALUES ('P1','B1','C1',${amount},${dueNow},'INR','upi','prepaid','created','uat_sandbox','confirm-payment','{}',0,0);
  `);
  const amountPaise = Math.round(dueNow * 100);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.razorpay.com/v1/orders", "no other outbound network is allowed");
    const body = JSON.parse(init.body); assert.equal(body.amount, amountPaise); assert.equal(body.currency, "INR");
    return Response.json({ id: "order_confirmFixture", amount: body.amount, currency: "INR", status: "created" });
  });
  const order = await createBookingPaymentOrder(db, env, { bookingId: "B1", customerId: "C1", actorId: "C1" });
  assert.equal(order.connected, true, JSON.stringify(order));
  assert.equal(order.orderId, "order_confirmFixture");
  function payload(event, patch = {}) {
    const payment = { id: "pay_confirmFixture", entity: "payment", order_id: "order_confirmFixture", amount: amountPaise, currency: "INR",
      status: event === "payment.authorized" ? "authorized" : "captured", captured: event !== "payment.authorized",
      notes: { booking_id: "B1", payment_id: "P1", pawspace_environment: "sandbox" }, ...patch };
    const body = { entity: "event", account_id: "acc_synthetic", event, contains: ["payment"], created_at: 1800000000, payload: { payment: { entity: payment } } };
    if (event === "order.paid") { body.contains = ["order", "payment"]; body.payload.order = { entity: { id: "order_confirmFixture", entity: "order", amount: amountPaise, amount_paid: amountPaise, currency: "INR", status: "paid", notes: payment.notes } }; }
    return JSON.stringify(body);
  }
  async function deliver(event, eventId, raw = payload(event)) {
    const response = await webhook.POST(new Request(`${origin}/api/razorpay-webhook`, { method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-event-id": eventId, "x-razorpay-signature": sign(raw) }, body: raw }));
    return { status: response.status, body: await response.json() };
  }
  const booking = () => sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='B1'").get().status;
  const workOrder = () => sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id='B1'").get().status;
  return { sqlite, db, deliver, payload, booking, workOrder };
}

for (const captureType of ["payment.captured", "order.paid"]) {
  test(`${captureType} confirms a payment_pending grooming booking and releases the commission work order`, async t => {
    const w = await setup(t);
    assert.equal(w.booking(), "payment_pending"); assert.equal(w.workOrder(), "payment_pending");
    const capture = await w.deliver(captureType, `evt_confirm_${captureType}`);
    assert.equal(capture.status, 200, JSON.stringify(capture));
    assert.equal(capture.body.ok, true); assert.equal(capture.body.atomicCapture, true);
    assert.equal(capture.body.captureEffects, "SUCCEEDED", "post-commit effects must complete inline on the first delivery");
    assert.equal(w.booking(), "confirmed", "canonical booking must move to confirmed on verified capture");
    assert.equal(w.workOrder(), "awaiting_acceptance", "commission partner receives the job for acceptance");
    assert.equal(w.sqlite.prepare("SELECT status FROM booking_payments WHERE id='P1'").get().status, "captured");
    assert.equal(w.sqlite.prepare("SELECT state FROM payment_intents").get().state, "CAPTURED");
    const confirmed = w.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id='B1' AND event_type='booking_confirmed_after_verified_payment'").get();
    assert.equal(confirmed.n, 1, "exactly one confirmation timeline event");
    const outbox = w.sqlite.prepare("SELECT status FROM financial_outbox WHERE event_type='RAZORPAY_CAPTURE_POST_COMMIT'").get();
    assert.equal(outbox.status, "SUCCEEDED");
    // Replay is idempotent: the booking stays confirmed and no second confirmation event appears.
    const replay = await w.deliver(captureType, `evt_confirm_${captureType}`);
    assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
    assert.equal(w.booking(), "confirmed");
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id='B1' AND event_type='booking_confirmed_after_verified_payment'").get().n, 1);
  });
}

test("authorized then captured confirms a full-time work order as assigned", async t => {
  const w = await setup(t, { providerModel: "full_time" });
  const authorized = await w.deliver("payment.authorized", "evt_confirm_authorized");
  assert.equal(authorized.status, 200, JSON.stringify(authorized));
  assert.equal(w.booking(), "payment_pending", "authorization alone never confirms a booking");
  assert.equal(w.workOrder(), "payment_pending");
  const capture = await w.deliver("payment.captured", "evt_confirm_captured_after_auth");
  assert.equal(capture.status, 200, JSON.stringify(capture));
  assert.equal(w.booking(), "confirmed");
  assert.equal(w.workOrder(), "assigned");
});

for (const serviceCode of ["dog_training", "boarding", "pet_sitting"]) {
  test(`${serviceCode} payment_pending booking confirms on verified capture`, async t => {
    const w = await setup(t, { serviceCode });
    const capture = await w.deliver("payment.captured", `evt_confirm_${serviceCode}`);
    assert.equal(capture.status, 200, JSON.stringify(capture));
    assert.equal(w.booking(), "confirmed");
    assert.equal(w.workOrder(), "awaiting_acceptance");
  });
}

test("a split deposit confirms the booking once the amount due now is captured", async t => {
  const w = await setup(t, { serviceCode: "boarding", amount: 4000, dueNow: 2000 });
  const capture = await w.deliver("payment.captured", "evt_confirm_split");
  assert.equal(capture.status, 200, JSON.stringify(capture));
  assert.equal(w.booking(), "confirmed", "the deposit is the confirmation threshold; the balance stays on its own schedule");
  assert.equal(w.sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id='P1'").get().captured_amount, 2000);
});
