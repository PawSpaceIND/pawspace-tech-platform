import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer, staffActor, inboundMessage } from "./helpers/ai-harness.mjs";
installAiHooks();
const control = await import("../lib/whatsapp-conversation-control.ts");
const adapter = await import("../lib/whatsapp-uat-adapter.ts");
const lifecycle = await import("../lib/whatsapp-template-lifecycle.ts");
const recovery = await import("../lib/whatsapp-no-response-sequence.ts");
const BASE_TIME = Date.parse("2026-08-27T12:00:00.000Z");
const policy = { quietHoursStart: "23:00", quietHoursEnd: "06:00", quietHoursTimezone: "Asia/Kolkata", maxMarketingMessagesPer24h: 3 };

async function world() {
  const { sqlite, db } = freshAiDb();
  seedCustomer(sqlite, "CUS-REC", "Recovery Customer", "9876500099");
  await control.ensureWhatsAppConversationControl(db);
  await lifecycle.ensureWhatsAppTemplateLifecycle(db);
  await recovery.ensureWhatsAppNoResponseSequenceTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,marketing_consent INTEGER NOT NULL DEFAULT 0,service_consent INTEGER NOT NULL DEFAULT 0,whatsapp_consent INTEGER NOT NULL DEFAULT 0,sms_consent INTEGER NOT NULL DEFAULT 0,email_consent INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)");
  await inboundMessage(sqlite, db, { threadId: "THREAD-REC", customerId: "CUS-REC", text: "Grooming", channel: "whatsapp", idempotencyKey: "recovery-inbound" });
  // The seed inbound establishes the conversation before the recovery anchor. Keep its fixture time
  // explicitly before BASE_TIME so this suite does not change meaning when wall-clock time passes it.
  sqlite.prepare("UPDATE communication_messages SET created_at=?,updated_at=? WHERE idempotency_key='recovery-inbound'").run(BASE_TIME - 60_000, BASE_TIME - 60_000);
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,1,1,1,0,0,0,'uat','test',?)").run("CUS-REC", BASE_TIME);
  sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at,last_outbound_at) VALUES (?,'sandbox_simulator',?,NULL)").run("CUS-REC", BASE_TIME);
  for (const [key, label] of [["booking_recovery_10m","10 minute"],["booking_recovery_30m","30 minute"],["booking_recovery_180m","3 hour"]]) {
    sqlite.prepare("INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,'approved','marketing','en','test',?)").run(key, BASE_TIME);
    sqlite.prepare("INSERT INTO whatsapp_template_lifecycle (template_key,display_name,body,variables_json,sample_values_json,meta_reconciliation_status,meta_reference,reconciliation_note,submitted_at,approved_at,rejected_at,paused_at,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,'[\"{{1}}\"]','[\"OFFER\"]','approved','META-UAT','verified',?,?,NULL,NULL,'test',?,'test',?)").run(key, `${label} recovery`, `Still want to book with PawSpace? Your approved special offer is {{1}}.`, BASE_TIME, BASE_TIME, BASE_TIME, BASE_TIME);
  }
  await recovery.saveWhatsAppNoResponseConfig(db, { enabled: true, templateKeys: ["booking_recovery_10m","booking_recovery_30m","booking_recovery_180m"], offerType: "special_booking_recovery", offerReference: "RECOVERY-OFFER-UAT", ...policy, actorEmail: staffActor.email });
  await control.setWhatsAppConversationMode(db, { threadId: "THREAD-REC", mode: "chatbot_only", actorEmail: staffActor.email, reason: "Enable recovery integration proof" });
  return { sqlite, db };
}

async function anchor(sqlite, db, createdAt = BASE_TIME) {
  const queued = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-REC", customerId: "CUS-REC", text: "Which area do you need grooming in?", idempotencyKey: `chatbot-anchor-${createdAt}`, createdBy: "whatsapp-chatbot" });
  assert.equal(queued.queued, true);
  sqlite.prepare("UPDATE communication_messages SET created_at=?,updated_at=? WHERE id=?").run(createdAt, createdAt, queued.messageId);
  return { id: queued.messageId, createdAt };
}

