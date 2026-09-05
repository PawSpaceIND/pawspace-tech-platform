import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__HAPTIK_WHATSAPP_DB__", "__PAWSPACE_TEST_ENV__");

function makeD1(sqlite) {
  function statement(sql, args = []) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
    },
    exec: async (sql) => sqlite.exec(sql),
  };
}

async function world({ optOut = 0, templateStatus = "approved", whatsappConsent = 1 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__HAPTIK_WHATSAPP_DB__ = db;
  globalThis.__PAWSPACE_TEST_ENV__ = { DB: db };

  sqlite.exec(`
 CREATE TABLE crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT DEFAULT 'Unassigned',source TEXT DEFAULT 'Website',lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,source TEXT NOT NULL,service TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',stage TEXT NOT NULL DEFAULT 'day_1',work_day INTEGER NOT NULL DEFAULT 1,assigned_at INTEGER NOT NULL,first_action_due_at INTEGER NOT NULL,manager_alert_at INTEGER NOT NULL,first_action_at INTEGER,call_attempts INTEGER NOT NULL DEFAULT 0,whatsapp_attempts INTEGER NOT NULL DEFAULT 0,last_outcome TEXT,next_action_at INTEGER,recycle_at INTEGER,recycle_cycle INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0,converted_booking_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE bot_call_dispositions (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,phone TEXT NOT NULL,channel TEXT NOT NULL,bot_provider TEXT NOT NULL,call_ref TEXT,primary_tag TEXT NOT NULL,tags_json TEXT NOT NULL,crm_outcome TEXT NOT NULL,contacted INTEGER NOT NULL DEFAULT 0,escalated INTEGER NOT NULL DEFAULT 0,opted_out INTEGER NOT NULL DEFAULT 0,cross_sell_services_json TEXT NOT NULL DEFAULT '[]',claim_tags_json TEXT NOT NULL DEFAULT '[]',reconciliation_status TEXT NOT NULL DEFAULT 'not_required',callback_at INTEGER,callback_id TEXT,case_id TEXT,attempt_id TEXT,talk_time_seconds INTEGER,sentiment TEXT,notes TEXT,transcript_ref TEXT,recorded_by TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT,status TEXT,total_amount REAL,scheduled_start TEXT,scheduled_end TEXT);
 `);

  const bridge = await import("../lib/haptik-whatsapp-journey-bridge.ts");
  await bridge.bridgeHaptikVoiceOutcomeToWhatsApp(db, {}, {
    dispositionId: "missing",
    dispositionIdempotencyKey: "warmup",
  });

  const now = Date.now();
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,source,created_at,updated_at) VALUES ('CUS-HW','Asha Verma','+919876500101','Qualified','sales','Haptik',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,opt_out,created_at,updated_at) VALUES ('LEAD-HW','CUS-HW','haptik_voice','grooming','sales','manager','qualified','day_1',1,?,?,?, ?,?,?)").run(now, now + 600000, now + 1200000, optOut, now, now);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,created_at,updated_at) VALUES ('CUS-HW','blr','Asha Verma','+919876500101','haptik_voice',?,?)").run(now, now);
  sqlite.prepare("INSERT OR REPLACE INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES ('CUS-HW',1,1,?,0,0,?,'test','test',?)").run(whatsappConsent, optOut, now);
  sqlite.prepare("INSERT OR REPLACE INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES ('haptik_booking_intent_v1',?,'utility','en','test',?)").run(templateStatus, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount) VALUES ('BOOK-HW','CUS-HW','grooming','draft',1899)").run();

  return { sqlite, db, bridge, now };
}

