/**
 * PAY-01 regression: on Cloudflare D1 every Razorpay webhook was answered 200 "duplicate" and left stuck in
 * PROCESSING. D1's meta.changes counts rows written by triggers, and gateway_webhook_events carries two
 * triggers (drizzle/0030) that mirror each insert and status change into gateway_inbound_queue, so a fresh
 * insert and a successful claim both reported 2 changes and were read as "someone else got there first".
 * This suite runs the real route against a D1-faithful change count with those triggers installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__D1TRG_DB__", "__D1TRG_ENV__");

// D1 reports meta.changes as the total_changes() delta of the statement, which INCLUDES rows written by
// triggers. node:sqlite's info.changes does not, which is why the other webhook suites never saw PAY-01.
function makeD1(sqlite) {
  const total = () => Number(sqlite.prepare("SELECT total_changes() AS n").get().n);
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const before = total(); sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: total() - before } }; },
      all: async () => { const before = total(); const results = sqlite.prepare(sql).all(...args); return { success: true, results, meta: { changes: total() - before } }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const s of statements) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const SANDBOX_SECRET = "w3a-sandbox-secret";
const NOW = 1_800_000_000_000;
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


function freshDb(env = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET }) {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__D1TRG_DB__ = makeD1(sqlite);
  globalThis.__D1TRG_ENV__ = env;
  baseTables();
  installFinancialLifecycleSchema(sqlite);
  // The universal inbound queue and the two gateway_webhook_events triggers exactly as staging has them.
  const ddl = readFileSync(new URL("../drizzle/0030_privacy_webhook_beneficiary.sql", import.meta.url), "utf8");
  for (const re of [/CREATE TABLE IF NOT EXISTS gateway_inbound_queue \([\s\S]*?\n\);/, /CREATE TRIGGER IF NOT EXISTS gateway_webhook_to_universal_inbox[\s\S]*?\nEND;/, /CREATE TRIGGER IF NOT EXISTS gateway_webhook_sync_universal_status[\s\S]*?\nEND;/]) {
    const statement = ddl.match(re);
    assert.ok(statement, `drizzle/0030 no longer contains ${re}`);
    sqlite.exec(statement[0]);
  }
}

const webhookRoute = await import("../app/api/razorpay-webhook/route.ts");

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

// ---------------------------------------------------------------------------------------------
// W2-07-PAY-R01: signature verified before any state change; absent/whitespace secret fails closed
// ---------------------------------------------------------------------------------------------

const inbox = (eventId) => sqlite.prepare("SELECT processing_status FROM gateway_webhook_events WHERE event_id=?").get(eventId);
const queue = (eventId) => sqlite.prepare("SELECT status FROM gateway_inbound_queue WHERE event_id=?").get(eventId);

test("D1-TRG-01: a new signed capture is processed, not acknowledged as a duplicate", async () => {
  freshDb();
  const probe = sqlite.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name LIKE 'gateway_webhook_%universal%'").get().c;
  assert.equal(Number(probe), 2, "both inbound-queue triggers must be installed, or this test proves nothing");
  seedBooking({ id: "bkg_d1trg_1", total: 2000, dueNow: 2000 });
  const res = await postSigned(captureEvent("bkg_d1trg_1", 200_000), { eventId: "evt_d1trg_1" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(res.body?.duplicate, true, `a first delivery must not be treated as a duplicate: ${JSON.stringify(res.body)}`);
  assert.equal(inbox("evt_d1trg_1")?.processing_status, "PROCESSED");
  assert.equal(queue("evt_d1trg_1")?.status, "PROCESSED", "the universal queue mirror must follow the inbox");
  assert.ok(durableState().events >= 1, "the capture must reach payment_gateway_events");
});

test("D1-TRG-02: the same event delivered again is still an idempotent duplicate", async () => {
  freshDb();
  seedBooking({ id: "bkg_d1trg_2", total: 2000, dueNow: 2000 });
  const first = await postSigned(captureEvent("bkg_d1trg_2", 200_000, "pay_D1TRG2"), { eventId: "evt_d1trg_2" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const events = durableState().events;
  const again = await postSigned(captureEvent("bkg_d1trg_2", 200_000, "pay_D1TRG2"), { eventId: "evt_d1trg_2" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body?.duplicate, true, "a redelivery must be acknowledged as a duplicate");
  assert.equal(durableState().events, events, "a redelivery must not write a second gateway event");
  assert.equal(inbox("evt_d1trg_2")?.processing_status, "PROCESSED");
});