test("enabled recovery requires explicit quiet-hours and frequency policy", async () => {
  const { db } = freshAiDb();
  await recovery.ensureWhatsAppNoResponseSequenceTables(db);
  await assert.rejects(() => recovery.saveWhatsAppNoResponseConfig(db, { enabled: true, templateKeys: ["booking_recovery_10m","booking_recovery_30m","booking_recovery_180m"], offerType: "special_booking_recovery", offerReference: "RECOVERY-OFFER-UAT", actorEmail: staffActor.email }), (error) => error instanceof Response && error.status === 409);
});

test("no-response recovery arms exactly 10m, 30m and 3h from one automated outbound", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only", now: BASE_TIME });
  assert.equal(armed.armed, true);
  const steps = sqlite.prepare("SELECT delay_minutes,due_at,status FROM whatsapp_no_response_steps WHERE sequence_id=? ORDER BY step_index").all(armed.sequenceId);
  assert.deepEqual(steps.map((row) => row.delay_minutes), [10,30,180]);
  assert.deepEqual(steps.map((row) => row.due_at - outbound.createdAt), [10,30,180].map((value) => value * 60_000));
  assert.deepEqual(steps.map((row) => row.status), ["pending","pending","pending"]);
});

test("due sweep queues approved discount template once and retry stays idempotent", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only", now: BASE_TIME });
  const first = await recovery.processDueWhatsAppNoResponseSequences(db, { now: outbound.createdAt + 10 * 60_000 + 1, actorEmail: "system:test-sweep" });
  assert.equal(first.queued, 1);
  const reminder = sqlite.prepare("SELECT purpose,template_key,payload_json,idempotency_key FROM communication_messages WHERE idempotency_key=?").get(`whatsapp-recovery:${armed.sequenceId}:1`);
  assert.equal(reminder.purpose, "marketing");
  assert.equal(reminder.template_key, "booking_recovery_10m");
  assert.match(JSON.parse(reminder.payload_json).text, /RECOVERY-OFFER-UAT/);
  const retry = await recovery.processDueWhatsAppNoResponseSequences(db, { now: outbound.createdAt + 10 * 60_000 + 2, actorEmail: "system:test-sweep" });
  assert.equal(retry.queued, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key=?").get(`whatsapp-recovery:${armed.sequenceId}:1`).n, 1);
});

test("quiet hours defer due recovery without creating a message or outbox row", async () => {
  const { sqlite, db } = await world();
  await recovery.saveWhatsAppNoResponseConfig(db, { enabled: true, templateKeys: ["booking_recovery_10m","booking_recovery_30m","booking_recovery_180m"], offerType: "special_booking_recovery", offerReference: "RECOVERY-OFFER-UAT", quietHoursStart: "17:00", quietHoursEnd: "18:00", quietHoursTimezone: "Asia/Kolkata", maxMarketingMessagesPer24h: 3, actorEmail: staffActor.email });
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only", now: BASE_TIME });
  const beforeMessages = sqlite.prepare("SELECT COUNT(*) n FROM communication_messages").get().n;
  const beforeOutbox = sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox").get().n;
  const result = await recovery.processDueWhatsAppNoResponseSequences(db, { now: BASE_TIME + 10 * 60_000 + 1 });
  assert.equal(result.deferred, 1);
  assert.equal(result.results[0].reason, "quiet_hours");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages").get().n, beforeMessages);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox").get().n, beforeOutbox);
  assert.equal(sqlite.prepare("SELECT status FROM whatsapp_no_response_sequences WHERE id=?").get(armed.sequenceId).status, "active");
});

test("rolling 24-hour marketing cap defers recovery without business mutation", async () => {
  const { sqlite, db } = await world();
  await recovery.saveWhatsAppNoResponseConfig(db, { enabled: true, templateKeys: ["booking_recovery_10m","booking_recovery_30m","booking_recovery_180m"], offerType: "special_booking_recovery", offerReference: "RECOVERY-OFFER-UAT", ...policy, maxMarketingMessagesPer24h: 1, actorEmail: staffActor.email });
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only", now: BASE_TIME });
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,provider,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('MSG-PRIOR-MKT','THREAD-REC','CUS-REC','outbound','whatsapp','marketing','booking_recovery_10m','{}','sent','sandbox_simulator','prior-marketing','{}','test',?,?)").run(BASE_TIME - 60 * 60_000, BASE_TIME - 60 * 60_000);
  const beforeOutbox = sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox").get().n;
  const result = await recovery.processDueWhatsAppNoResponseSequences(db, { now: BASE_TIME + 10 * 60_000 + 1 });
  assert.equal(result.deferred, 1);
  assert.equal(result.results[0].reason, "marketing_frequency_cap");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key=?").get(`whatsapp-recovery:${armed.sequenceId}:1`).n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox").get().n, beforeOutbox);
});