test("successful Haptik booking intent enqueues one approved WhatsApp template with the payment URL", async () => {
  const { sqlite, db, bridge, now } = await world();
  sqlite.prepare("INSERT INTO bot_call_dispositions (id,idempotency_key,lead_id,contact_id,phone,channel,bot_provider,primary_tag,tags_json,crm_outcome,contacted,opted_out,cross_sell_services_json,claim_tags_json,reconciliation_status,recorded_by,created_at) VALUES ('BCD-HW','voice-1','LEAD-HW','CUS-HW','9876500101','voice','haptik','interested','[\"interested\"]','Interested',1,0,'[]','[]','not_required','haptik_voice',?)").run(now);
  const env = {
    PAWSPACE_APPLICATION_ORIGIN: "https://app.pawspace.in",
    HAPTIK_WHATSAPP_BOOKING_INTENT_TEMPLATE: "haptik_booking_intent_v1",
  };
  const first = await bridge.bridgeHaptikVoiceOutcomeToWhatsApp(db, env, {
    dispositionId: "BCD-HW",
    dispositionIdempotencyKey: "voice-1",
    journeyCode: "booking_intent",
    bookingId: "BOOK-HW",
    paymentLinkPath: "/pay/BOOK-HW",
    actorId: "haptik_voice",
    asOf: now,
  });
  assert.equal(first.queued, true);
  assert.equal(first.templateKey, "haptik_booking_intent_v1");
  assert.equal(first.paymentUrl, "https://app.pawspace.in/pay/BOOK-HW");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c, 1);

  const msg = sqlite.prepare("SELECT template_key,payload_json,idempotency_key FROM communication_messages WHERE id=?").get(first.messageId);
  assert.equal(msg.template_key, "haptik_booking_intent_v1");
  assert.equal(JSON.parse(msg.payload_json).paymentUrl, "https://app.pawspace.in/pay/BOOK-HW");

  const replay = await bridge.bridgeHaptikVoiceOutcomeToWhatsApp(db, env, {
    dispositionId: "BCD-HW",
    dispositionIdempotencyKey: "voice-1",
    journeyCode: "booking_intent",
    bookingId: "BOOK-HW",
    paymentLinkPath: "/pay/BOOK-HW",
    actorId: "haptik_voice",
    asOf: now,
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c, 1);
});

test("opted-out contacts never receive an outbox row", async () => {
  const { sqlite, db, bridge, now } = await world({ optOut: 1 });
  sqlite.prepare("INSERT INTO bot_call_dispositions (id,idempotency_key,lead_id,contact_id,phone,channel,bot_provider,primary_tag,tags_json,crm_outcome,contacted,opted_out,cross_sell_services_json,claim_tags_json,reconciliation_status,recorded_by,created_at) VALUES ('BCD-OPT','voice-opt','LEAD-HW','CUS-HW','9876500101','voice','haptik','interested','[\"interested\"]','Interested',1,0,'[]','[]','not_required','haptik_voice',?)").run(now);
  const out = await bridge.bridgeHaptikVoiceOutcomeToWhatsApp(db, {
    PAWSPACE_APPLICATION_ORIGIN: "https://app.pawspace.in",
    HAPTIK_WHATSAPP_BOOKING_INTENT_TEMPLATE: "haptik_booking_intent_v1",
  }, {
    dispositionId: "BCD-OPT",
    dispositionIdempotencyKey: "voice-opt",
    journeyCode: "booking_intent",
    bookingId: "BOOK-HW",
    paymentLinkPath: "/pay/BOOK-HW",
  });
  assert.match(out.status, /opted_out/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c, 0);
});

test("unapproved templates and off-origin payment links fail closed", async () => {
  const { sqlite, db, bridge, now } = await world({ templateStatus: "submitted" });
  sqlite.prepare("INSERT INTO bot_call_dispositions (id,idempotency_key,lead_id,contact_id,phone,channel,bot_provider,primary_tag,tags_json,crm_outcome,contacted,opted_out,cross_sell_services_json,claim_tags_json,reconciliation_status,recorded_by,created_at) VALUES ('BCD-GATE','voice-gate','LEAD-HW','CUS-HW','9876500101','voice','haptik','interested','[\"interested\"]','Interested',1,0,'[]','[]','not_required','haptik_voice',?)").run(now);
  const env = {
    PAWSPACE_APPLICATION_ORIGIN: "https://app.pawspace.in",
    HAPTIK_WHATSAPP_BOOKING_INTENT_TEMPLATE: "haptik_booking_intent_v1",
  };
  const template = await bridge.bridgeHaptikVoiceOutcomeToWhatsApp(db, env, {
    dispositionId: "BCD-GATE",
    dispositionIdempotencyKey: "voice-gate",
    journeyCode: "booking_intent",
    bookingId: "BOOK-HW",
    paymentLinkPath: "/pay/BOOK-HW",
  });
  assert.equal(template.status, "approved_template_required");

  sqlite.prepare("UPDATE whatsapp_uat_templates SET status='approved' WHERE template_key='haptik_booking_intent_v1'").run();
  const badLink = await bridge.bridgeHaptikVoiceOutcomeToWhatsApp(db, env, {
    dispositionId: "BCD-GATE",
    dispositionIdempotencyKey: "voice-gate",
    journeyCode: "booking_intent",
    bookingId: "BOOK-HW",
    paymentLinkPath: "https://evil.example/pay",
  });
  assert.equal(badLink.status, "payment_link_origin_rejected");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c, 0);
});
