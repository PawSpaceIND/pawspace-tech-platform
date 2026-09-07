/**
 * ADVERSARIAL PAYMENT WEBHOOK — replay, out-of-order delivery, malformed bodies and signature forgery.
 *
 * WHAT tests/ptja-w3a-payment-webhook-verification.test.mjs ALREADY PROVES, and this file does not
 * repeat: an unsigned body is refused, a wrongly signed body is refused 401, a signature valid for a
 * different body does not carry over, an absent or whitespace-only secret fails closed 503, live mode is
 * double-gated, a truncated signature is not prefix-matched, an absent event id is refused, and the SAME
 * event id replayed — as the same type or as a different one — does not re-run the money path.
 *
 * WHAT THIS FILE ATTACKS INSTEAD. Three things that verification of the body cannot answer:
 *
 *   1. THE DEDUPE KEY WAS NOT SIGNED. The HMAC covers the request body. The replay key was the
 *      `x-razorpay-event-id` HEADER, and it is what both idempotency layers key on:
 *      gateway_webhook_events UNIQUE(provider,event_id) and payment_gateway_events
 *      UNIQUE(provider,event_id). So anyone holding one captured (body, signature) pair could mint
 *      unlimited "new" events from it by changing a header the signature does not cover. Every
 *      event-id-based replay test in the existing suite reuses the same id and therefore never
 *      exercises this. WH-03 and WH-04 do.
 *
 *      CLOSED by acceptRazorpayWebhook recognising a body it has already accepted, via the digest of
 *      the signature-verified payload, scoped to provider + environment. WH-03 asserts one signed body
 *      is one event whatever the header says; WH-16 asserts the digest lookup does not mask the
 *      event-id/payload binding underneath it; WH-16b asserts the environment scoping.
 *
 *   2. ORDERING. A gateway does not promise order, and an attacker holding old signed bodies chooses it.
 *      An authorization arriving after settlement, a failure after a capture, a refund failure after a
 *      processed refund — each would, if applied, rewrite a settled financial fact.
 *
 *   3. AGE — AND WHY THERE IS DELIBERATELY NO FRESHNESS WINDOW. An earlier revision of this receiver
 *      refused any signed body whose own created_at was more than five minutes old. It closed the replay
 *      exposure and it was the wrong instrument: Razorpay retries a failed delivery for up to 24 hours,
 *      so one 500 on our side during a capture would have turned every retry into a 400 and lost the
 *      money event permanently. The replay and the retry are the SAME observable case — a byte-identical
 *      body arriving again — so a clock cannot separate them without getting one of them wrong.
 *      Identity can, and does. WH-03b is the test no timestamp window passes: a 90-day-old body under a
 *      fresh header id, which must be acknowledged rather than dropped.
 *
 * EVERY REFUSAL IS ASSERTED TWICE: the status, and that no durable state was written. A status alone is
 * not the claim — the failure mode being hunted is a receiver that answers 4xx and writes anyway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__ADV_WH_DB__", "__ADV_WH_ENV__");

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
    batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const SANDBOX_SECRET = "adv-webhook-sandbox-secret";
const NOW = Date.now();
const DAY = 86_400_000;
let sqlite;
let db;

// DDL copied verbatim from the owning sources, never guessed.
function baseTables() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

function seedBooking({ id, customer = "cus_adv", total = 2000, dueNow = 2000, payStatus = "created" }) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customer, "blr", `Customer ${customer}`, "+91-9000000041", `${customer}@example.in`, NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','grooming','pkg','Pkg',?,'prov_1',?,?,'confirmed','customer_app',?,'INR','{}','adv',?,?)")
    .run(id, `k-${id}`, customer, `g-${id}`, new Date(NOW + 5 * DAY).toISOString(), new Date(NOW + 5 * DAY + 3_600_000).toISOString(), total, NOW - DAY, NOW - DAY);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi','prepaid',?,?,?,?)")
    .run(`PAY-${id}`, id, customer, total, dueNow, payStatus, `pk-${id}`, NOW - DAY, NOW - DAY);
}

/** An INTERNAL refund case. Without one a gateway refund is correctly an orphan and never reaches money. */
function seedRefundCase(bookingId, amount = 2000) {
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,'requested','ops@pawspace.test',?,?)")
    .run(`RFC-${bookingId}`, bookingId, `PAY-${bookingId}`, amount, "customer cancelled", NOW - 3_600_000, NOW - 3_600_000);
}

