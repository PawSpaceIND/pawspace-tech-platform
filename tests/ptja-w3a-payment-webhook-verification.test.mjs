/**
 * WAVE 3 TIER A - adversarial verification of the two PAYMENT refutations. [PTJA-W3A]
 *
 * WHY THIS FILE EXISTS. ptja/PTJA-FINDINGS.json records Wave 3 as NOT PERFORMED: 125 of 129 verifier
 * agents died on session limits, so every Wave 2 conclusion is hunter-reproduced and NEVER independently
 * confirmed. Nine of those conclusions are REFUTATIONS - findings closed with "this is actually safe" -
 * and a check of the ledgers shows all nine name ZERO executable tests. A refutation with no test is an
 * opinion. Two of them guard money:
 *
 *   W2-07-PAY-R01  "signature is verified before any state change, and an absent or whitespace-only
 *                   signing secret fails closed"
 *   W2-07-PAY-R02  "an equal event id replayed as a DIFFERENT event type does not re-run the money path"
 *
 * This is the audit's own defect class - unknown or absent treated as satisfied - pointed at the audit's
 * own conclusions. Each case below ATTACKS the boundary and asserts both the refusal AND that no durable
 * state was written; the refusal status alone is not the claim. Non-vacuity controls prove the harness
 * can see a success, so "everything is refused" cannot pass by accident.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_PAY_DB__", "__W3A_PAY_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const s of statements) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const SANDBOX_SECRET = "w3a-sandbox-secret";
const NOW = Date.now();
const DAY = 86_400_000;
let sqlite;

// DDL copied verbatim from the owning sources, as tests/money-hardening.test.mjs does. Never guessed.
function baseTables() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

function seedBooking({ id, customer = "cus_w3a", total = 2000, dueNow = 2000, status = "confirmed", payStatus = "created" }) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customer, "blr", `Customer ${customer}`, "+91-9000000031", `${customer}@example.in`, NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','grooming','pkg','Pkg',?,'prov_1',?,?,?,'customer_app',?,'INR','{}','w3a',?,?)")
    .run(id, `k-${id}`, customer, `g-${id}`, new Date(NOW + 5 * DAY).toISOString(), new Date(NOW + 5 * DAY + 3_600_000).toISOString(), status, total, NOW - DAY, NOW - DAY);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi','prepaid',?,?,?,?)")
    .run(`PAY-${id}`, id, customer, total, dueNow, payStatus, `pk-${id}`, NOW - DAY, NOW - DAY);
}

/**
 * An INTERNAL refund case. A gateway refund with no case is correctly an `orphan_gateway_refund`
 * exception, so without this the refund path can never reach the money write - and a replay test run
 * against that state passes while proving nothing. A2-01 seeds one for exactly that reason.
 */
function seedRefundCase(bookingId, amount = 2000) {
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,'requested','ops@pawspace.test',?,?)")
    .run(`RFC-${bookingId}`, bookingId, `PAY-${bookingId}`, amount, "customer cancelled", NOW - 3_600_000, NOW - 3_600_000);
}

function freshDb(env = { RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET }) {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__W3A_PAY_DB__ = makeD1(sqlite);
  globalThis.__W3A_PAY_ENV__ = env;
  baseTables();
  installFinancialLifecycleSchema(sqlite);
}

const webhookRoute = await import("../app/api/razorpay-webhook/route.ts");
// The REAL order-linking function, not a hand-rolled row. A refund event carries its booking only on
// the refund entity, and extract() reads notes from the payment/order/payment_link entities - so a
// refund resolves through payment_gateway_links, which this is what writes in production. A refund
// arriving with no link row becomes an `unmatched_gateway_event` ops exception, which is the safe
// direction and is why the first draft of A2-03 read refunded_amount 0.
const { linkGatewayOrder } = await import("../lib/grooming-payment-reconciliation.ts");

