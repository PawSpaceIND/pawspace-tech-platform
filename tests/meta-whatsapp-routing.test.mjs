import assert from"node:assert/strict";
import fs from"node:fs";
import test from"node:test";

const source=fs.readFileSync("lib/meta-whatsapp-webhook.ts","utf8");

test("Meta inbound routing dispatches only after canonical capture and duplicate rejection",()=>{
 assert.match(source,/recordWhatsAppUatInbound/);
 assert.match(source,/if\(inbound\.duplicatePrevented\)/);
 assert.match(source,/inputMessageId:input\.messageId/);
 assert.match(source,/messageId:inbound\.messageId/);
 const duplicateGuard=source.indexOf("if(inbound.duplicatePrevented)");
 const routerCall=source.indexOf("const routed=await routeInboundAutomation");
 assert.ok(duplicateGuard>=0&&routerCall>duplicateGuard,"duplicate webhook deliveries must be rejected before automation routing");
});

test("Meta inbound routing keeps the three conversation modes explicit and fail closed",()=>{
 assert.match(source,/getWhatsAppConversationMode/);
 assert.match(source,/routing\.mode==="human_only"/);
 assert.match(source,/routing\.mode==="ai_assistant"/);
 assert.match(source,/runWhatsAppChatbotTurn/);
 assert.match(source,/status:"ai_pending"/);
 assert.match(source,/governed_ai_executor_required/);
 assert.doesNotMatch(source,/authorizeContext\(/);
});

test("Human ownership blocks automation even if another routing mode was configured",()=>{
 assert.match(source,/if\(input\.humanOwned\)return\{status:"received",routingMode:"human_only"/);
 const humanOwnershipGuard=source.indexOf("if(input.humanOwned)");
 const chatbotDispatch=source.indexOf("await runWhatsAppChatbotTurn");
 assert.ok(humanOwnershipGuard>=0&&chatbotDispatch>humanOwnershipGuard,"human ownership must be evaluated before chatbot dispatch");
});

test("Chatbot dispatch failures switch to human-only routing and create a provider-error handoff",()=>{
 assert.match(source,/setWhatsAppConversationMode/);
 assert.match(source,/mode:"human_only"/);
 assert.match(source,/requestAiHumanHandoff/);
 assert.match(source,/reason:"provider_error"/);
 assert.match(source,/automationReason:"chatbot_dispatch_failed"/);
});

test("Production external delivery remains disabled in the Meta webhook slice",()=>{
 assert.match(source,/externalDelivery:false/);
 assert.doesNotMatch(source,/externalDelivery:true/);
});
