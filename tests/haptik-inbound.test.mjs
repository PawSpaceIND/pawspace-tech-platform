import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

// ---------------------------------------------------------------------------
// The INBOUND voice agent - real execution of the real modules.
//
// Three properties this suite exists to hold:
//
//   An inbound enquiry lands in the CRM the rest of the business already works,
//   not in a bot-shaped side table, and a complaint gets an owner and a clock
//   rather than a slot in a lead queue.
//
//   A transfer to a human is fail-closed. With no queue configured the bot is
//   told so and offers a callback; it never transfers a customer into silence.
//
//   The FAQ answers only from approved, currently-active knowledge. "I don't
//   know" is a real answer here - the bot must not improvise.
// ---------------------------------------------------------------------------
installWorkersHooks("__HAPTIK_INBOUND_DB__");

const PHONE = "+919876500333";

async function world() {
  const { sqlite, db, reset } = freshCountingD1();
  globalThis.__HAPTIK_INBOUND_DB__ = db;
  const haptik = await import("../lib/haptik-integration-governance.ts");
  const cases = await import("../lib/unified-case-center.ts");
  const aiConfig = await import("../lib/ai-business-configuration.ts");
  const inbound = await import("../lib/haptik-inbound-governance.ts");
  // Owning-module DDL only, so a rename upstream fails here instead of drifting from staging.
  await haptik.ensureHaptikTables(db);
  await cases.ensureUnifiedCaseTables(db);
  await aiConfig.ensureAiBusinessConfiguration(db);
  await inbound.ensureHaptikInboundTables(db);
  reset();
  return { sqlite, db, inbound };
}

const inquiry = (w, overrides = {}) => w.inbound.createHaptikInquiry(w.db, {
  idempotencyKey: "inbound-1", category: "grooming", phone: PHONE, name: "Ravi Kumar",
  preferredLocation: "blr", requirement: "Wants a bath and haircut for a Shih Tzu",
  callRef: "HAPTIK-IN-5001", actorId: "haptik_voice", ...overrides,
});

// ---------------------------------------------------------------------------
// 1. The ten categories the solution document names, mapped onto real services.
// ---------------------------------------------------------------------------
test("every inbound category in the solution document exists and routes to a real service", async () => {
  const { HAPTIK_INQUIRY_CATEGORIES, HAPTIK_INQUIRY_CATEGORY_CODES } = await import("../lib/haptik-inbound-governance.ts");
  for (const required of ["grooming", "dog_training", "boarding", "pet_walking", "veterinary_assistance", "pet_taxi", "pricing_packages", "service_availability", "complaint", "general_enquiry"]) {
    assert.ok(HAPTIK_INQUIRY_CATEGORY_CODES.includes(required), `missing category: ${required}`);
  }
  assert.equal(HAPTIK_INQUIRY_CATEGORIES.length, 10, "the document names exactly ten categories");
  // The bookable categories must use the platform's own service vocabulary, or a bot-captured lead
  // lands in a service queue nothing else recognises.
  const bookable = ["grooming", "dog_training", "boarding", "pet_walking", "pet_taxi"];
  const schedulable = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
  for (const code of bookable) {
    const category = HAPTIK_INQUIRY_CATEGORIES.find(c => c.code === code);
    assert.ok(schedulable.includes(category.service), `${code} maps to ${category.service}, which is not a schedulable service`);
  }
  // A complaint and a veterinary call are not sales enquiries and must open a case.
  assert.equal(HAPTIK_INQUIRY_CATEGORIES.find(c => c.code === "complaint").opensCase, true);
  assert.equal(HAPTIK_INQUIRY_CATEGORIES.find(c => c.code === "veterinary_assistance").opensCase, true);
  assert.equal(HAPTIK_INQUIRY_CATEGORIES.find(c => c.code === "grooming").opensCase, false);
});

test("an unknown category is refused rather than quietly filed as a general enquiry", async () => {
  const w = await world();
  await assert.rejects(() => inquiry(w, { category: "helicopter_rides" }), /Unknown inquiry category/);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM haptik_inquiries").get().c), 0);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM lead_work_items").get().c), 0);
});

// ---------------------------------------------------------------------------
// 2. An enquiry becomes a real CRM lead, on the real SLA clock.
// ---------------------------------------------------------------------------
test("an inbound enquiry writes the CRM contact and governed lead work item a web form writes", async () => {
  const w = await world();
  const result = await inquiry(w);
  assert.equal(result.duplicatePrevented, false);
  assert.ok(result.leadId);
  assert.equal(result.caseId, null, "a grooming enquiry is a lead, not a case");

  const lead = w.sqlite.prepare("SELECT * FROM lead_work_items WHERE id=?").get(result.leadId);
  assert.equal(lead.service, "grooming");
  assert.equal(lead.status, "active");
  assert.ok(Number(lead.first_action_due_at) > Number(lead.assigned_at), "the SLA clock is running");
  assert.ok(Number(lead.manager_alert_at) > Number(lead.first_action_due_at), "so is the manager escalation");

  const contact = w.sqlite.prepare("SELECT * FROM crm_contacts WHERE id=?").get(result.contactId);
  assert.equal(contact.primary_phone, PHONE);
  assert.equal(contact.source, "haptik_voice_inbound");

  const stored = w.sqlite.prepare("SELECT * FROM haptik_inquiries WHERE id=?").get(result.inquiryId);
  assert.equal(stored.category, "grooming");
  assert.equal(stored.call_ref, "HAPTIK-IN-5001");
  assert.match(String(stored.requirement), /Shih Tzu/);
});