const hex = (bytes) => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
async function sign(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

/** Posts a raw body with whatever signature/event-id headers the attack calls for. */
async function post(raw, { signature, eventId = "evt_w3a_1", omitSignature = false, omitEventId = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (!omitSignature && signature !== undefined) headers["x-razorpay-signature"] = signature;
  if (!omitEventId) headers["x-razorpay-event-id"] = eventId;
  const response = await webhookRoute.POST(new Request("http://localhost/api/razorpay-webhook", { method: "POST", headers, body: raw }));
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

/** Signs correctly for the sandbox secret, then posts. */
async function postSigned(payload, { secret = SANDBOX_SECRET, eventId = "evt_w3a_1" } = {}) {
  const raw = JSON.stringify(payload);
  return post(raw, { signature: await sign(secret, raw), eventId });
}

const captureEvent = (bookingId, amountSubunits, paymentId = "pay_W3A1") => ({
  event: "payment.captured", created_at: Math.floor(NOW / 1000),
  payload: { payment: { entity: { id: paymentId, order_id: "order_W3A1", amount: amountSubunits, currency: "INR", notes: { booking_id: bookingId } } } },
});
const refundEvent = (bookingId, amountSubunits, refundId = "rfnd_W3A1") => ({
  event: "refund.processed", created_at: Math.floor(NOW / 1000),
  payload: { refund: { entity: { id: refundId, payment_id: "pay_W3A1", order_id: "order_W3A1", amount: amountSubunits, currency: "INR", notes: { booking_id: bookingId } } } },
});

/** Every durable trace the receiver could leave. A refusal must leave all of them empty. */
function durableState() {
  const count = (table) => {
    try { return Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c); }
    catch { return 0; } // table not created yet is itself proof nothing was written
  };
  return {
    events: count("payment_gateway_events"),
    reconciliation: count("payment_reconciliation_records"),
    exceptions: count("payment_exceptions"),
  };
}
const NOTHING = { events: 0, reconciliation: 0, exceptions: 0 };

// ---------------------------------------------------------------------------------------------
// W2-07-PAY-R01: signature verified before any state change; absent/whitespace secret fails closed
// ---------------------------------------------------------------------------------------------

test("A1-09 (non-vacuity): a correctly signed capture IS processed and does write state", async () => {
  // FIRST, not last. If this fails, every refusal case below is vacuous and proves nothing.
  freshDb();
  seedBooking({ id: "bkg_w3a_ok", total: 2000, dueNow: 2000 });
  const res = await postSigned(captureEvent("bkg_w3a_ok", 200_000), { eventId: "evt_ok" });
  assert.equal(res.status, 200, `a valid signed capture must be accepted, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(durableState().events >= 1, "a processed capture must leave a gateway event row");
});

test("A1-01: an UNSIGNED capture is refused and writes nothing", async () => {
  freshDb();
  seedBooking({ id: "bkg_w3a_1", total: 2000, dueNow: 2000 });
  const res = await post(JSON.stringify(captureEvent("bkg_w3a_1", 200_000)), { omitSignature: true });
  assert.equal(res.status, 400, "an absent signature header must be refused");
  assert.deepEqual(durableState(), NOTHING, "an unsigned capture must not reach any state change");
});

test("A1-02: a WRONGLY signed capture is refused 401 and writes nothing", async () => {
  freshDb();
  seedBooking({ id: "bkg_w3a_2", total: 2000, dueNow: 2000 });
  const raw = JSON.stringify(captureEvent("bkg_w3a_2", 200_000));
  const res = await post(raw, { signature: await sign("attacker-guessed-secret", raw) });
  assert.equal(res.status, 401, "a signature from the wrong secret must be refused");
  assert.deepEqual(durableState(), NOTHING, "a wrongly signed capture must not reach any state change");
});

test("A1-03: a signature valid for a DIFFERENT body does not carry over to a swapped body", async () => {
  // The classic sign-then-swap: attacker replays a real signature against a body they control.
  freshDb();
  seedBooking({ id: "bkg_w3a_3", total: 2000, dueNow: 2000 });
  const honest = JSON.stringify(captureEvent("bkg_w3a_3", 100));      // Rs 1
  const tampered = JSON.stringify(captureEvent("bkg_w3a_3", 200_000)); // Rs 2000
  const res = await post(tampered, { signature: await sign(SANDBOX_SECRET, honest) });
  assert.equal(res.status, 401, "a signature over a different body must not validate");
  assert.deepEqual(durableState(), NOTHING, "a body swap must not reach any state change");
});

test("A1-04: with NO webhook secret configured the receiver refuses 503 and writes nothing", async () => {
  freshDb({});
  seedBooking({ id: "bkg_w3a_4", total: 2000, dueNow: 2000 });
  const res = await postSigned(captureEvent("bkg_w3a_4", 200_000), { eventId: "evt_nosecret" });
  assert.equal(res.status, 503, "an unconfigured secret must fail closed, never open");
  assert.deepEqual(durableState(), NOTHING, "an unconfigured receiver must not process anything");
});

test("A1-05: a WHITESPACE-ONLY webhook secret fails closed, not open", async () => {
  // The named claim. A secret of "   " must not be treated as configured, and must never validate a
  // signature computed over the same whitespace string.
  freshDb({ RAZORPAY_WEBHOOK_SECRET_SANDBOX: "   " });
  seedBooking({ id: "bkg_w3a_5", total: 2000, dueNow: 2000 });
  const res = await postSigned(captureEvent("bkg_w3a_5", 200_000), { secret: "   ", eventId: "evt_ws" });
  assert.equal(res.status, 503, "a whitespace-only secret must read as absent");
  assert.deepEqual(durableState(), NOTHING, "a whitespace-secret receiver must not process anything");
});

test("A1-06: live mode without the approval flag refuses, whatever secrets exist", async () => {
  freshDb({ PAWSPACE_PAYMENT_ENV: "live", RAZORPAY_WEBHOOK_SECRET_LIVE: "live-secret", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET });
  seedBooking({ id: "bkg_w3a_6", total: 2000, dueNow: 2000 });
  const res = await postSigned(captureEvent("bkg_w3a_6", 200_000), { secret: "live-secret", eventId: "evt_unapproved" });
  assert.equal(res.status, 503, "live must stay locked until deliberately approved");
  assert.deepEqual(durableState(), NOTHING, "an unapproved live receiver must not process anything");
});

test("A1-07: live mode approved but with no live secret refuses rather than falling back", async () => {
  freshDb({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "true", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET });
  seedBooking({ id: "bkg_w3a_7", total: 2000, dueNow: 2000 });
  const res = await postSigned(captureEvent("bkg_w3a_7", 200_000), { eventId: "evt_nolive" });
  assert.equal(res.status, 503, "approved live with no live secret must refuse");
  assert.deepEqual(durableState(), NOTHING, "it must not process anything");
});

test("A1-08: approved live mode does NOT accept a payload signed with the sandbox secret", async () => {
  // Credential separation: unlocking live must never make a sandbox-signed event authentic.
  freshDb({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "true", RAZORPAY_WEBHOOK_SECRET_LIVE: "live-secret", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET });
  seedBooking({ id: "bkg_w3a_8", total: 2000, dueNow: 2000 });
  const res = await postSigned(captureEvent("bkg_w3a_8", 200_000), { secret: SANDBOX_SECRET, eventId: "evt_crossenv" });
  assert.equal(res.status, 401, "a sandbox-signed event must not authenticate against the live secret");
  assert.deepEqual(durableState(), NOTHING, "a cross-environment signature must not reach any state change");
});

test("A1-10: a truncated signature is refused rather than prefix-matched", async () => {
  freshDb();
  seedBooking({ id: "bkg_w3a_10", total: 2000, dueNow: 2000 });
  const raw = JSON.stringify(captureEvent("bkg_w3a_10", 200_000));
  const full = await sign(SANDBOX_SECRET, raw);
  const res = await post(raw, { signature: full.slice(0, 32), eventId: "evt_trunc" });
  assert.equal(res.status, 401, "a prefix of the correct signature must not validate");
  assert.deepEqual(durableState(), NOTHING, "a truncated signature must not reach any state change");
});

test("A1-11: an absent event id is refused before any state change", async () => {
  freshDb();
  seedBooking({ id: "bkg_w3a_11", total: 2000, dueNow: 2000 });
  const raw = JSON.stringify(captureEvent("bkg_w3a_11", 200_000));
  const res = await post(raw, { signature: await sign(SANDBOX_SECRET, raw), omitEventId: true });
  assert.equal(res.status, 400, "an event with no id must be refused");
  assert.deepEqual(durableState(), NOTHING, "an id-less event must not reach any state change");
});

// ---------------------------------------------------------------------------------------------
// W2-07-PAY-R02: an equal event id replayed as a DIFFERENT event type does not re-run the money path
// ---------------------------------------------------------------------------------------------

test("A2-01: the same event id replayed as a REFUND does not run the refund money path", async () => {
  freshDb();
  seedBooking({ id: "bkg_w3a_r1", total: 2000, dueNow: 2000 });
  // Seeded so the refund would GENUINELY land if the replay guard let it through. Without this the
  // refund dies as an orphan anyway and this test passes for the wrong reason - a shadowed assertion.
  seedRefundCase("bkg_w3a_r1", 2000);
  await linkGatewayOrder(globalThis.__W3A_PAY_DB__, { bookingId: "bkg_w3a_r1", gatewayOrderId: "order_W3A1", environment: "sandbox", actorId: "w3a" });
  const first = await postSigned(captureEvent("bkg_w3a_r1", 200_000), { eventId: "evt_shared" });
  assert.equal(first.status, 200, "the honest capture must be accepted first");
  const afterCapture = sqlite.prepare("SELECT captured_amount,refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get("bkg_w3a_r1");

  // Same id, different type, correctly signed - the attack.
  const replay = await postSigned(refundEvent("bkg_w3a_r1", 200_000), { eventId: "evt_shared" });
  assert.equal(replay.status, 409, "an event id replayed with a different signed payload must fail closed");
  assert.equal(replay.body?.error, "Razorpay event ID payload mismatch");

  const afterReplay = sqlite.prepare("SELECT captured_amount,refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get("bkg_w3a_r1");
  assert.deepEqual(afterReplay, afterCapture, "a replayed id under a new event type must not move any money figure");
  assert.equal(Number(afterReplay.refunded_amount || 0), 0, "no refund may be recorded from a replayed capture id");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM payment_gateway_events WHERE event_id=?").get("evt_shared").c), 1,
    "the replay must not create a second event row under the same id");
});

test("A2-02: the same event id replayed as the SAME type is an idempotent no-op", async () => {
  freshDb();
  seedBooking({ id: "bkg_w3a_r2", total: 2000, dueNow: 2000 });
  await postSigned(captureEvent("bkg_w3a_r2", 200_000), { eventId: "evt_same" });
  const before = sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE booking_id=?").get("bkg_w3a_r2");
  const again = await postSigned(captureEvent("bkg_w3a_r2", 200_000), { eventId: "evt_same" });
  assert.equal(again.body?.duplicate, true, "a byte-identical redelivery is a duplicate");
  const after = sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE booking_id=?").get("bkg_w3a_r2");
  assert.deepEqual(after, before, "a redelivery must not recount the capture");
});

test("A2-03 (non-vacuity): a refund under a FRESH event id does run the refund path", async () => {
  // Without this, A2-01 would pass on a receiver that simply ignores every refund.
  freshDb();
  seedBooking({ id: "bkg_w3a_r3", total: 2000, dueNow: 2000 });
  seedRefundCase("bkg_w3a_r3", 2000);
  await linkGatewayOrder(globalThis.__W3A_PAY_DB__, { bookingId: "bkg_w3a_r3", gatewayOrderId: "order_W3A1", environment: "sandbox", actorId: "w3a" });
  await postSigned(captureEvent("bkg_w3a_r3", 200_000), { eventId: "evt_cap_r3" });
  const res = await postSigned(refundEvent("bkg_w3a_r3", 200_000), { eventId: "evt_ref_r3" });
  assert.equal(res.body?.duplicate, false, "a fresh refund id is not a duplicate");
  const row = sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get("bkg_w3a_r3");
  assert.ok(Number(row.refunded_amount) > 0, `a genuine refund must be recorded, got ${JSON.stringify(row)}`);
});