// PAWSPACE_PAYMENT_ENV is declared EXPLICITLY. lib/payment-environment.ts parses it fail-closed and
// raises PaymentEnvironmentConfigurationError when it is absent, so an omitted declaration resolves the
// gate to 503 rather than defaulting to sandbox — every webhook test in the repo names it for that
// reason.
function freshDb(env = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET }) {
  sqlite = new DatabaseSync(":memory:");
  db = makeD1(sqlite);
  globalThis.__ADV_WH_DB__ = db;
  globalThis.__ADV_WH_ENV__ = env;
  baseTables();
  installFinancialLifecycleSchema(sqlite);
}

const webhookRoute = await import("../app/api/razorpay-webhook/route.ts");
// The REAL order-linking function, so a refund resolves through payment_gateway_links exactly as it
// does in production rather than through a hand-rolled row.
const { linkGatewayOrder } = await import("../lib/grooming-payment-reconciliation.ts");

const hex = (bytes) => Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
async function sign(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

/** Posts an exact raw body with exactly the headers the attack calls for. */
async function post(raw, { signature, eventId = "evt_adv_1", omitSignature = false, omitEventId = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (!omitSignature && signature !== undefined) headers["x-razorpay-signature"] = signature;
  if (!omitEventId && eventId !== undefined) headers["x-razorpay-event-id"] = eventId;
  const response = await webhookRoute.POST(new Request("http://localhost/api/razorpay-webhook", { method: "POST", headers, body: raw }));
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

/** Signs the exact bytes that will be sent, then posts them. The honest case. */
async function postSigned(payload, { secret = SANDBOX_SECRET, eventId = "evt_adv_1" } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return post(raw, { signature: await sign(secret, raw), eventId });
}

const captureEvent = (bookingId, amountSubunits, { paymentId = "pay_ADV1", orderId = "order_ADV1", createdAt = Math.floor(NOW / 1000) } = {}) => ({
  event: "payment.captured", created_at: createdAt,
  payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountSubunits, currency: "INR", notes: { booking_id: bookingId } } } },
});
const authorizedEvent = (bookingId, amountSubunits) => ({
  event: "payment.authorized", created_at: Math.floor(NOW / 1000),
  payload: { payment: { entity: { id: "pay_ADV1", order_id: "order_ADV1", amount: amountSubunits, currency: "INR", notes: { booking_id: bookingId } } } },
});
const failedEvent = (bookingId, amountSubunits) => ({
  event: "payment.failed", created_at: Math.floor(NOW / 1000),
  payload: { payment: { entity: { id: "pay_ADV1", order_id: "order_ADV1", amount: amountSubunits, currency: "INR", notes: { booking_id: bookingId } } } },
});
const refundEvent = (bookingId, amountSubunits, { refundId = "rfnd_ADV1", type = "refund.processed" } = {}) => ({
  event: type, created_at: Math.floor(NOW / 1000),
  payload: { refund: { entity: { id: refundId, payment_id: "pay_ADV1", order_id: "order_ADV1", amount: amountSubunits, currency: "INR", notes: { booking_id: bookingId } } } },
});

// Returns null when the reconciliation table does not exist AT ALL — which is itself the strongest
// form of "no money moved", because ensurePaymentReconciliationTables only runs once an event reaches
// processGatewayEvent. A refusal upstream of that leaves no table, and a helper that threw there would
// report a working guard as a broken test.
const money = (paymentId) => {
  try {
    const row = sqlite.prepare("SELECT captured_amount,refunded_amount,gateway_status,reconciliation_status FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId);
    return row ? { ...row } : null;
  } catch { return null; }
};
const payStatus = (paymentId) => sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId)?.status;
const refundStatus = (bookingId) => sqlite.prepare("SELECT status FROM booking_refund_cases WHERE booking_id=?").get(bookingId)?.status;
const count = (table) => { try { return Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c); } catch { return 0; } };
const inboxStatus = (eventId) => sqlite.prepare("SELECT processing_status FROM gateway_webhook_events WHERE event_id=?").get(eventId)?.processing_status;

