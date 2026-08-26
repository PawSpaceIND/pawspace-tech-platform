import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const engine = fs.readFileSync("lib/whatsapp-no-response-sequence.ts", "utf8");
const webhook = fs.readFileSync("lib/meta-whatsapp-webhook.ts", "utf8");
const api = fs.readFileSync("app/api/whatsapp/automation/route.ts", "utf8");
const page = fs.readFileSync("app/team/whatsapp/automation/page.tsx", "utf8");
const worker = fs.readFileSync("worker/index.ts", "utf8");

test("recovery profile is exactly 10 minutes, 30 minutes and 3 hours with durable idempotency", () => {
  assert.match(engine, /\[10, 30, 180\]/);
  assert.match(engine, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(engine, /whatsapp-recovery:\$\{sequenceId\}:\$\{index \+ 1\}/);
  assert.match(engine, /duplicate_claim_prevented/);
});

test("new inbound cancels recovery before chatbot can arm its next sequence", () => {
  const duplicate = webhook.indexOf("if(inbound.duplicatePrevented)");
  const cancel = webhook.indexOf("await cancelWhatsAppNoResponseSequences");
  const route = webhook.indexOf("await routeInboundAutomation");
  assert.ok(duplicate >= 0 && cancel > duplicate && route > cancel);
  assert.match(webhook, /customer_opted_out/);
  assert.match(webhook, /customer_replied/);
});

test("chatbot outbound can arm recovery while ai_pending cannot", () => {
  assert.match(webhook, /armWhatsAppNoResponseSequence/);
  assert.match(webhook, /routingMode:"chatbot_only"/);
  const aiPending = webhook.indexOf('routing.mode==="ai_assistant"');
  const chatbot = webhook.indexOf("runWhatsAppChatbotTurn");
  assert.ok(aiPending >= 0 && chatbot > aiPending, "AI pending returns before chatbot/recovery dispatch");
  assert.doesNotMatch(webhook.slice(aiPending, chatbot), /armWhatsAppNoResponseSequence/);
});

test("discount recovery requires consent, marketing template and a business offer reference", () => {
  assert.match(engine, /marketing_consent_required_for_discount_offer/);
  assert.match(engine, /recovery_discount_template_must_be_marketing/);
  assert.match(engine, /approved business offer reference/i);
  assert.match(engine, /PawSpace never invents a discount amount|offerReference/);
});

test("scheduled worker runs the retry-safe recovery sweep automatically", () => {
  assert.match(worker, /processDueWhatsAppNoResponseSequences/);
  assert.match(worker, /processDueWhatsAppNoResponseSequences\(env\.DB,\{now:controller\.scheduledTime,actorEmail:"system:scheduled-worker"\}\)/);
  assert.match(worker, /whatsapp recovery:/);
});

test("Automation Studio and API remain UAT-only and authorization-gated", () => {
  assert.match(api, /authorize\(request, "communications\.manage"\)/);
  assert.match(api, /sameOrigin\(request\)/);
  assert.match(api, /process_due_uat/);
  assert.match(page, /10 minutes → 30 minutes → 3 hours/);
  assert.match(page, /Production delivery disabled/);
  assert.match(page, /Run due sweep in UAT/);
  assert.doesNotMatch(engine, /externalDelivery:\s*true/);
});
