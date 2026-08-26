import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const page = read("app/team/customer-experience/page.tsx");
const route = read("app/api/whatsapp/conversation-control/route.ts");
const control = read("lib/whatsapp-conversation-control.ts");

test("shared inbox uses the governed WhatsApp conversation-control API", () => {
  assert.match(page, /\/api\/whatsapp\/conversation-control/);
  assert.match(page, /controlAct\("human_reply"/);
  assert.match(page, /controlAct\("take_over"/);
  assert.match(page, /"resume_ai"/);
  assert.match(page, /mode:\s*"ai_assistant"/);
  assert.match(page, /mode:\s*"human_only"/);
});

test("shared inbox exposes Human and AI modes while chatbot remains fail-closed", () => {
  assert.match(page, />Human only<\/Button>/);
  assert.match(page, />Chatbot only<\/Button>/);
  assert.match(page, /Chatbot mode unlocks only after deterministic flow-engine certification/);
  assert.match(page, />AI Assistant<\/Button>/);
  assert.match(route, /Chatbot mode remains fail-closed until the deterministic chatbot state machine is certified/);
});

test("human reply stays inside service-window and governed outbox constraints", () => {
  assert.match(page, /canSendHumanReply/);
  assert.match(page, /24-hour window closed — use an approved template/);
  assert.match(control, /queueWhatsAppUatOutbound/);
  assert.match(control, /Take over the conversation before sending a human reply/);
  assert.match(route, /authorize\(request,"communications.manage"\)/);
  assert.match(route, /Cross-origin WhatsApp conversation control write blocked/);
});

test("AI mode is explicit and production delivery remains disabled", () => {
  assert.match(control, /fail_closed_default/);
  assert.match(control, /WhatsApp AI replies are disabled while routing mode is/);
  assert.match(page, /Production delivery disabled/);
  assert.match(route, /productionDelivery:false/);
});