/** Every durable trace a refusal must leave untouched. */
const durable = () => ({
  inbox: count("gateway_webhook_events"),
  events: count("payment_gateway_events"),
  reconciliation: count("payment_reconciliation_records"),
});
const NOTHING = { inbox: 0, events: 0, reconciliation: 0 };

// =============================================================================================
// 0. Control. If this fails every refusal below is vacuous.
// =============================================================================================

test("WH-00 (non-vacuity): a correctly signed capture IS processed and DOES record the money", async () => {
  freshDb();
  seedBooking({ id: "bkg_adv_ok" });
  const result = await postSigned(captureEvent("bkg_adv_ok", 200_000), { eventId: "evt_ok" });
  assert.equal(result.status, 200, `the honest path must work: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(Number(money("PAY-bkg_adv_ok")?.captured_amount), 2000, "and record Rs 2,000 collected");
  assert.equal(payStatus("PAY-bkg_adv_ok"), "captured", "and mark the payment captured");
});

// =============================================================================================
// 1. The dedupe key is a header the signature does not cover.
// =============================================================================================

test("WH-01: a modified created_at breaks the signature, because created_at is inside the signed body", async () => {
  // The good news first, and the reason the freshness gap in WH-16 is not remotely exploitable without
  // the secret: the timestamp cannot be edited in flight. The replay risk is a body kept as-is.
  freshDb();
  seedBooking({ id: "bkg_adv_ts" });
  const honest = JSON.stringify(captureEvent("bkg_adv_ts", 200_000, { createdAt: Math.floor((NOW - 90 * DAY) / 1000) }));
  const signature = await sign(SANDBOX_SECRET, honest);
  const tampered = JSON.stringify(captureEvent("bkg_adv_ts", 200_000, { createdAt: Math.floor(NOW / 1000) }));
  assert.notEqual(honest, tampered, "the two bodies really do differ");
  const result = await post(tampered, { signature, eventId: "evt_ts" });
  assert.equal(result.status, 401, `a re-dated body must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.deepEqual(durable(), NOTHING, "and nothing at all may be written");
});

test("WH-02: an event id reused with a DIFFERENT signed payload is a conflict, and the first payload stands", async () => {
  // The inbox binds event_id to payload_sha256. Someone who can sign at will could otherwise overwrite
  // what an already-recorded event id MEANS — turning the audit trail into whatever they last sent.
  freshDb();
  seedBooking({ id: "bkg_adv_swap", total: 2000 });
  const first = await postSigned(captureEvent("bkg_adv_swap", 200_000), { eventId: "evt_swap" });
  assert.equal(first.status, 200, `the first delivery lands: ${JSON.stringify(first).slice(0, 200)}`);
  const second = await postSigned(captureEvent("bkg_adv_swap", 999_900, { paymentId: "pay_OTHER" }), { eventId: "evt_swap" });
  assert.equal(second.status, 409, `the same id with new content must conflict: ${JSON.stringify(second).slice(0, 300)}`);
  const stored = sqlite.prepare("SELECT raw_payload FROM gateway_webhook_events WHERE event_id='evt_swap'").get();
  assert.equal(String(stored.raw_payload).includes("200000"), true, "the recorded payload must remain the original");
  assert.equal(String(stored.raw_payload).includes("pay_OTHER"), false, "and must not be rewritten by the second attempt");
  assert.equal(Number(money("PAY-bkg_adv_swap")?.captured_amount), 2000, "and the money must not move");
});

test("WH-03: the SAME signed capture replayed under a FORGED event id creates NO second event", async () => {
  // THE CENTRAL TEST OF THIS FILE. The dedupe key used to be `x-razorpay-event-id` alone — a header
  // outside the HMAC — so a captured (body, signature) pair plus a fresh header walked straight past
  // both idempotency layers and minted a genuinely new event: a second inbox row, a second
  // payment_gateway_events row, and a re-run of every side effect keyed on the event id.
  //
  // The money was never at risk even then, and that is asserted here too: captureRefs/collectedCaptures
  // match on the gateway payment id and order id, which ARE inside the signed body. But "the money
  // survived" is not the same as "the replay was rejected", and the inbox is the evidence log.
  //
  // The inbox now recognises the BODY, by the digest of the signature-verified payload, so a forged
  // header cannot manufacture anything. One event in, one row, whatever the caller labels it.
  freshDb();
  seedBooking({ id: "bkg_adv_replay" });
  const raw = JSON.stringify(captureEvent("bkg_adv_replay", 200_000));
  const signature = await sign(SANDBOX_SECRET, raw);
  const first = await post(raw, { signature, eventId: "evt_replay_1" });
  assert.equal(first.status, 200, `first delivery: ${JSON.stringify(first).slice(0, 200)}`);
  assert.equal(Number(money("PAY-bkg_adv_replay")?.captured_amount), 2000, "Rs 2,000 collected once");

  const second = await post(raw, { signature, eventId: "evt_replay_2" });
  assert.equal(second.status, 200, "acknowledged, because a redelivery is not an error");
  assert.equal(second.body?.duplicate, true, `and recognised as a duplicate: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(Number(money("PAY-bkg_adv_replay")?.captured_amount), 2000, "captured_amount must NOT double");
  // The assertions that changed when the guard landed: one signed body is one event, full stop.
  assert.equal(count("gateway_webhook_events"), 1, "a forged event id must NOT create a second inbox row");
  assert.equal(count("payment_gateway_events"), 1, "nor a second gateway event row");
  assert.equal(sqlite.prepare("SELECT event_id FROM gateway_webhook_events").get().event_id, "evt_replay_1",
    "and the row keeps the id it was first accepted under");
});

test("WH-03b: a genuine LATE retry of the same body is acknowledged, not dropped", async () => {
  // The other half of the same guard, and the reason it is identity-based rather than clock-based.
  // Razorpay retries a failed delivery for up to 24 hours. A five-minute freshness window — which is
  // what this receiver briefly had — would refuse that retry and lose the money event permanently.
  //
  // Here the body is 90 days old AND the header event id differs, i.e. it is indistinguishable from the
  // replay in WH-03. Both are handled the same way and correctly: acknowledged as a redelivery, money
  // unchanged. There is no version of this test that a timestamp window passes.
  freshDb();
  seedBooking({ id: "bkg_adv_retry" });
  const raw = JSON.stringify(captureEvent("bkg_adv_retry", 200_000, { createdAt: Math.floor((NOW - 90 * DAY) / 1000) }));
  const signature = await sign(SANDBOX_SECRET, raw);
  const first = await post(raw, { signature, eventId: "evt_retry_1" });
  assert.equal(first.status, 200, `an old-but-unseen event must still be processed: ${JSON.stringify(first).slice(0, 300)}`);
  assert.equal(Number(money("PAY-bkg_adv_retry")?.captured_amount), 2000, "the money is collected — age alone must never refuse a payment");
  const retry = await post(raw, { signature, eventId: "evt_retry_2" });
  assert.equal(retry.status, 200, "and the retry is acknowledged rather than refused");
  assert.equal(retry.body?.duplicate, true, `recognised as a redelivery: ${JSON.stringify(retry.body).slice(0, 300)}`);
  assert.equal(Number(money("PAY-bkg_adv_retry")?.captured_amount), 2000, "without recounting it");
});

test("WH-04: the SAME signed refund replayed under a FORGED event id does not refund twice", async () => {
  // The money-out direction, where a successful replay would be an actual loss. Two independent guards
  // now stand here — the inbox digest, and the refund case's gateway_reference — and this asserts the
  // outcome rather than which one fired.
  freshDb();
  seedBooking({ id: "bkg_adv_rfnd", payStatus: "captured" });
  seedRefundCase("bkg_adv_rfnd", 2000);
  await linkGatewayOrder(db, { bookingId: "bkg_adv_rfnd", gatewayOrderId: "order_ADV1", environment: "sandbox", actorId: "adv" });
  const raw = JSON.stringify(refundEvent("bkg_adv_rfnd", 200_000));
  const signature = await sign(SANDBOX_SECRET, raw);
  const first = await post(raw, { signature, eventId: "evt_rfnd_1" });
  assert.equal(first.status, 200, `first refund lands: ${JSON.stringify(first).slice(0, 250)}`);
  assert.equal(Number(money("PAY-bkg_adv_rfnd")?.refunded_amount), 2000, "Rs 2,000 refunded once");
  assert.equal(refundStatus("bkg_adv_rfnd"), "processed", "and the case is closed");

  const second = await post(raw, { signature, eventId: "evt_rfnd_2" });
  assert.equal(second.status, 200, `the replay is acknowledged: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(Number(money("PAY-bkg_adv_rfnd")?.refunded_amount), 2000, "refunded_amount must NOT double");
  assert.equal(count("gateway_webhook_events"), 1, "and no second inbox row exists to be replayed again");
});

test("WH-16: a DIFFERENT event with the same event id is still refused, and the digest guard does not mask it", async () => {
  // Guards against the failure mode the new digest lookup could introduce: it returns early on a known
  // body, so the event-id/payload binding below it must still fire for an UNKNOWN body arriving under a
  // used id. Without this, adding the digest check could have silently retired WH-02's 409.
  freshDb();
  seedBooking({ id: "bkg_adv_bind", total: 2000 });
  const first = await postSigned(captureEvent("bkg_adv_bind", 200_000), { eventId: "evt_bind" });
  assert.equal(first.status, 200, `the first delivery lands: ${JSON.stringify(first).slice(0, 200)}`);
  // Same id, genuinely different content — the digest lookup finds nothing, so the binding check runs.
  const conflicting = await postSigned(captureEvent("bkg_adv_bind", 200_000, { paymentId: "pay_DIFFERENT" }), { eventId: "evt_bind" });
  assert.equal(conflicting.status, 409, `must still conflict: ${JSON.stringify(conflicting).slice(0, 300)}`);
  assert.equal(count("gateway_webhook_events"), 1, "and no row is added for the refused payload");
  assert.equal(Number(money("PAY-bkg_adv_bind")?.captured_amount), 2000, "with the money untouched");
});

test("WH-16b: a body already seen in SANDBOX does not suppress the same body in LIVE", async () => {
  // The failure mode a global digest lookup would introduce, and the reason the lookup is scoped by
  // environment. Sandbox and live are separate ledgers with separate secrets; if one digest table were
  // shared, a live capture could be silently swallowed for having been rehearsed in sandbox — a
  // suppressed real payment, which is exactly the class of bug this whole pivot exists to avoid.
  //
  // Behavioural, not a source match: the SAME bytes are posted twice, signed with the two different
  // secrets, and the live delivery must be processed on its own merits.
  const LIVE_SECRET = "adv-webhook-live-secret";
  freshDb();
  seedBooking({ id: "bkg_adv_env" });
  const raw = JSON.stringify(captureEvent("bkg_adv_env", 200_000));
  const sandbox = await post(raw, { signature: await sign(SANDBOX_SECRET, raw), eventId: "evt_env_sandbox" });
  assert.equal(sandbox.status, 200, `the sandbox delivery lands: ${JSON.stringify(sandbox).slice(0, 250)}`);
  assert.equal(sandbox.body?.environment, "sandbox", "stamped sandbox");

  // Same database, same bytes, live mode — double-gated exactly as production requires.
  globalThis.__ADV_WH_ENV__ = {
    PAWSPACE_PAYMENT_ENV: "live",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "true",
    PAWSPACE_PAYMENT_PILOT_BOOKING_IDS: "bkg_adv_env,bkg_adv_pilot_2,bkg_adv_pilot_3,bkg_adv_pilot_4,bkg_adv_pilot_5",
    RAZORPAY_WEBHOOK_SECRET_LIVE: LIVE_SECRET,
  };
  const live = await post(raw, { signature: await sign(LIVE_SECRET, raw), eventId: "evt_env_live" });
  assert.equal(live.status, 200, `the live delivery must be processed on its own merits: ${JSON.stringify(live).slice(0, 300)}`);
  assert.equal(live.body?.environment, "live", "and stamped live");
  assert.notEqual(live.body?.duplicate, true, "a sandbox rehearsal must never mark a live event a duplicate");
  const rows = sqlite.prepare("SELECT environment,event_id FROM gateway_webhook_events ORDER BY environment").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ environment: "live", event_id: "evt_env_live" }, { environment: "sandbox", event_id: "evt_env_sandbox" }],
    "two ledgers, one row each");
});