test("a caller the CRM already knows joins their existing lead instead of forking a second one", async () => {
  const w = await world();
  const now = Date.now();
  w.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("CU-KNOWN", "Ravi Kumar", PHONE, "New lead", "Priya", "Website", now, now);
  w.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,0,0,?,?)")
    .run("LEAD-KNOWN", "CU-KNOWN", "Website", "grooming", "Priya", "Sales Manager", now, now + 600000, now + 1800000, now, now);

  const result = await inquiry(w);
  assert.equal(result.contactId, "CU-KNOWN", "the existing CRM contact is reused");
  assert.equal(result.leadId, "LEAD-KNOWN", "and their open lead, so the call joins that history");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM crm_contacts").get().c), 1);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM lead_work_items").get().c), 1);
});

test("a complaint opens a real case with an owner and an SLA, alongside the lead", async () => {
  const w = await world();
  const result = await inquiry(w, { idempotencyKey: "inbound-complaint", category: "complaint", requirement: "Groomer arrived two hours late twice" });
  assert.ok(result.caseId, "a complaint must not sit in a lead queue with no owner");
  const opened = w.sqlite.prepare("SELECT * FROM unified_cases WHERE id=?").get(result.caseId);
  assert.equal(opened.case_type, "customer_complaint");
  assert.equal(opened.severity, "high");
  assert.equal(opened.status, "open");
  assert.equal(opened.owner_team, "customer_experience");
  assert.equal(opened.source_type, "haptik_voice_inbound");
  assert.equal(opened.source_id, "HAPTIK-IN-5001");
  assert.match(String(opened.description), /two hours late/);
});

test("a retried inbound webhook does not turn one phone call into two enquiries", async () => {
  const w = await world();
  const first = await inquiry(w);
  const second = await inquiry(w);
  assert.equal(second.duplicatePrevented, true);
  assert.equal(second.inquiryId, first.inquiryId);
  assert.equal(second.leadId, first.leadId);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM haptik_inquiries").get().c), 1);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM lead_work_items").get().c), 1);
});

test("a retried complaint does not open a second case", async () => {
  const w = await world();
  const first = await inquiry(w, { idempotencyKey: "inbound-c2", category: "complaint" });
  const second = await inquiry(w, { idempotencyKey: "inbound-c2", category: "complaint" });
  assert.equal(second.caseId, first.caseId);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM unified_cases").get().c), 1);
});

// ---------------------------------------------------------------------------
// 3. Transfer to a human - fail-closed, and never lost.
// ---------------------------------------------------------------------------
test("with no queue configured the transfer is refused with a callback fallback, and still opens a case", async () => {
  const w = await world();
  const result = await w.inbound.requestHaptikAgentTransfer(w.db, {
    idempotencyKey: "xfer-1", reason: "customer_asked_for_a_human", phone: PHONE, callRef: "HAPTIK-IN-6001", actorId: "haptik_voice",
  });
  assert.equal(result.status, "no_queue_configured");
  assert.equal(result.destination, null, "the bot is given nowhere to transfer to");
  assert.match(String(result.fallback), /Offer a callback/);
  assert.ok(result.caseId, "the request is never lost even when the transfer cannot happen");
  const opened = w.sqlite.prepare("SELECT * FROM unified_cases WHERE id=?").get(result.caseId);
  assert.equal(opened.case_type, "lead_escalation");
  assert.equal(opened.severity, "high");
});

test("a configured queue returns the destination and records the transfer", async () => {
  const w = await world();
  await w.inbound.setHaptikTransferTarget(w.db, { queueCode: "cx_desk", label: "CX desk", destination: "08040001234", actorId: "ops@pawspace.in" });
  const result = await w.inbound.requestHaptikAgentTransfer(w.db, {
    idempotencyKey: "xfer-2", reason: "bot_low_confidence", phone: PHONE, callRef: "HAPTIK-IN-6002", actorId: "haptik_voice",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.queueCode, "cx_desk");
  assert.equal(result.destination, "08040001234");
  const stored = w.sqlite.prepare("SELECT * FROM haptik_agent_transfers WHERE idempotency_key=?").get("xfer-2");
  assert.equal(stored.status, "ready");
  assert.equal(stored.reason, "bot_low_confidence");
});

test("an inactive queue is not offered, and a truncated destination is refused outright", async () => {
  const w = await world();
  await w.inbound.setHaptikTransferTarget(w.db, { queueCode: "cx_desk", label: "CX desk", destination: "08040001234", active: false, actorId: "ops" });
  const result = await w.inbound.requestHaptikAgentTransfer(w.db, { idempotencyKey: "xfer-3", reason: "x", phone: PHONE, actorId: "haptik_voice" });
  assert.equal(result.status, "no_queue_configured");
  await assert.rejects(() => w.inbound.setHaptikTransferTarget(w.db, { queueCode: "short", label: "Short", destination: "1234", actorId: "ops" }), /valid phone number/);
});

test("the transfer target list never returns a full destination number", async () => {
  const w = await world();
  await w.inbound.setHaptikTransferTarget(w.db, { queueCode: "cx_desk", label: "CX desk", destination: "08040001234", actorId: "ops" });
  const targets = await w.inbound.listHaptikTransferTargets(w.db);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].destinationLast4, "1234");
  assert.equal(JSON.stringify(targets[0]).includes("08040001234"), false);
});

