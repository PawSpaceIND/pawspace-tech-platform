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

test("shared inbox exposes Human, certified Chatbot and AI modes behind governed routing", () => {
  assert.match(page, />Human only<\/Button>/);
  assert.match(page, />Chatbot only<\/Button>/);
  assert.match(page, /Chatbot mode unlocks only after deterministic flow-engine certification/);
  assert.match(page, />AI Assistant<\/Button>/);
  assert.match(control, /chatbotReady:true/);
  assert.match(route, /mode==="chatbot_only"\?"whatsapp\.routing\.chatbot_open":"whatsapp\.routing\.mode"/);
  assert.doesNotMatch(route, /Chatbot mode remains fail-closed until the deterministic chatbot state machine is certified/);
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

// Execute the production routing boundary as well as keeping the UI source assertions.
import {installAiHooks,freshAiDb,seedCustomer,staffActor,inboundMessage} from './helpers/ai-harness.mjs';
installAiHooks();
const routingRuntime=await import('../lib/whatsapp-conversation-control.ts');
test('executed inbox routing refuses AI by default and rejects undocumented mode changes',async t=>{
 const {sqlite,db}=freshAiDb();t.after(()=>sqlite.close());seedCustomer(sqlite,'UI-INBOX-C','UI Fixture','9000000001');
 await routingRuntime.ensureWhatsAppConversationControl(db);
 await inboundMessage(sqlite,db,{threadId:'UI-INBOX-T',customerId:'UI-INBOX-C',text:'Fixture request',channel:'whatsapp',idempotencyKey:'ui-inbox-inbound'});
 const before=await routingRuntime.getWhatsAppConversationMode(db,'UI-INBOX-T');assert.equal(before.mode,'human_only');assert.equal(before.explicit,false);
 await assert.rejects(routingRuntime.assertWhatsAppAiRoutingAllowsReply(db,'UI-INBOX-T'),e=>e instanceof Response&&e.status===409);
 await assert.rejects(routingRuntime.setWhatsAppConversationMode(db,{threadId:'UI-INBOX-T',mode:'ai_assistant',actorEmail:staffActor.email,reason:'short'}),e=>e instanceof Response&&e.status===400);
 assert.equal((await routingRuntime.getWhatsAppConversationMode(db,'UI-INBOX-T')).mode,'human_only');
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_conversation_routing_events WHERE thread_id=?').get('UI-INBOX-T').n,0);
});