// =============================================================================================
// 2. Signature forgery shapes the existing suite does not cover.
// =============================================================================================

test("WH-05: appending a byte to a signed body invalidates it — no prefix or extension is accepted", async () => {
  freshDb();
  seedBooking({ id: "bkg_adv_ext" });
  const raw = JSON.stringify(captureEvent("bkg_adv_ext", 200_000));
  const signature = await sign(SANDBOX_SECRET, raw);
  for (const suffix of [" ", "\n", " ", "{}"]) {
    const result = await post(raw + suffix, { signature, eventId: `evt_ext_${suffix.charCodeAt(0)}` });
    assert.equal(result.status, 401, `body+${JSON.stringify(suffix)} must be refused: ${JSON.stringify(result).slice(0, 200)}`);
  }
  assert.deepEqual(durable(), NOTHING, "and nothing is written for any of them");
});

test("WH-06: a signature of the right LENGTH but the wrong content is refused", async () => {
  // Constant-time comparison returns early only on length. A same-length wrong value is the case that
  // actually exercises the comparison loop.
  freshDb();
  seedBooking({ id: "bkg_adv_len" });
  const raw = JSON.stringify(captureEvent("bkg_adv_len", 200_000));
  const real = await sign(SANDBOX_SECRET, raw);
  const forged = real.slice(0, -1) + (real.endsWith("a") ? "b" : "a");
  assert.equal(forged.length, real.length, "same length, one nibble different");
  const result = await post(raw, { signature: forged, eventId: "evt_len" });
  assert.equal(result.status, 401, `must be refused: ${JSON.stringify(result).slice(0, 200)}`);
  assert.deepEqual(durable(), NOTHING, "and write nothing");
});

