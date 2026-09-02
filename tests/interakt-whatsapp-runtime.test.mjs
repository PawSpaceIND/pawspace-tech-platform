import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { dispatchInteraktMessage, dispatchInteraktOutboxMessage, setInteraktTemplateVerification, validateInteraktWebhookSignature } from "../lib/interakt-whatsapp.ts";
import { recordDeliveryEvent } from "../lib/communication-engine.ts";

const CONFIGURED = { INTERAKT_API_KEY: "runtime-test-key", INTERAKT_BASE_URL: "https://api.interakt.test", INTERAKT_WEBHOOK_SECRET: "runtime-webhook-secret" };
const TEMPLATE = "pkg_link_v1";

const createD1 = (sqlite) => ({
  prepare(sql) {
    const make = (bound = []) => ({
      bind: (...args) => make(args),
      first: async () => sqlite.prepare(sql).get(...bound) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...bound) }),
      run: async () => { const info = sqlite.prepare(sql).run(...bound); return { success: true, meta: { changes: Number(info.changes ?? 0) } }; },
    });
    return make();
  },
  batch: async (statements) => { const out = []; for (const statement of statements) out.push(await statement.run()); return out; },
  exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
});

function spyFetcher(response = { ok: true, status: 200, body: { result: true, id: "provider-1" } }) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response.body), { status: response.ok ? 200 : response.status, headers: { "content-type": "application/json" } });
  };
  fetcher.calls = calls;
  return fetcher;
}

