import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer, staffActor, inboundMessage } from "./helpers/ai-harness.mjs";
installAiHooks();
const control = await import("../lib/whatsapp-conversation-control.ts");
const adapter = await import("../lib/whatsapp-uat-adapter.ts");
const lifecycle = await import("../lib/whatsapp-template-lifecycle.ts");
const recovery = await import("../lib/whatsapp-no-response-sequence.ts");

async function world() {
  const { sqlite, db } = freshAiDb();
  seedCustomer(sqlite, "CUS-REC", "Recovery Customer", "9876500099");
  await control.ensureWhatsAppConversationControl(db);
  await lifecycle.ensureWhatsAppTemplateLifecycle(db);
  await recovery.ensureWhatsAppNoResponseSequenceTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,marketing_consent INTEGER NOT NULL DEFAULT 0,service_consent INTEGER NOT NULL DEFAULT 0,whatsapp_consent INTEGER NOT NULL DEFAULT 0,sms_consent INTEGER NOT NULL DEFAULT 0,email_consent INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)");
  await inboundMessage(sqlite, db, { threadId: "THREAD-REC", customerId: "CUS-REC", text: "Grooming", channel: "whatsapp", idempotencyKey: "recovery-inbound" });
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,1,1,1,0,0,0,'uat','test',?)").run("CUS-REC", Date.now());
  sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at,last_outbound_at) VALUES (?,'sandbox_simulator',?,NULL)").run("CUS-REC", Date.now());
  for (const [key, label] of [["booking_recovery_10m","10 minute"],["booking_recovery_30m","30 minute"],["booking_recovery_180m","3 hour"]]) {
    const now = Date.now();
    sqlite.prepare("INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,'approved','marketing','en','test',?)").run(key, now);
    sqlite.prepare("INSERT INTO whatsapp_template_lifecycle (template_key,display_name,body,variables_json,sample_values_json,meta_reconciliation_status,meta_reference,reconciliation_note,submitted_at,approved_at,rejected_at,paused_at,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,'[\"{{1}}\"]','[\"OFFER\"]','approved','META-UAT','verified',?,?,NULL,NULL,'test',?,'test',?)").run(key, `${label} recovery`, `Still want to book with PawSpace? Your approved special offer is {{1}}.`, now, now, now, now);
  }
  await recovery.saveWhatsAppNoResponseConfig(db, { enabled: true, templateKeys: ["booking_recovery_10m","booking_recovery_30m","booking_recovery_180m"], offerType: "special_booking_recovery", offerReference: "RECOVERY-OFFER-UAT", actorEmail: staffActor.email });
  await control.setWhatsAppConversationMode(db, { threadId: "THREAD-REC", mode: "chatbot_only", actorEmail: staffActor.email, reason: "Enable recovery integration proof" });
  return { sqlite, db };
}

async function anchor(sqlite, db) {
  const queued = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-REC", customerId: "CUS-REC", text: "Which area do you need grooming in?", idempotencyKey: "chatbot-anchor", createdBy: "whatsapp-chatbot" });
  assert.equal(queued.queued, true);
  return { id: queued.messageId, createdAt: Number(sqlite.prepare("SELECT created_at FROM communication_messages WHERE id=?").get(queued.messageId).created_at) };
}

test("no-response recovery arms exactly 10m, 30m and 3h from one automated outbound", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only" });
  assert.equal(armed.armed, true);
  const steps = sqlite.prepare("SELECT delay_minutes,due_at,status FROM whatsapp_no_response_steps WHERE sequence_id=? ORDER BY step_index").all(armed.sequenceId);
  assert.deepEqual(steps.map((row) => row.delay_minutes), [10,30,180]);
  assert.deepEqual(steps.map((row) => row.due_at - outbound.createdAt), [10,30,180].map((value) => value * 60_000));
  assert.deepEqual(steps.map((row) => row.status), ["pending","pending","pending"]);
});

test("due sweep queues approved discount template once and retry stays idempotent", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only" });
  const first = await recovery.processDueWhatsAppNoResponseSequences(db, { now: outbound.createdAt + 10 * 60_000 + 1, actorEmail: "system:test-sweep" });
  assert.equal(first.queued, 1);
  const reminder = sqlite.prepare("SELECT template_key,payload_json,idempotency_key FROM communication_messages WHERE idempotency_key=?").get(`whatsapp-recovery:${armed.sequenceId}:1`);
  assert.equal(reminder.template_key, "booking_recovery_10m");
  assert.match(JSON.parse(reminder.payload_json).text, /RECOVERY-OFFER-UAT/);
  const retry = await recovery.processDueWhatsAppNoResponseSequences(db, { now: outbound.createdAt + 10 * 60_000 + 2, actorEmail: "system:test-sweep" });
  assert.equal(retry.queued, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key=?").get(`whatsapp-recovery:${armed.sequenceId}:1`).n, 1);
});

test("customer reply and human takeover cancel all remaining recovery reminders", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only" });
  await recovery.cancelWhatsAppNoResponseSequences(db, { threadId: "THREAD-REC", reason: "customer_replied", now: outbound.createdAt + 60_000 });
  assert.equal(sqlite.prepare("SELECT status FROM whatsapp_no_response_sequences WHERE id=?").get(armed.sequenceId).status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_no_response_steps WHERE sequence_id=? AND status='pending'").get(armed.sequenceId).n, 0);
  const secondAnchor = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-REC", customerId: "CUS-REC", text: "Second question", idempotencyKey: "chatbot-anchor-2", createdBy: "whatsapp-chatbot" });
  const secondCreatedAt = Number(sqlite.prepare("SELECT created_at FROM communication_messages WHERE id=?").get(secondAnchor.messageId).created_at);
  const second = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: secondAnchor.messageId, routingMode: "chatbot_only" });
  await control.setWhatsAppConversationMode(db, { threadId: "THREAD-REC", mode: "human_only", actorEmail: staffActor.email, reason: "Human takes over recovery conversation" });
  const result = await recovery.processDueWhatsAppNoResponseSequences(db, { now: secondCreatedAt + 10 * 60_000 + 1 });
  assert.equal(result.cancelled, 1);
  assert.equal(sqlite.prepare("SELECT cancel_reason FROM whatsapp_no_response_sequences WHERE id=?").get(second.sequenceId).cancel_reason, "human_takeover");
});

test("discount recovery fails closed without marketing consent or approved offer reference", async () => {
  const { sqlite, db } = await world();
  const outbound = await anchor(sqlite, db);
  const armed = await recovery.armWhatsAppNoResponseSequence(db, { threadId: "THREAD-REC", customerId: "CUS-REC", anchorMessageId: outbound.id, routingMode: "chatbot_only" });
  sqlite.prepare("UPDATE customer_contact_preferences SET marketing_consent=0 WHERE customer_id='CUS-REC'").run();
  const result = await recovery.processDueWhatsAppNoResponseSequences(db, { now: outbound.createdAt + 10 * 60_000 + 1 });
  assert.equal(result.cancelled, 1);
  assert.equal(sqlite.prepare("SELECT cancel_reason FROM whatsapp_no_response_sequences WHERE id=?").get(armed.sequenceId).cancel_reason, "marketing_consent_required_for_discount_offer");
  await assert.rejects(() => recovery.saveWhatsAppNoResponseConfig(db, { enabled: true, templateKeys: ["booking_recovery_10m","booking_recovery_30m","booking_recovery_180m"], offerType: "special_booking_recovery", offerReference: "", actorEmail: staffActor.email }), (error) => error instanceof Response && error.status === 409);
});