test("WH-07: a correct signature in UPPERCASE hex is still accepted", async () => {
  // Behavioural lock, not an attack. The route lowercases the header before comparing, so hex case is
  // deliberately insignificant — worth pinning, because "harden the comparison" is exactly the kind of
  // edit that would silently start rejecting a real provider that sends uppercase.
  freshDb();
  seedBooking({ id: "bkg_adv_case" });
  const raw = JSON.stringify(captureEvent("bkg_adv_case", 200_000));
  const signature = (await sign(SANDBOX_SECRET, raw)).toUpperCase();
  const result = await post(raw, { signature, eventId: "evt_case" });
  assert.equal(result.status, 200, `uppercase hex must still verify: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(Number(money("PAY-bkg_adv_case")?.captured_amount), 2000, "and the capture is processed");
});

test("WH-08: a non-hex or decorated signature is refused, not crashed on", async () => {
  freshDb();
  seedBooking({ id: "bkg_adv_hex" });
  const raw = JSON.stringify(captureEvent("bkg_adv_hex", 200_000));
  const real = await sign(SANDBOX_SECRET, raw);
  const shapes = ["0x" + real, real + "==", "zz".repeat(32), "  ", "%s%s%s", "../../etc/passwd"];
  for (const [index, signature] of shapes.entries()) {
    const result = await post(raw, { signature, eventId: `evt_hex_${index}` });
    assert.ok(result.status === 400 || result.status === 401,
      `${JSON.stringify(signature).slice(0, 24)} must be refused 400/401, got ${result.status}: ${JSON.stringify(result.body).slice(0, 150)}`);
  }
  assert.deepEqual(durable(), NOTHING, "and no shape may write anything");
});

test("WH-09: an empty or whitespace-only event id is refused before any work", async () => {
  // The existing suite covers an ABSENT id. An empty and a whitespace-only header are the two values
  // that a trim-then-truthiness check must also reject, and the inbox's uniqueness depends on it —
  // "" would collapse every event onto one row.
  freshDb();
  seedBooking({ id: "bkg_adv_eid" });
  const raw = JSON.stringify(captureEvent("bkg_adv_eid", 200_000));
  const signature = await sign(SANDBOX_SECRET, raw);
  for (const eventId of ["", "   ", "\t"]) {
    const result = await post(raw, { signature, eventId });
    assert.equal(result.status, 400, `event id ${JSON.stringify(eventId)} must be refused: ${JSON.stringify(result).slice(0, 200)}`);
  }
  assert.deepEqual(durable(), NOTHING, "and nothing is written");
});

test("WH-10: a hostile event id is stored as data, never interpreted", async () => {
  // The event id reaches SQL, a UNIQUE index and a journal narration. Bound parameters make it inert;
  // this asserts that rather than assuming it, and that no 500 escapes.
  freshDb();
  seedBooking({ id: "bkg_adv_inj" });
  const raw = JSON.stringify(captureEvent("bkg_adv_inj", 200_000));
  const signature = await sign(SANDBOX_SECRET, raw);
  const hostile = "evt'); DROP TABLE booking_payments;--";
  const result = await post(raw, { signature, eventId: hostile });
  assert.notEqual(result.status, 500, `no internal error: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(payStatus("PAY-bkg_adv_inj") !== undefined, true, "booking_payments must still exist");
  assert.equal(inboxStatus(hostile) !== undefined, true, "and the id is stored verbatim as a value");
});

// =============================================================================================
// 3. Malformed bodies. A refusal must be a 4xx AND must not leave a claimable inbox row behind.
// =============================================================================================

test("WH-11: a correctly signed body that is not JSON is refused 400 and the inbox row is REJECTED", async () => {
  // The body is signed, so the caller IS the gateway — this is a malformed delivery, not an attack, and
  // it must terminate rather than sit in the inbox looking retryable.
  freshDb();
  seedBooking({ id: "bkg_adv_json" });
  const result = await postSigned("this is not json at all", { eventId: "evt_notjson" });
  assert.equal(result.status, 400, `must be refused 400: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(inboxStatus("evt_notjson"), "REJECTED", "and be marked terminally rejected, not left RECEIVED");
  assert.equal(count("payment_gateway_events"), 0, "no gateway event may be recorded");
});

test("WH-12: a correctly signed body with no event type is refused 400 and marked REJECTED", async () => {
  freshDb();
  seedBooking({ id: "bkg_adv_noevt" });
  const result = await postSigned({ created_at: Math.floor(NOW / 1000), payload: {} }, { eventId: "evt_noevt" });
  assert.equal(result.status, 400, `must be refused: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(inboxStatus("evt_noevt"), "REJECTED", "and marked rejected");
  assert.equal(count("payment_gateway_events"), 0, "and record no gateway event");
});

test("WH-13: signed JSON of the wrong SHAPE is refused rather than reaching the money path", async () => {
  // Valid JSON, wrong type. `payload` as an array, a string, null; the whole body as an array or a
  // number. Each one is a place where a `.entity` read or an Object.keys could throw a 500 — which
  // would be reported to the gateway as retryable and hammered.
  freshDb();
  seedBooking({ id: "bkg_adv_shape" });
  const shapes = [
    [],
    42,
    "\"just a string\"",
    { event: "payment.captured", payload: [] },
    { event: "payment.captured", payload: null },
    { event: "payment.captured", payload: { payment: null } },
    { event: "payment.captured", payload: { payment: { entity: [] } } },
    { event: ["payment.captured"], payload: {} },
  ];
  for (const [index, shape] of shapes.entries()) {
    const raw = typeof shape === "string" ? shape : JSON.stringify(shape);
    const result = await post(raw, { signature: await sign(SANDBOX_SECRET, raw), eventId: `evt_shape_${index}` });
    assert.notEqual(result.status, 500, `shape ${index} (${raw.slice(0, 40)}) must not 500: ${JSON.stringify(result.body).slice(0, 200)}`);
  }
  assert.equal(Number(money("PAY-bkg_adv_shape")?.captured_amount ?? 0), 0, "and none of them may collect money");
});

// =============================================================================================
// 4. Out-of-order delivery. An attacker holding old signed bodies chooses the order.
// =============================================================================================

test("WH-14: an authorization arriving AFTER settlement does not unwind the capture", async () => {
  freshDb();
  seedBooking({ id: "bkg_adv_ooo_auth" });
  await postSigned(captureEvent("bkg_adv_ooo_auth", 200_000), { eventId: "evt_ooo_cap" });
  assert.equal(Number(money("PAY-bkg_adv_ooo_auth")?.captured_amount), 2000, "captured first");
  const late = await postSigned(authorizedEvent("bkg_adv_ooo_auth", 200_000), { eventId: "evt_ooo_auth" });
  assert.equal(late.body?.reason, "out_of_order_authorized", `must be recognised as late: ${JSON.stringify(late.body).slice(0, 250)}`);
  assert.equal(Number(money("PAY-bkg_adv_ooo_auth")?.captured_amount), 2000, "and the collected total must not change");
  assert.equal(money("PAY-bkg_adv_ooo_auth")?.gateway_status, "captured", "nor the gateway status regress to authorized");
  assert.equal(payStatus("PAY-bkg_adv_ooo_auth"), "captured", "nor the payment status");
});

test("WH-15: a payment failure arriving AFTER a capture does not mark a paid booking failed", async () => {
  // The most damaging ordering: a replayed `payment.failed` against money that has been collected would
  // fail a subscription, refund an entitlement and show the customer an unpaid booking.
  freshDb();
  seedBooking({ id: "bkg_adv_ooo_fail" });
  await postSigned(captureEvent("bkg_adv_ooo_fail", 200_000), { eventId: "evt_ooo_cap2" });
  const late = await postSigned(failedEvent("bkg_adv_ooo_fail", 200_000), { eventId: "evt_ooo_fail" });
  assert.equal(late.body?.reason, "out_of_order_failed", `must be recognised as late: ${JSON.stringify(late.body).slice(0, 250)}`);
  assert.equal(payStatus("PAY-bkg_adv_ooo_fail"), "captured", "the payment must stay captured");
  assert.equal(Number(money("PAY-bkg_adv_ooo_fail")?.captured_amount), 2000, "and the money must stay collected");
});

test("WH-17: a refund failure arriving AFTER the refund processed does not reopen the case", async () => {
  freshDb();
  seedBooking({ id: "bkg_adv_ooo_rf", payStatus: "captured" });
  seedRefundCase("bkg_adv_ooo_rf", 2000);
  await linkGatewayOrder(db, { bookingId: "bkg_adv_ooo_rf", gatewayOrderId: "order_ADV1", environment: "sandbox", actorId: "adv" });
  await postSigned(refundEvent("bkg_adv_ooo_rf", 200_000), { eventId: "evt_ooo_rp" });
  assert.equal(refundStatus("bkg_adv_ooo_rf"), "processed", "processed first");
  const late = await postSigned(refundEvent("bkg_adv_ooo_rf", 200_000, { type: "refund.failed" }), { eventId: "evt_ooo_rfail" });
  assert.equal(late.body?.reason, "out_of_order_refund_failed", `must be recognised as late: ${JSON.stringify(late.body).slice(0, 250)}`);
  assert.equal(refundStatus("bkg_adv_ooo_rf"), "processed", "and the case must stay processed");
  assert.equal(Number(money("PAY-bkg_adv_ooo_rf")?.refunded_amount), 2000, "with the refunded total unchanged");
});

test("WH-18: a signed capture claiming a booking that does not own the gateway order is an exception, not a collection", async () => {
  // Cross-booking claim: the notes say booking B, the order id belongs to booking A. `notes` is
  // attacker-influenceable in any flow where a customer can set them, and it is what extract() reads to
  // decide which booking the money lands on.
  freshDb();
  seedBooking({ id: "bkg_adv_owner" });
  seedBooking({ id: "bkg_adv_thief", customer: "cus_adv2" });
  await linkGatewayOrder(db, { bookingId: "bkg_adv_owner", gatewayOrderId: "order_ADV1", environment: "sandbox", actorId: "adv" });
  const result = await postSigned(captureEvent("bkg_adv_thief", 200_000, { orderId: "order_ADV1" }), { eventId: "evt_owner" });
  // `code` or `reason`: the atomic-capture path reports the mismatch as an error envelope carrying
  // `code`, the reconciliation path as a 200 envelope carrying `reason`. Both are correct refusals and
  // which one fires depends on whether the booking has a payment intent, so the assertion is on the
  // identified cause rather than on the envelope that carried it.
  assert.equal(result.body?.code ?? result.body?.reason, "gateway_order_booking_mismatch",
    `must be refused as a mismatch: ${JSON.stringify(result.body).slice(0, 250)}`);
  assert.equal(Number(money("PAY-bkg_adv_thief")?.captured_amount ?? 0), 0, "no money may land on the claiming booking");
  assert.equal(payStatus("PAY-bkg_adv_thief"), "created", "and its payment must stay unpaid");
});
