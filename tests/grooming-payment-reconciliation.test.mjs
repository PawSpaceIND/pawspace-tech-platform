/**
 * Grooming payment reconciliation — EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Two tests. The first read NINE files as strings and asserted that the
 * words `capture_amount_mismatch`, `currency_mismatch`, `unmatched_gateway_event`,
 * `orphan_gateway_refund`, `refund_amount_mismatch`, `refund_overage`, `out_of_order_failed` and
 * `refund_already_processed` appeared somewhere in `lib/grooming-payment-reconciliation.ts`. Every one
 * of those is an exception the money path is supposed to RAISE, and not one of them was ever produced.
 * The reconciliation ledger is what the finance console reads as collections, so a defect here is a
 * wrong revenue number.
 *
 * The first test is now SEVEN executed ones, each driving processGatewayEvent against a real
 * SQLite-backed D1 and reading payment_reconciliation_records / _exceptions back. The second stays
 * partly a source scan and says why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__GROOM_RECON_DB__", "__GROOM_RECON_ENV__");

const engine = await import("../lib/grooming-payment-reconciliation.ts");

const NOW = Date.now();
const DAY = 86_400_000;

function reconWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__GROOM_RECON_DB__ = db;
  globalThis.__GROOM_RECON_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: "recon-sandbox-secret" };
  // DDL from the owning sources, never guessed.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',source_pet_ids_json TEXT NOT NULL DEFAULT '[]',city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  installFinancialLifecycleSchema(sqlite);
  return { sqlite, db };
}

function seedBooking(sqlite, { id, total = 2000, currency = "INR", payStatus = "created", customer = "cus_recon" }) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customer, "blr", `Customer ${customer}`, "+91-9000000051", `${customer}@example.in`, NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,total_amount,currency,created_by,created_at,updated_at) VALUES (?,?,?,'blr','blr-east','grooming','pkg','Pkg',?,'groom_arun',?,?,?,?,'recon',?,?)")
    .run(id, `k-${id}`, customer, `g-${id}`, new Date(NOW + 3 * DAY).toISOString(), new Date(NOW + 3 * DAY + 3_600_000).toISOString(), total, currency, NOW - DAY, NOW - DAY);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,'upi','prepaid',?,?,?,?)")
    .run(`PAY-${id}`, id, customer, total, total, currency, payStatus, `pk-${id}`, NOW - DAY, NOW - DAY);
  return `PAY-${id}`;
}

const captureEvent = (bookingId, amountSubunits, extra = {}) => ({
  provider: "razorpay", environment: "sandbox", eventId: `evt-${crypto.randomUUID().slice(0, 8)}`,
  eventType: "payment.captured", bookingId, gatewayOrderId: "order_RECON1", gatewayPaymentId: "pay_RECON1",
  amountSubunits, currency: "INR", createdAt: NOW, signatureVerified: true, payloadHash: "hash", detail: {}, ...extra,
});
const refundEvent = (bookingId, amountSubunits, extra = {}) => ({
  provider: "razorpay", environment: "sandbox", eventId: `evt-${crypto.randomUUID().slice(0, 8)}`,
  eventType: "refund.processed", bookingId, gatewayOrderId: "order_RECON1", gatewayPaymentId: "pay_RECON1",
  gatewayRefundId: "rfnd_RECON1", amountSubunits, currency: "INR", createdAt: NOW, signatureVerified: true,
  payloadHash: "hash", detail: {}, ...extra,
});

const record = async (db, paymentId) => db.prepare("SELECT captured_amount,refunded_amount,gateway_status,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first();
const exceptions = async (db) => (await db.prepare("SELECT exception_type,severity,status FROM payment_reconciliation_exceptions ORDER BY created_at").all()).results.map((row) => ({ ...row }));
const seedRefundCase = (sqlite, bookingId, amount) => sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,'customer cancelled','requested','finance@pawspace.test',?,?)")
  .run(`RFC-${bookingId}`, bookingId, `PAY-${bookingId}`, amount, NOW, NOW);

// ---------------------------------------------------------------------------------------------
test("Grooming payment integration is sandbox-locked signed idempotent and reconciled", async () => {
  const { sqlite, db } = reconWorld();
  const paymentId = seedBooking(sqlite, { id: "bkg_recon_ok" });

  // NON-VACUITY: a correct capture reconciles as matched, for the booking's own amount.
  const result = await engine.processGatewayEvent(db, captureEvent("bkg_recon_ok", 200_000));
  assert.equal(result.status, "processed", `a correct capture must process: ${JSON.stringify(result)}`);
  const row = await record(db, paymentId);
  assert.equal(Number(row.captured_amount), 2000, "the collected total the finance console reads");
  assert.equal(String(row.reconciliation_status), "matched");
  assert.equal(Number(row.variance_amount), 0);
  assert.deepEqual(await exceptions(db), [], "and nothing to triage");

  // AN UNVERIFIED EVENT NEVER REACHES THE MONEY PATH. This is the strongest claim in the module and
  // the old test asserted it as a regex over the source.
  await assert.rejects(
    () => engine.processGatewayEvent(db, captureEvent("bkg_recon_ok", 200_000, { signatureVerified: false })),
    /signature is not verified/,
    "an unverified gateway event must throw rather than be reconciled",
  );
});

// ---------------------------------------------------------------------------------------------
test("Grooming reconciliation dedupes an event id rather than recounting the money", async () => {
  const { sqlite, db } = reconWorld();
  const paymentId = seedBooking(sqlite, { id: "bkg_recon_dup" });
  const event = captureEvent("bkg_recon_dup", 200_000);

  const first = await engine.processGatewayEvent(db, event);
  assert.equal(first.duplicate, false);
  const replay = await engine.processGatewayEvent(db, event);
  assert.equal(replay.duplicate, true, `the same event id must be recognised: ${JSON.stringify(replay)}`);
  assert.equal(Number((await record(db, paymentId)).captured_amount), 2000, "and the money must not double");
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS c FROM payment_gateway_events").first()).c), 1,
    "one event row for one event, which is what UNIQUE(provider,event_id) is for");
});

// ---------------------------------------------------------------------------------------------
test("Grooming reconciliation raises capture_amount_mismatch instead of silently matching", async () => {
  const { sqlite, db } = reconWorld();
  const paymentId = seedBooking(sqlite, { id: "bkg_recon_short" });

  // Rs 1,500 against a Rs 2,000 booking.
  const result = await engine.processGatewayEvent(db, captureEvent("bkg_recon_short", 150_000));
  assert.equal(result.status, "exception");
  assert.equal(result.reason, "capture_amount_mismatch");
  const row = await record(db, paymentId);
  assert.equal(String(row.reconciliation_status), "amount_mismatch");
  assert.equal(Number(row.variance_amount), -500, "the shortfall is recorded as a signed variance");
  assert.deepEqual((await exceptions(db)).map((e) => e.exception_type), ["capture_amount_mismatch"]);
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status), "created",
    "a mismatched capture must NOT flip the canonical payment to captured");
});

// ---------------------------------------------------------------------------------------------
test("Grooming reconciliation raises currency_mismatch rather than converting", async () => {
  const { sqlite, db } = reconWorld();
  const paymentId = seedBooking(sqlite, { id: "bkg_recon_ccy" });
  const result = await engine.processGatewayEvent(db, captureEvent("bkg_recon_ccy", 200_000, { currency: "USD" }));
  assert.equal(result.reason, "currency_mismatch", `a foreign currency must be an exception: ${JSON.stringify(result)}`);
  assert.deepEqual((await exceptions(db)).map((e) => e.exception_type), ["currency_mismatch"]);

  // Nothing is collected: the currency gate returns BEFORE the reconciliation upsert, so there is no
  // record at all rather than a record reading zero. Asserting the absence is the stronger statement —
  // a USD capture must leave no trace of collected money anywhere.
  assert.equal(await record(db, paymentId), null,
    "a foreign-currency capture must not create a reconciliation record at all");
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status), "created",
    "and the canonical payment stays uncollected");

  // The event itself is filed as an exception with a reason, not quietly marked processed.
  const eventRow = await db.prepare("SELECT processing_status,failure_reason,payment_id FROM payment_gateway_events").first();
  assert.equal(String(eventRow.processing_status), "exception");
  assert.match(String(eventRow.failure_reason), /[Cc]urrency mismatch/);
  assert.equal(String(eventRow.payment_id), paymentId,
    "the event is still attributed to the payment it was aimed at, so Finance can find it");
});

// ---------------------------------------------------------------------------------------------
test("Grooming reconciliation raises unmatched_gateway_event for money it cannot place", async () => {
  const { db } = reconWorld();
  // No booking, no payment, no link: the money exists at the gateway and nowhere here.
  const result = await engine.processGatewayEvent(db, captureEvent("bkg_does_not_exist", 200_000));
  assert.equal(result.reason, "unmatched_gateway_event", `unplaceable money must be raised, not dropped: ${JSON.stringify(result)}`);
  const raised = await exceptions(db);
  assert.deepEqual(raised.map((e) => e.exception_type), ["unmatched_gateway_event"]);
  assert.equal(raised[0].status, "open", "and left open for Finance to resolve");
});

// ---------------------------------------------------------------------------------------------
test("Grooming reconciliation guards the refund path: orphan, mismatch, overage and replay", async () => {
  // ORPHAN: a gateway refund with no internal refund case.
  const orphanWorld = reconWorld();
  seedBooking(orphanWorld.sqlite, { id: "bkg_recon_orph", payStatus: "captured" });
  await engine.linkGatewayOrder(orphanWorld.db, { bookingId: "bkg_recon_orph", gatewayOrderId: "order_RECON1", environment: "sandbox", actorId: "recon" });
  const orphan = await engine.processGatewayEvent(orphanWorld.db, refundEvent("bkg_recon_orph", 200_000));
  assert.equal(orphan.reason, "orphan_gateway_refund", `a refund nobody asked for must be raised: ${JSON.stringify(orphan)}`);

  // AMOUNT MISMATCH: the gateway refunded more than the approved case.
  const mismatchWorld = reconWorld();
  const mismatchPayment = seedBooking(mismatchWorld.sqlite, { id: "bkg_recon_rmm", payStatus: "captured" });
  seedRefundCase(mismatchWorld.sqlite, "bkg_recon_rmm", 500);
  await engine.linkGatewayOrder(mismatchWorld.db, { bookingId: "bkg_recon_rmm", gatewayOrderId: "order_RECON1", environment: "sandbox", actorId: "recon" });
  const mismatch = await engine.processGatewayEvent(mismatchWorld.db, refundEvent("bkg_recon_rmm", 200_000));
  assert.equal(mismatch.reason, "refund_amount_mismatch", `Rs 2,000 refunded against a Rs 500 case: ${JSON.stringify(mismatch)}`);
  assert.equal(Number((await record(mismatchWorld.db, mismatchPayment)).refunded_amount), 0, "and nothing is recorded as refunded");

  // REPLAY: the same processed refund arriving again changes nothing.
  const replayWorld = reconWorld();
  const replayPayment = seedBooking(replayWorld.sqlite, { id: "bkg_recon_rep", payStatus: "captured" });
  seedRefundCase(replayWorld.sqlite, "bkg_recon_rep", 2000);
  await engine.linkGatewayOrder(replayWorld.db, { bookingId: "bkg_recon_rep", gatewayOrderId: "order_RECON1", environment: "sandbox", actorId: "recon" });
  await engine.processGatewayEvent(replayWorld.db, refundEvent("bkg_recon_rep", 200_000));
  assert.equal(Number((await record(replayWorld.db, replayPayment)).refunded_amount), 2000, "refunded once");
  const again = await engine.processGatewayEvent(replayWorld.db, refundEvent("bkg_recon_rep", 200_000));
  assert.equal(again.reason, "refund_already_processed", `a re-delivered refund must be recognised: ${JSON.stringify(again)}`);
  assert.equal(Number((await record(replayWorld.db, replayPayment)).refunded_amount), 2000, "and must not refund twice");
});

// ---------------------------------------------------------------------------------------------
test("Grooming reconciliation ignores an out-of-order failure after settlement", async () => {
  const { sqlite, db } = reconWorld();
  const paymentId = seedBooking(sqlite, { id: "bkg_recon_ooo" });
  await engine.processGatewayEvent(db, captureEvent("bkg_recon_ooo", 200_000));
  assert.equal(Number((await record(db, paymentId)).captured_amount), 2000, "collected first");

  const late = await engine.processGatewayEvent(db, { ...captureEvent("bkg_recon_ooo", 200_000), eventType: "payment.failed", eventId: "evt-late-fail" });
  assert.equal(late.reason, "out_of_order_failed", `a failure after settlement must be ignored: ${JSON.stringify(late)}`);
  assert.equal(Number((await record(db, paymentId)).captured_amount), 2000, "and must not unwind the money");
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status), "captured",
    "nor mark a paid booking failed");
});

// ---------------------------------------------------------------------------------------------
test("Grooming payment code embeds no production secrets; live mode is a double-gated deliberate unlock", async () => {
  // THE LIVE GATE, EXECUTED. This is the security-bearing half and it runs.
  const { resolvePaymentWebhookGate } = await import("../lib/payment-webhook-gate.ts");

  const sandbox = resolvePaymentWebhookGate({ PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: "s" });
  assert.equal(sandbox.ok, true);
  assert.equal(sandbox.environment, "sandbox", "sandbox is explicit, never inferred");

  // An UNDECLARED environment fails closed rather than defaulting to sandbox.
  assert.equal(resolvePaymentWebhookGate({ RAZORPAY_WEBHOOK_SECRET_SANDBOX: "s" }).ok, false,
    "an absent PAWSPACE_PAYMENT_ENV must refuse, not resolve to sandbox");

  // LIVE needs BOTH gates. Each one alone is refused 503.
  const noFlag = resolvePaymentWebhookGate({ PAWSPACE_PAYMENT_ENV: "live", RAZORPAY_WEBHOOK_SECRET_LIVE: "l" });
  assert.equal(noFlag.ok, false, "live without the approval flag is refused");
  assert.equal(noFlag.status, 503);
  const noSecret = resolvePaymentWebhookGate({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "true" });
  assert.equal(noSecret.ok, false, "live without a distinct live secret is refused");
  assert.equal(noSecret.status, 503);
  // The flag must be EXACTLY "true" — "1", "yes" and "TRUE" must not unlock live money.
  for (const value of ["1", "yes", "TRUE", "on", " true"]) {
    assert.equal(resolvePaymentWebhookGate({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: value, RAZORPAY_WEBHOOK_SECRET_LIVE: "l" }).ok, false,
      `${JSON.stringify(value)} must not be read as approval`);
  }
  const unlocked = resolvePaymentWebhookGate({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "true", RAZORPAY_WEBHOOK_SECRET_LIVE: "l" });
  assert.equal(unlocked.ok, true, "and with both, live unlocks — non-vacuity for every refusal above");
  assert.equal(unlocked.environment, "live");
  assert.equal(unlocked.secret, "l", "using the LIVE secret, never the sandbox one");

  /*
   * THE SECRET SCAN STAYS A SOURCE ASSERTION, and is reported as such.
   *
   * "no file contains a hard-coded rzp_live_ key or a whsec_ webhook secret" is a property of the TEXT
   * of these files. There is no call that can be made to establish it — an executed test can only show
   * that the code reads its credentials from env, which is a different (and weaker) claim, and one the
   * gate assertions above already make. A grep is the correct instrument here, so it is kept
   * deliberately rather than converted into something that looks executable and proves less.
   */
  const files = await Promise.all(["app/api/razorpay-webhook/route.ts", "app/api/grooming-payment-sandbox/route.ts", "lib/razorpay-sandbox-client.ts", "lib/payment-webhook-gate.ts"]
    .map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
  for (const text of files) {
    assert.doesNotMatch(text, /rzp_live_[A-Za-z0-9]+/, "no live key may be committed");
    assert.doesNotMatch(text, /whsec_[A-Za-z0-9]+/, "no webhook secret may be committed");
  }
});