test("customer reply and human takeover cancel all remaining recovery reminders", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only", now: BASE_TIME });
  await recovery.cancelWhatsAppNoResponseSequences(db, { threadId: "THREAD-REC", reason: "customer_replied", now: BASE_TIME + 60_000 });
  assert.equal(sqlite.prepare("SELECT status FROM whatsapp_no_response_sequences WHERE id=?").get(armed.sequenceId).status, "cancelled");
  const secondAnchor = await anchor(sqlite, db, BASE_TIME + 5 * 60_000);
  const second = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: secondAnchor.id, routingMode: "chatbot_only", now: BASE_TIME + 5 * 60_000 });
  await control.setWhatsAppConversationMode(db, { threadId: "THREAD-REC", mode: "human_only", actorEmail: staffActor.email, reason: "Human takes over recovery conversation" });
  const result = await recovery.processDueWhatsAppNoResponseSequences(db, { now: secondAnchor.createdAt + 10 * 60_000 + 1 });
  assert.equal(result.cancelled, 1);
  assert.equal(sqlite.prepare("SELECT cancel_reason FROM whatsapp_no_response_sequences WHERE id=?").get(second.sequenceId).cancel_reason, "human_takeover");
});

test("routing-state lookup failure defers recovery instead of cancelling as human takeover", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only", now: BASE_TIME });
  const routingSelect = "SELECT mode,updated_by,reason,updated_at FROM whatsapp_conversation_routing_modes WHERE thread_id=?";
  const failingDb = {
    ...db,
    prepare(sql) {
      if (sql === routingSelect) return { bind: () => ({ first: async () => { throw new Error("simulated routing-state read failure"); } }) };
      return db.prepare(sql);
    },
  };
  const sweepAt = outbound.createdAt + 10 * 60_000 + 1;
  const result = await recovery.processDueWhatsAppNoResponseSequences(failingDb, { now: sweepAt, actorEmail: "system:test-routing-failure" });
  assert.equal(result.deferred, 1);
  assert.equal(result.cancelled, 0);
  assert.equal(result.results[0].reason, "routing_state_unavailable");
  const sequence = sqlite.prepare("SELECT status,cancel_reason FROM whatsapp_no_response_sequences WHERE id=?").get(armed.sequenceId);
  assert.equal(sequence.status, "active");
  assert.equal(sequence.cancel_reason, null);
  const step = sqlite.prepare("SELECT status,reason,due_at FROM whatsapp_no_response_steps WHERE id=?").get(result.results[0].stepId);
  assert.equal(step.status, "pending");
  assert.equal(step.reason, "routing_state_unavailable");
  assert.equal(step.due_at, sweepAt + 5 * 60_000);
});

test("discount recovery fails closed without marketing consent or approved offer reference", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only", now: BASE_TIME });
  sqlite.prepare("UPDATE customer_contact_preferences SET marketing_consent=0 WHERE customer_id='CUS-REC'").run();
  const result = await recovery.processDueWhatsAppNoResponseSequences(db, { now: outbound.createdAt + 10 * 60_000 + 1 });
  assert.equal(result.cancelled, 1);
  assert.equal(sqlite.prepare("SELECT cancel_reason FROM whatsapp_no_response_sequences WHERE id=?").get(armed.sequenceId).cancel_reason, "marketing_consent_required_for_discount_offer");
  await assert.rejects(() => recovery.saveWhatsAppNoResponseConfig(db, { enabled: true, templateKeys: ["booking_recovery_10m","booking_recovery_30m","booking_recovery_180m"], offerType: "special_booking_recovery", offerReference: "", ...policy, actorEmail: staffActor.email }), (error) => error instanceof Response && error.status === 409);
});
