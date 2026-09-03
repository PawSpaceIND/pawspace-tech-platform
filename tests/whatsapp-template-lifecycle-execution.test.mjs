import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installAiHooks, freshAiDb, seedCustomer, staffActor, inboundMessage } from "./helpers/ai-harness.mjs";

installAiHooks();
const lifecycle = await import("../lib/whatsapp-template-lifecycle.ts");
const adapter = await import("../lib/whatsapp-uat-adapter.ts");
const customer360 = await import("../lib/customer-360.ts");

async function world() {
  const { sqlite, db } = freshAiDb();
  seedCustomer(sqlite, "CUS-TPL-1", "Asha", "9876500091");
  await customer360.ensureCustomer360Tables(db);
  await lifecycle.ensureWhatsAppTemplateLifecycle(db);
  await inboundMessage(sqlite, db, { threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "Need grooming", channel: "whatsapp", idempotencyKey: "tpl-inbound" });
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'uat','test',?)").run("CUS-TPL-1", Date.now());
  return { sqlite, db };
}

test("draft validation persists deterministic variables and sample payload", async () => {
  const { sqlite, db } = await world();
  await assert.rejects(lifecycle.saveWhatsAppTemplateDraft(db, { templateKey: "broken_vars", displayName: "Broken vars", category: "utility", language: "en", body: "Hi {{1}}, booking {{3}}", sampleValues: ["Asha", "BK-1"], actorEmail: staffActor.email }), (error) => error instanceof Response && error.status === 400);
  const saved = await lifecycle.saveWhatsAppTemplateDraft(db, { templateKey: "booking_followup", displayName: "Booking follow-up", category: "utility", language: "en", body: "Hi {{1}}, booking {{2}} is ready.", sampleValues: ["Asha", "BK-42"], actorEmail: staffActor.email });
  assert.equal(saved.status, "draft");
  assert.equal(saved.productionDelivery, false);
  assert.equal(saved.samplePayload.renderedBody, "Hi Asha, booking BK-42 is ready.");
  const row = sqlite.prepare("SELECT status,category,approved_language FROM whatsapp_uat_templates WHERE template_key=?").get("booking_followup");
  assert.deepEqual({ ...row }, { status: "draft", category: "utility", approved_language: "en" });
  const event = sqlite.prepare("SELECT event_type,to_status FROM whatsapp_template_lifecycle_events WHERE template_key=? ORDER BY created_at DESC LIMIT 1").get("booking_followup");
  assert.equal(event.event_type, "draft_created");
  assert.equal(event.to_status, "draft");
});

test("template send is blocked until verified approval and pause disables it again", async () => {
  const { db } = await world();
  await lifecycle.saveWhatsAppTemplateDraft(db, { templateKey: "service_followup", displayName: "Service follow-up", category: "utility", language: "en", body: "Hi {{1}}, can we help with {{2}}?", sampleValues: ["Asha", "grooming"], actorEmail: staffActor.email });
  const blockedDraft = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "draft must not send", idempotencyKey: "tpl-draft-send", createdBy: staffActor.email, templateKey: "service_followup", language: "en" });
  assert.equal(blockedDraft.queued, false);
  assert.equal(blockedDraft.reason, "approved_template_required");
  const submitted = await lifecycle.submitWhatsAppTemplate(db, { templateKey: "service_followup", actorEmail: staffActor.email, reason: "Submit after internal content review" });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.externalMetaMutation, false);
  const blockedSubmitted = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "submitted must not send", idempotencyKey: "tpl-submitted-send", createdBy: staffActor.email, templateKey: "service_followup", language: "en" });
  assert.equal(blockedSubmitted.queued, false);
  const approved = await lifecycle.reconcileWhatsAppTemplate(db, { templateKey: "service_followup", actorEmail: staffActor.email, outcome: "approved", metaReference: "META-TPL-9001", reason: "Verified approved status in Meta manager" });
  assert.equal(approved.status, "approved");
  const queued = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "approved template send", idempotencyKey: "tpl-approved-send", createdBy: staffActor.email, templateKey: "service_followup", language: "en" });
  assert.equal(queued.queued, true);
  assert.equal(queued.externalDelivery, false);
  const paused = await lifecycle.pauseWhatsAppTemplate(db, { templateKey: "service_followup", actorEmail: staffActor.email, reason: "Pause after operator lifecycle verification" });
  assert.equal(paused.status, "paused");
  const blockedPaused = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "paused must not send", idempotencyKey: "tpl-paused-send", createdBy: staffActor.email, templateKey: "service_followup", language: "en" });
  assert.equal(blockedPaused.queued, false);
  assert.equal(blockedPaused.reason, "approved_template_required");
});