async function fresh({ consent = 1, optOut = 0 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, primary_phone TEXT, secondary_phone TEXT);
    CREATE TABLE customer_contact_preferences (customer_id TEXT PRIMARY KEY, whatsapp_consent INTEGER, opt_out INTEGER);
    CREATE TABLE communication_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, customer_id TEXT NOT NULL, booking_id TEXT, lead_id TEXT, ticket_id TEXT, direction TEXT NOT NULL, channel TEXT NOT NULL, purpose TEXT NOT NULL, template_key TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, provider_reference TEXT, idempotency_key TEXT NOT NULL UNIQUE, policy_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE communication_outbox (message_id TEXT PRIMARY KEY, status TEXT NOT NULL, next_attempt_at INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, last_error TEXT, locked_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE communication_message_delivery_events (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, UNIQUE(provider,event_id));
    CREATE TABLE communication_dead_letters (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, reason TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT);
  `);
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-A','+919100000000',NULL)").run();
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-B','+919100000001',NULL)").run();
  sqlite.prepare("INSERT INTO customer_contact_preferences VALUES ('CUS-A',?,?)").run(consent, optOut);
  sqlite.prepare("INSERT INTO customer_contact_preferences VALUES ('CUS-B',1,0)").run();
  const db = createD1(sqlite);
  await setInteraktTemplateVerification(db, { templateKey: TEMPLATE, status: "approved", language: "en", actorId: "runtime-test" });
  return { db, sqlite };
}

function queue(sqlite, id, customerId = "CUS-A", maxAttempts = 3) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,'outbound','whatsapp','transactional',?,?,'queued',?,?,?, ?,?)")
    .run(id, `THREAD-${id}`, customerId, TEMPLATE, JSON.stringify({ bodyValues: ["Asha"] }), id, JSON.stringify({ retryBaseMinutes: 1 }), "runtime-test", now, now);
  sqlite.prepare("INSERT INTO communication_outbox (message_id,status,next_attempt_at,attempt_count,max_attempts,updated_at) VALUES (?,'queued',0,0,?,?)")
    .run(id, maxAttempts, now);
}

const templateSend = { withinSession: false, templateKey: TEMPLATE, language: "en", bodyValues: ["Asha"] };

test("cross-customer phone mismatch is refused before provider dispatch", async () => {
  const { db, sqlite } = await fresh(); queue(sqlite, "MSG-XPHONE"); const fetcher = spyFetcher();
  const error = await dispatchInteraktOutboxMessage(db, CONFIGURED, { messageId: "MSG-XPHONE", recipient: "9100000001", fetcher }).then(() => null, (e) => e);
  assert.equal(error?.statusCode, 403); assert.equal(fetcher.calls.length, 0);
});

test("message customer-id mismatch is refused even when the supplied phone belongs to that other customer", async () => {
  const { db, sqlite } = await fresh(); queue(sqlite, "MSG-XCUSTOMER", "CUS-A"); const fetcher = spyFetcher();
  const error = await dispatchInteraktMessage(db, CONFIGURED, { messageId: "MSG-XCUSTOMER", customerId: "CUS-B", recipient: "9100000001", send: templateSend }, fetcher).then(() => null, (e) => e);
  assert.equal(error?.statusCode, 403); assert.match(error.message, /does not belong to this canonical customer/); assert.equal(fetcher.calls.length, 0);
});

test("whatsapp_consent must equal 1 and opt_out must equal 0", async (t) => {
  for (const [name, consent, optOut] of [["missing consent",0,0],["explicit opt-out",1,1],["unknown opt-out",1,null]]) {
    await t.test(name, async () => {
      const { db, sqlite } = await fresh({ consent, optOut }); queue(sqlite, `MSG-${name.replaceAll(" ","-")}`); const fetcher = spyFetcher();
      const id = `MSG-${name.replaceAll(" ","-")}`;
      const error = await dispatchInteraktOutboxMessage(db, CONFIGURED, { messageId: id, recipient: "9100000000", fetcher }).then(() => null, (e) => e);
      assert.equal(error?.statusCode, 409); assert.equal(fetcher.calls.length, 0);
    });
  }
});

test("valid signed inbound webhook verifies; missing, mutated and invalid signatures fail closed", async () => {
  const raw = JSON.stringify({ event: "message.received", id: "evt-1", phone: "+919100000000" });
  const signature = `sha256=${createHmac("sha256", CONFIGURED.INTERAKT_WEBHOOK_SECRET).update(raw).digest("hex")}`;
  assert.equal((await validateInteraktWebhookSignature(CONFIGURED, raw, new Headers({ "interakt-signature": signature }))).verified, true);
  assert.equal((await validateInteraktWebhookSignature(CONFIGURED, `${raw} `, new Headers({ "interakt-signature": signature }))).verified, false);
  assert.equal((await validateInteraktWebhookSignature(CONFIGURED, raw, new Headers())).verified, false);
  assert.equal((await validateInteraktWebhookSignature(CONFIGURED, raw, new Headers({ "interakt-signature": `sha256=${"0".repeat(64)}` }))).verified, false);
});

test("duplicate inbound provider event id is persisted once and reported as duplicate on replay", async () => {
  const { db, sqlite } = await fresh(); queue(sqlite, "MSG-INBOUND");
  const first = await recordDeliveryEvent(db, { messageId: "MSG-INBOUND", provider: "interakt", eventId: "evt-inbound-1", eventType: "delivered", detail: { source: "signed_webhook" } });
  const second = await recordDeliveryEvent(db, { messageId: "MSG-INBOUND", provider: "interakt", eventId: "evt-inbound-1", eventType: "delivered", detail: { source: "signed_webhook" } });
  assert.equal(first.duplicatePrevented, false); assert.equal(second.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM communication_message_delivery_events WHERE provider='interakt' AND event_id='evt-inbound-1'").get().count, 1);
});

test("provider rejection consumes exactly one retry attempt and eventually dead-letters at max_attempts", async () => {
  const { db, sqlite } = await fresh(); queue(sqlite, "MSG-RETRY", "CUS-A", 3);
  const reject = spyFetcher({ ok: false, status: 503, body: { result: false, message: "provider unavailable" } });
  for (let expected = 1; expected <= 3; expected += 1) {
    sqlite.prepare("UPDATE communication_outbox SET status='retry_pending',next_attempt_at=0 WHERE message_id='MSG-RETRY'").run();
    const result = await dispatchInteraktOutboxMessage(db, CONFIGURED, { messageId: "MSG-RETRY", recipient: "9100000000", fetcher: reject });
    assert.equal(result.externalDelivery, false);
    const row = sqlite.prepare("SELECT status,attempt_count FROM communication_outbox WHERE message_id='MSG-RETRY'").get();
    assert.equal(row.attempt_count, expected, `provider attempt ${expected} must increment once`);
    assert.equal(row.status, expected === 3 ? "dead_letter" : "retry_pending");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM communication_dead_letters WHERE message_id='MSG-RETRY'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM communication_message_delivery_events WHERE message_id='MSG-RETRY' AND event_type='failed'").get().count, 3);
  assert.equal(reject.calls.length, 3);
});

test("successful durable outbox dispatch records provider acceptance and does not increment retry count", async () => {
  const { db, sqlite } = await fresh(); queue(sqlite, "MSG-OK"); const fetcher = spyFetcher();
  const result = await dispatchInteraktOutboxMessage(db, CONFIGURED, { messageId: "MSG-OK", recipient: "9100000000", fetcher });
  assert.equal(result.status, "provider_accepted"); assert.equal(result.externalDelivery, true); assert.equal(fetcher.calls.length, 1);
  const row = sqlite.prepare("SELECT status,attempt_count FROM communication_outbox WHERE message_id='MSG-OK'").get();
  assert.equal(row.status, "sent"); assert.equal(row.attempt_count, 0);
});
