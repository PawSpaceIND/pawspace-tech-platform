import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./helpers/voice-harness.mjs";
import { ensureCommunicationTables } from "../lib/communication-engine.ts";
import { ensureWhatsAppTemplateLifecycle } from "../lib/whatsapp-template-lifecycle.ts";
import { dispatchInteraktWhatsApp, recordInteraktWebhook, signInteraktWebhook } from "../lib/interakt-whatsapp.ts";

const ENV = { PAWSPACE_DEPLOYMENT_ENV: "production", PAWSPACE_COMMUNICATION_ENV: "live", INTERAKT_API_KEY: "test-interakt-key", INTERAKT_WEBHOOK_SECRET: "test-webhook-secret" };

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  await ensureCommunicationTables(db);
  await ensureWhatsAppTemplateLifecycle(db);
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, primary_phone TEXT NOT NULL, secondary_phone TEXT, consent_json TEXT DEFAULT '{}');
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL);
    CREATE TABLE lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT, opt_out INTEGER DEFAULT 0);
    CREATE TABLE customer_contact_preferences (customer_id TEXT PRIMARY KEY, whatsapp_consent INTEGER, opt_out INTEGER DEFAULT 0);
    INSERT INTO canonical_customers VALUES ('CUST-A','+919876543210',NULL,'{}');
    INSERT INTO canonical_customers VALUES ('CUST-B','+919222222222',NULL,'{}');
    INSERT INTO canonical_bookings VALUES ('BKG-A','CUST-A');
    INSERT INTO customer_contact_preferences VALUES ('CUST-A',1,0);
    INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES ('booking_confirmed','approved','utility','en','test',1);
  `);
  const now = Date.now();
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES ('THREAD-A','CUST-A','BKG-A',NULL,NULL,'open',NULL,NULL,?,?)").run(now,now);
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('MSG-A','THREAD-A','CUST-A','BKG-A',NULL,NULL,'outbound','whatsapp','transactional','booking_confirmed','{\"bodyValues\":[\"Shifa\"]}','queued',NULL,NULL,'interakt-test-1','{}','test',?,?)").run(now,now);
  sqlite.prepare("INSERT INTO communication_outbox (message_id,status,next_attempt_at,attempt_count,max_attempts,last_error,locked_at,updated_at) VALUES ('MSG-A','queued',?,0,2,NULL,NULL,?)").run(now-1,now);
  return { sqlite, db };
}

function acceptedFetcher(spy) {
  return async (url, init) => {
    spy.calls += 1;
    spy.url = String(url);
    spy.init = init;
    return new Response(JSON.stringify({ result: true, message: "Message created successfully", id: "INTERAKT-MSG-1" }), { status: 201, headers: { "content-type": "application/json" } });
  };
}

test("Interakt production dispatch refuses a mismatched customer phone before network contact", async () => {
  const { db } = await world();
  const spy = { calls: 0 };
  await assert.rejects(
    () => dispatchInteraktWhatsApp(db, ENV, { messageId: "MSG-A", recipient: "+919222222222", fetcher: acceptedFetcher(spy) }),
    /does not belong to the canonical customer/,
  );
  assert.equal(spy.calls, 0);
});

test("Interakt production dispatch requires whatsapp_consent=1 and opt_out=0", async () => {
  const { sqlite, db } = await world();
  const spy = { calls: 0 };
  sqlite.prepare("UPDATE customer_contact_preferences SET opt_out=1 WHERE customer_id='CUST-A'").run();
  const result = await dispatchInteraktWhatsApp(db, ENV, { messageId: "MSG-A", recipient: "+919876543210", fetcher: acceptedFetcher(spy) });
  assert.equal(result.status, "consent_refused");
  assert.equal(spy.calls, 0);
});

test("Interakt production dispatch sends only an approved governed template and records provider acceptance", async () => {
  const { sqlite, db } = await world();
  const spy = { calls: 0 };
  const result = await dispatchInteraktWhatsApp(db, ENV, { messageId: "MSG-A", recipient: "+91 98765 43210", fetcher: acceptedFetcher(spy) });
  assert.equal(result.status, "provider_accepted");
  assert.equal(result.productionDelivery, true);
  assert.equal(spy.calls, 1);
  assert.equal(spy.url, "https://api.interakt.ai/v1/public/message/");
  assert.equal(spy.init.headers.authorization, "Basic test-interakt-key");
  const body = JSON.parse(spy.init.body);
  assert.equal(body.countryCode, "+91");
  assert.equal(body.phoneNumber, "9876543210");
  assert.equal(body.template.name, "booking_confirmed");
  assert.deepEqual(body.template.bodyValues, ["Shifa"]);
  const row = sqlite.prepare("SELECT provider,provider_reference,status FROM communication_messages WHERE id='MSG-A'").get();
  assert.equal(row.provider, "interakt");
  assert.equal(row.provider_reference, "INTERAKT-MSG-1");
  assert.equal(row.status, "provider_accepted");
});

test("Interakt webhook signature failure makes no delivery mutation", async () => {
  const { sqlite, db } = await world();
  sqlite.prepare("UPDATE communication_messages SET provider='interakt',provider_reference='INTERAKT-MSG-1',status='provider_accepted' WHERE id='MSG-A'").run();
  const raw = JSON.stringify({ type: "message_api_delivered", timestamp: "2026-09-02T12:00:00Z", data: { customer: { channel_phone_number: "919876543210" }, message: { id: "INTERAKT-MSG-1" } } });
  const result = await recordInteraktWebhook(db, ENV, { rawBody: raw, headers: new Headers({ "Interakt-Signature": "sha256=deadbeef" }) });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 401);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_message_delivery_events WHERE provider='interakt'").get().n, 0);
});

test("signed Interakt delivery webhook revalidates callback recipient and updates the outbox idempotently", async () => {
  const { sqlite, db } = await world();
  sqlite.prepare("UPDATE communication_messages SET provider='interakt',provider_reference='INTERAKT-MSG-1',status='provider_accepted' WHERE id='MSG-A'").run();
  sqlite.prepare("UPDATE communication_outbox SET status='sent' WHERE message_id='MSG-A'").run();
  const raw = JSON.stringify({ type: "message_api_delivered", timestamp: "2026-09-02T12:00:00Z", data: { customer: { channel_phone_number: "919876543210" }, message: { id: "INTERAKT-MSG-1" } } });
  const signature = await signInteraktWebhook(ENV.INTERAKT_WEBHOOK_SECRET, raw);
  const headers = new Headers({ "Interakt-Signature": signature });
  const first = await recordInteraktWebhook(db, ENV, { rawBody: raw, headers });
  const replay = await recordInteraktWebhook(db, ENV, { rawBody: raw, headers });
  assert.equal(first.accepted, true);
  assert.equal(first.eventType, "delivered");
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT status FROM communication_messages WHERE id='MSG-A'").get().status, "delivered");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_message_delivery_events WHERE provider='interakt'").get().n, 1);
});

test("signed Interakt webhook refuses to attach an event when callback phone belongs to another customer", async () => {
  const { sqlite, db } = await world();
  sqlite.prepare("UPDATE communication_messages SET provider='interakt',provider_reference='INTERAKT-MSG-1',status='provider_accepted' WHERE id='MSG-A'").run();
  const raw = JSON.stringify({ type: "message_api_read", timestamp: "2026-09-02T12:00:00Z", data: { customer: { channel_phone_number: "919222222222" }, message: { id: "INTERAKT-MSG-1" } } });
  const signature = await signInteraktWebhook(ENV.INTERAKT_WEBHOOK_SECRET, raw);
  const result = await recordInteraktWebhook(db, ENV, { rawBody: raw, headers: new Headers({ "Interakt-Signature": signature }) });
  assert.equal(result.accepted, true);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "recipient_customer_mismatch");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_message_delivery_events WHERE provider='interakt'").get().n, 0);
});
