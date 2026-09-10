import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer } from "./helpers/ai-harness.mjs";

installAiHooks();
const comms = await import("../lib/communication-engine.ts");
const training = await import("../lib/training-provider-projection.ts");
const templates = await import("../lib/whatsapp-template-lifecycle.ts");

test("concurrent first messages converge on one open communication thread", async (t) => {
  const { sqlite, db } = freshAiDb();
  t.after(() => sqlite.close());
  seedCustomer(sqlite, "CUS-RACE", "Synthetic Parent", "9876500081");
  await comms.setCommunicationPreference(db, {
    customerId: "CUS-RACE", serviceUpdates: true, marketing: false, source: "pr679-review",
  });
  const base = {
    customerId: "CUS-RACE", cityId: "blr", channel: "chat", purpose: "transactional",
    templateKey: "booking_chat_probe", payload: { text: "synthetic review probe" },
    createdBy: "pr679-review", bookingId: "BK-RACE", asOf: 1770000000000,
  };
  const [first, second] = await Promise.all([
    comms.enqueueCommunication(db, { ...base, idempotencyKey: "race-message-1" }),
    comms.enqueueCommunication(db, { ...base, idempotencyKey: "race-message-2" }),
  ]);
  assert.equal(first.threadId, second.threadId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads WHERE customer_id='CUS-RACE' AND booking_id='BK-RACE' AND status='open'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE customer_id='CUS-RACE' AND booking_id='BK-RACE'").get().n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_participants WHERE thread_id=? AND participant_type='customer' AND participant_id='CUS-RACE'").get(first.threadId).n, 1);
});

test("trainer requirements expose only fixed operational goal labels", () => {
  const out = training.projectTrainerSession({
    requirements: [
      "Recall", "recall", "Recall practice", "Needs calming before handover",
      "Internal trainer note", "Call parent after six", "owner@example.com", "+91 98765 43210",
    ],
  });
  assert.deepEqual(out.requirements, ["Recall", "Recall practice"]);
  const serialized = JSON.stringify(out);
  for (const privateText of ["Needs calming before handover", "Internal trainer note", "Call parent after six", "owner@example.com", "98765"]) {
    assert.equal(serialized.includes(privateText), false, privateText);
  }
});

async function draft(db, key) {
  await templates.saveWhatsAppTemplateDraft(db, {
    templateKey: key, displayName: "Review template", category: "utility", language: "en",
    body: "Hi {{1}}", sampleValues: ["Synthetic"], actorEmail: "review@pawspace.test",
  });
}

test("missing WhatsApp lifecycle companion cannot approve a submitted template", async (t) => {
  const { sqlite, db } = freshAiDb();
  t.after(() => sqlite.close());
  await draft(db, "review_missing_reconcile");
  await templates.submitWhatsAppTemplate(db, {
    templateKey: "review_missing_reconcile", actorEmail: "review@pawspace.test", reason: "Submit for review closure",
  });
  sqlite.prepare("DELETE FROM whatsapp_template_lifecycle WHERE template_key='review_missing_reconcile'").run();
  await assert.rejects(
    templates.reconcileWhatsAppTemplate(db, {
      templateKey: "review_missing_reconcile", actorEmail: "review@pawspace.test", outcome: "approved",
      metaReference: "META-REVIEW-1", reason: "Verified approval for regression",
    }),
    (error) => error instanceof Response && error.status === 409,
  );
  assert.equal(sqlite.prepare("SELECT status FROM whatsapp_uat_templates WHERE template_key='review_missing_reconcile'").get().status, "submitted");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_template_lifecycle_events WHERE template_key='review_missing_reconcile' AND to_status='approved'").get().n, 0);
});

test("missing WhatsApp lifecycle companion cannot pause an approved template", async (t) => {
  const { sqlite, db } = freshAiDb();
  t.after(() => sqlite.close());
  await draft(db, "review_missing_pause");
  await templates.submitWhatsAppTemplate(db, {
    templateKey: "review_missing_pause", actorEmail: "review@pawspace.test", reason: "Submit for approval regression",
  });
  await templates.reconcileWhatsAppTemplate(db, {
    templateKey: "review_missing_pause", actorEmail: "review@pawspace.test", outcome: "approved",
    metaReference: "META-REVIEW-2", reason: "Verified approval before pause",
  });
  sqlite.prepare("DELETE FROM whatsapp_template_lifecycle WHERE template_key='review_missing_pause'").run();
  await assert.rejects(
    templates.pauseWhatsAppTemplate(db, {
      templateKey: "review_missing_pause", actorEmail: "review@pawspace.test", reason: "Pause regression after missing row",
    }),
    (error) => error instanceof Response && error.status === 409,
  );
  assert.equal(sqlite.prepare("SELECT status FROM whatsapp_uat_templates WHERE template_key='review_missing_pause'").get().status, "approved");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_template_lifecycle_events WHERE template_key='review_missing_pause' AND to_status='paused'").get().n, 0);
});