import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer, inboundMessage, NOW } from "./helpers/ai-harness.mjs";

installAiHooks();
const mod = await import("../lib/whatsapp-interactive-capture.ts");

async function world() {
  const { sqlite, db } = freshAiDb();
  seedCustomer(sqlite, "CUS-I", "Interactive Customer", "9876500022");
  await inboundMessage(sqlite, db, { threadId: "THREAD-I", customerId: "CUS-I", text: "start", channel: "whatsapp", idempotencyKey: "interactive-in" });
  await mod.ensureWhatsAppInteractiveCapture(db);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LEAD-I','CUS-I','meta','grooming','agent','manager','active','day_1',1,?,?,?,?,?)").run(NOW, NOW, NOW, NOW, NOW);
  sqlite.prepare("UPDATE communication_threads SET lead_id='LEAD-I' WHERE id='THREAD-I'").run();
  return { sqlite, db };
}

test("governed reply buttons and lists enforce Meta-style bounds and stay delivery-disabled", () => {
  const buttons = mod.buildWhatsAppInteractiveContract({ kind: "reply_buttons", body: "Choose", buttons: [{ id: "groom", title: "Grooming" }, { id: "board", title: "Boarding" }] });
  assert.equal(buttons.externalDelivery, false);
  assert.equal(buttons.buttons.length, 2);
  const list = mod.buildWhatsAppInteractiveContract({ kind: "list", body: "Choose service", sections: [{ title: "Services", rows: [{ id: "groom", title: "Grooming" }, { id: "train", title: "Training", description: "Doorstep training" }] }] });
  assert.equal(list.externalDelivery, false);
  assert.equal(list.sections[0].rows.length, 2);
  assert.throws(() => mod.buildWhatsAppInteractiveContract({ kind: "reply_buttons", body: "Choose", buttons: [1, 2, 3, 4].map((i) => ({ id: `x${i}`, title: `Option ${i}` })) }), (error) => error instanceof Response && error.status === 400);
});

test("Flow submission validates canonical identity/schema and is idempotent without creating parallel business stores", async () => {
  const { sqlite, db } = await world();
  const input = { provider: "meta_whatsapp", externalEventId: "FLOW-1", threadId: "THREAD-I", customerId: "CUS-I", leadId: "LEAD-I", messageType: "flow", schemaKey: "lead_qualification_v1", response: { serviceCode: "grooming", city: "Bengaluru" } };
  const first = await mod.recordWhatsAppInteractiveSubmission(db, input), second = await mod.recordWhatsAppInteractiveSubmission(db, input);
  assert.equal(first.parallelCustomerOrOrderStore, false);
  assert.equal(first.canonicalTarget, "canonical_lead");
  assert.equal(second.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_interactive_submissions").get().n, 1);
  await assert.rejects(() => mod.recordWhatsAppInteractiveSubmission(db, { ...input, externalEventId: "FLOW-2", response: { serviceCode: "grooming" } }), (error) => error instanceof Response && error.status === 400);
  await assert.rejects(() => mod.recordWhatsAppInteractiveSubmission(db, { ...input, externalEventId: "FLOW-3", customerId: "CUS-OTHER" }), (error) => error instanceof Response && error.status === 409);
  await assert.rejects(() => mod.recordWhatsAppInteractiveSubmission(db, { ...input, externalEventId: "FLOW-4", schemaKey: "unapproved_flow" }), (error) => error instanceof Response && error.status === 409);
});

test("booking-detail, survey and feedback Flows map only to governed canonical targets", async () => {
  const { db } = await world();
  const booking = await mod.recordWhatsAppInteractiveSubmission(db, { provider: "meta_whatsapp", externalEventId: "FLOW-BOOK", threadId: "THREAD-I", customerId: "CUS-I", leadId: "LEAD-I", messageType: "flow", schemaKey: "booking_details_v1", response: { serviceCode: "grooming", city: "Bengaluru", preferredDate: "2026-08-30" } });
  const survey = await mod.recordWhatsAppInteractiveSubmission(db, { provider: "meta_whatsapp", externalEventId: "FLOW-SURVEY", threadId: "THREAD-I", customerId: "CUS-I", leadId: "LEAD-I", messageType: "flow", schemaKey: "survey_v1", response: { rating: 5, comment: "Great" } });
  const feedback = await mod.recordWhatsAppInteractiveSubmission(db, { provider: "meta_whatsapp", externalEventId: "FLOW-FEEDBACK", threadId: "THREAD-I", customerId: "CUS-I", leadId: "LEAD-I", messageType: "flow", schemaKey: "feedback_v1", response: { rating: 4 } });
  assert.equal(booking.canonicalTarget, "governed_booking_tool");
  assert.equal(survey.canonicalTarget, "conversation_feedback");
  assert.equal(feedback.canonicalTarget, "conversation_feedback");
  assert.equal([booking, survey, feedback].every((item) => item.parallelCustomerOrOrderStore === false && item.externalDelivery === false), true);
});