test("unapproved template is blocked even inside an active 24-hour session", async () => {
  const { sqlite, db } = await world();
  await adapter.ensureWhatsAppUatTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at,last_outbound_at) VALUES ('CUS-TPL-1','sandbox_simulator',?,NULL)").run(Date.now());
  await lifecycle.saveWhatsAppTemplateDraft(db, { templateKey: "inside_session_draft", displayName: "Inside session draft", category: "utility", language: "en", body: "Hi {{1}}", sampleValues: ["Asha"], actorEmail: staffActor.email });
  const beforeMessages = sqlite.prepare("SELECT COUNT(*) n FROM communication_messages").get().n;
  const beforeOutbox = sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox").get().n;
  const blocked = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "must stay blocked", idempotencyKey: "inside-session-draft", createdBy: staffActor.email, templateKey: "inside_session_draft", language: "en" });
  assert.equal(blocked.queued, false);
  assert.equal(blocked.reason, "approved_template_required");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages").get().n, beforeMessages);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox").get().n, beforeOutbox);
});

test("marketing template send requires explicit marketing consent even inside the session", async () => {
  const { sqlite, db } = await world();
  await adapter.ensureWhatsAppUatTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at,last_outbound_at) VALUES ('CUS-TPL-1','sandbox_simulator',?,NULL)").run(Date.now());
  await lifecycle.saveWhatsAppTemplateDraft(db, { templateKey: "marketing_offer", displayName: "Marketing offer", category: "marketing", language: "en", body: "Offer {{1}}", sampleValues: ["OFFER"], actorEmail: staffActor.email });
  await lifecycle.submitWhatsAppTemplate(db, { templateKey: "marketing_offer", actorEmail: staffActor.email, reason: "submit for review" });
  await lifecycle.reconcileWhatsAppTemplate(db, { templateKey: "marketing_offer", actorEmail: staffActor.email, outcome: "approved", metaReference: "META-MKT-1", reason: "verified" });
  const blocked = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "Offer", idempotencyKey: "marketing-no-consent", createdBy: staffActor.email, templateKey: "marketing_offer", language: "en" });
  assert.equal(blocked.queued, false);
  assert.equal(blocked.reason, "marketing_consent_required");
});

test("rejected reconciliation cannot activate the canonical outbox gate", async () => {
  const { db } = await world();
  await lifecycle.saveWhatsAppTemplateDraft(db, { templateKey: "rejected_followup", displayName: "Rejected follow-up", category: "utility", language: "en", body: "Hi {{1}}", sampleValues: ["Asha"], actorEmail: staffActor.email });
  await lifecycle.submitWhatsAppTemplate(db, { templateKey: "rejected_followup", actorEmail: staffActor.email, reason: "Submit for provider reconciliation" });
  await lifecycle.reconcileWhatsAppTemplate(db, { templateKey: "rejected_followup", actorEmail: staffActor.email, outcome: "rejected", metaReference: "META-REJ-4", reason: "Verified rejected status in Meta manager" });
  const blocked = await adapter.queueWhatsAppUatOutbound(db, { provider: "sandbox_simulator", threadId: "THREAD-TPL-1", customerId: "CUS-TPL-1", text: "rejected must not send", idempotencyKey: "tpl-rejected-send", createdBy: staffActor.email, templateKey: "rejected_followup", language: "en" });
  assert.equal(blocked.queued, false);
});

test("template API and console preserve permission, audit and no-live-Meta boundaries", () => {
  const route = fs.readFileSync("app/api/whatsapp/templates/route.ts", "utf8");
  const page = fs.readFileSync("app/team/whatsapp/templates/page.tsx", "utf8");
  assert.match(route, /authorize\(request, "communications\.manage"\)/);
  assert.match(route, /Cross-origin WhatsApp template write blocked/);
  assert.match(route, /whatsapp\.template\.draft_saved/);
  assert.match(route, /whatsapp\.template\.submitted/);
  assert.match(route, /externalMetaMutation: false/);
  assert.match(page, /\/api\/whatsapp\/templates/);
  assert.match(page, /No live Meta mutation/);
  assert.match(page, /Verify with Meta/);
  assert.match(page, /There is no manual approve\/reject control/);
  assert.match(page, /Production delivery disabled/);
});