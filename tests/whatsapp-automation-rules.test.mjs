import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, staffActor } from "./helpers/ai-harness.mjs";

installAiHooks();
const rules = await import("../lib/whatsapp-automation-rules.ts");

const baseRule = {
  id: "welcome-hours",
  name: "Welcome in working hours",
  enabled: true,
  trigger: "working_hours_open",
  filters: { workingHours: { start: "09:00", end: "18:00", timeZone: "Asia/Kolkata" } },
  actions: [{ type: "send_welcome", text: "Welcome to PawSpace." }],
};

test("working-hours and out-of-office rules evaluate deterministically and are audited exactly once", async () => {
  const { sqlite, db } = freshAiDb();
  await rules.saveWhatsAppAutomationRule(db, baseRule, staffActor.email);
  await rules.saveWhatsAppAutomationRule(db, { ...baseRule, id: "ooo-hours", name: "Out of office", trigger: "working_hours_closed", actions: [{ type: "send_ooo", text: "Our team will reply in working hours." }] }, staffActor.email);
  const openTime = Date.parse("2026-08-27T06:30:00.000Z");
  const open = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "welcome-hours", threadId: "THREAD-RULE", eventId: "EV-OPEN", trigger: "working_hours_open", now: openTime, actorEmail: staffActor.email });
  assert.equal(open.matched, true);
  assert.equal(open.plan[0].requiresGovernedWhatsAppOutbox, true);
  const replay = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "welcome-hours", threadId: "THREAD-RULE", eventId: "EV-OPEN", trigger: "working_hours_open", now: openTime, actorEmail: staffActor.email });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_automation_rule_evaluations WHERE idempotency_key='whatsapp-rule:welcome-hours:EV-OPEN'").get().n, 1);
  const closedTime = Date.parse("2026-08-27T16:30:00.000Z");
  const closed = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "ooo-hours", threadId: "THREAD-RULE", eventId: "EV-CLOSED", trigger: "working_hours_closed", now: closedTime, actorEmail: staffActor.email });
  assert.equal(closed.matched, true);
});

test("keyword rules support an explicit default action without making keyword matching ambiguous", async () => {
  const { db } = freshAiDb();
  await rules.saveWhatsAppAutomationRule(db, { id: "keyword-entry", name: "Keyword chatbot entry", enabled: true, trigger: "inbound_message", filters: { keywords: ["grooming", "training"], defaultAction: false }, actions: [{ type: "start_chatbot", entryPoint: "keyword" }] }, staffActor.email);
  await rules.saveWhatsAppAutomationRule(db, { id: "default-entry", name: "Default chatbot entry", enabled: true, trigger: "inbound_message", filters: { keywords: ["grooming"], defaultAction: true }, actions: [{ type: "start_chatbot", entryPoint: "default" }] }, staffActor.email);
  const keyword = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "keyword-entry", threadId: "THREAD-K", eventId: "EV-K1", trigger: "inbound_message", messageText: "I need grooming", actorEmail: staffActor.email });
  const miss = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "keyword-entry", threadId: "THREAD-K", eventId: "EV-K2", trigger: "inbound_message", messageText: "hello", actorEmail: staffActor.email });
  const fallback = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "default-entry", threadId: "THREAD-K", eventId: "EV-K3", trigger: "inbound_message", messageText: "hello", actorEmail: staffActor.email });
  assert.equal(keyword.matched, true);
  assert.equal(miss.matched, false);
  assert.equal(fallback.matched, true);
});

test("no-response rule contract explicitly distinguishes template, non-template and all-message cases", async () => {
  const { db } = freshAiDb();
  for (const messageClass of ["template", "non_template", "any"]) await rules.saveWhatsAppAutomationRule(db, { id: `nr-${messageClass.replace("_", "-")}`, name: `No response ${messageClass}`, enabled: true, trigger: "customer_no_response", filters: { messageClass }, actions: [{ type: "schedule_no_response", profile: "10m_30m_3h" }] }, staffActor.email);
  const template = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "nr-template", threadId: "THREAD-NR", eventId: "EV-NR1", trigger: "customer_no_response", messageClass: "template", actorEmail: staffActor.email });
  const wrongClass = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "nr-non-template", threadId: "THREAD-NR", eventId: "EV-NR2", trigger: "customer_no_response", messageClass: "template", actorEmail: staffActor.email });
  const any = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "nr-any", threadId: "THREAD-NR", eventId: "EV-NR3", trigger: "customer_no_response", messageClass: "non_template", actorEmail: staffActor.email });
  assert.equal(template.matched, true);
  assert.equal(template.plan[0].durableExecutor, "whatsapp-no-response-sequence");
  assert.equal(wrongClass.matched, false);
  assert.equal(any.matched, true);
});

test("routing actions expose last-assignee, explicit-team and round-robin only through canonical assignment policy", () => {
  for (const action of [{ type: "route", strategy: "last_assignee" }, { type: "route", strategy: "team", teamCode: "sales_blr" }, { type: "route", strategy: "round_robin", teamCode: "sales_blr" }]) {
    const rule = rules.buildWhatsAppAutomationRuleContract({ id: `route-${action.strategy}`, name: `Route ${action.strategy}`, enabled: true, trigger: "inbound_message", actions: [action] });
    assert.equal(rule.actions[0].strategy, action.strategy);
  }
  assert.throws(() => rules.buildWhatsAppAutomationRuleContract({ id: "bad-route", name: "Bad route", enabled: true, trigger: "inbound_message", actions: [{ type: "route", strategy: "round_robin" }] }), (error) => error instanceof Response && error.status === 400);
});

test("webhook and tool actions reject unlisted or unauthenticated targets and remain non-mutating plans", async () => {
  assert.throws(() => rules.buildWhatsAppAutomationRuleContract({ id: "bad-hook", name: "Bad hook", enabled: true, trigger: "inbound_message", actions: [{ type: "webhook", targetKey: "arbitrary_url", authMode: "hmac_sha256" }] }), (error) => error instanceof Response && error.status === 409);
  assert.throws(() => rules.buildWhatsAppAutomationRuleContract({ id: "bad-tool", name: "Bad tool", enabled: true, trigger: "inbound_message", actions: [{ type: "tool", toolKey: "shell", authMode: "service_token" }] }), (error) => error instanceof Response && error.status === 409);
  const { db } = freshAiDb();
  await rules.saveWhatsAppAutomationRule(db, { id: "safe-external", name: "Safe external plan", enabled: true, trigger: "inbound_message", actions: [{ type: "webhook", targetKey: "crm_event", authMode: "hmac_sha256" }, { type: "tool", toolKey: "booking_lookup", authMode: "service_token" }] }, staffActor.email);
  const out = await rules.evaluateWhatsAppAutomationRule(db, { ruleId: "safe-external", threadId: "THREAD-X", eventId: "EV-X", trigger: "inbound_message", actorEmail: staffActor.email });
  assert.equal(out.audited, true);
  assert.equal(out.externalMutation, false);
  assert.equal(out.plan.every((action) => action.allowListed === true && action.authenticated === true && action.externalMutation === false), true);
});