test("a repeated transfer request on the same call returns the first decision", async () => {
  const w = await world();
  const first = await w.inbound.requestHaptikAgentTransfer(w.db, { idempotencyKey: "xfer-4", reason: "x", phone: PHONE, actorId: "haptik_voice" });
  const second = await w.inbound.requestHaptikAgentTransfer(w.db, { idempotencyKey: "xfer-4", reason: "x", phone: PHONE, actorId: "haptik_voice" });
  assert.equal(second.duplicatePrevented, true);
  assert.equal(second.transferId, first.transferId);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM unified_cases").get().c), 1);
});

// ---------------------------------------------------------------------------
// 4. The FAQ answers from approved knowledge only.
// ---------------------------------------------------------------------------
function publishKnowledge(w, { status = "active", scope = "public", text: body = "Doorstep grooming is available in Bengaluru between 9am and 7pm." } = {}) {
  const now = Date.now();
  w.sqlite.prepare("INSERT INTO ai_knowledge_source_versions (id,source_key,version,status,title,source_type,content_text,visibility_scope_json,effective_from,effective_to,immutable_hash,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`KB-${status}-${scope}`, "grooming_faq", 1, status, "Grooming FAQ", "faq", body, JSON.stringify([scope]), now - 1000, null, "hash-1", "ops", now, now);
}

test("the FAQ answers a routine question from approved, active knowledge", async () => {
  const w = await world();
  publishKnowledge(w);
  const result = await w.inbound.haptikFaqAnswer(w.db, { question: "What are your doorstep grooming timings in Bengaluru?", callRef: "HAPTIK-IN-7001" });
  assert.equal(result.answered, true);
  assert.equal(result.approvedCurrentOnly, true);
  assert.equal(result.fallback, null);
  assert.equal(result.answers[0].sourceKey, "grooming_faq");
  assert.match(result.answers[0].content, /9am and 7pm/);
  const logged = w.sqlite.prepare("SELECT * FROM haptik_faq_lookups WHERE call_ref=?").get("HAPTIK-IN-7001");
  assert.equal(Number(logged.answered), 1);
});

test("a draft or retired knowledge version is not repeated to a caller", async () => {
  const w = await world();
  publishKnowledge(w, { status: "draft" });
  const result = await w.inbound.haptikFaqAnswer(w.db, { question: "What are your doorstep grooming timings?" });
  assert.equal(result.answered, false);
  assert.equal(result.answers.length, 0);
  assert.match(String(result.fallback), /transfer to a human or take a callback/);
});

test("with nothing in the knowledge base the bot says it does not know rather than improvising", async () => {
  const w = await world();
  const result = await w.inbound.haptikFaqAnswer(w.db, { question: "Do you groom rabbits?" });
  assert.equal(result.answered, false);
  assert.equal(result.answers.length, 0);
  const logged = w.sqlite.prepare("SELECT * FROM haptik_faq_lookups ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(Number(logged.answered), 0, "an unanswered question is recorded so the gap is visible");
});

// ---------------------------------------------------------------------------
// 5. The ops summary reports what actually happened.
// ---------------------------------------------------------------------------
test("the inbound summary counts enquiries, cases, transfers and FAQ misses", async () => {
  const w = await world();
  await inquiry(w, { idempotencyKey: "s-1", category: "grooming" });
  await inquiry(w, { idempotencyKey: "s-2", category: "complaint", phone: "+919876500444" });
  await w.inbound.requestHaptikAgentTransfer(w.db, { idempotencyKey: "s-3", reason: "x", phone: PHONE, actorId: "haptik_voice" });
  await w.inbound.haptikFaqAnswer(w.db, { question: "Do you groom rabbits?" });

  const summary = await w.inbound.haptikInboundSummary(w.db, { since: 0 });
  const grooming = summary.categories.find(c => c.category === "grooming");
  const complaint = summary.categories.find(c => c.category === "complaint");
  assert.equal(grooming.count, 1);
  assert.equal(grooming.cases, 0);
  assert.equal(complaint.count, 1);
  assert.equal(complaint.cases, 1);
  assert.deepEqual(summary.transfers, [{ status: "no_queue_configured", count: 1 }]);
  assert.equal(summary.faq.unanswered, 1);
  assert.equal(summary.faq.answered, 0);
  // The recent list identifies a caller by the last four digits only.
  assert.equal(summary.recent.length, 2);
  assert.equal(JSON.stringify(summary.recent).includes("9876500333"), false);
});
