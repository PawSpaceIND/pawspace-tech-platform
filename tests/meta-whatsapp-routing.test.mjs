import assert from"node:assert/strict";
import fs from"node:fs";
import test from"node:test";

const source=fs.readFileSync("lib/meta-whatsapp-webhook.ts","utf8");

test("Meta inbound routing dispatches only after canonical capture and duplicate rejection",()=>{
 assert.match(source,/recordWhatsAppUatInbound/);
 assert.match(source,/if\(inbound\.duplicatePrevented\)/);
 assert.match(source,/inputMessageId:input\.messageId/);
 assert.match(source,/messageId:inbound\.messageId/);
 assert.match(source,/eventId:event\.eventId/);
 const duplicateGuard=source.indexOf("if(inbound.duplicatePrevented)");
 const routerCall=source.indexOf("const routed=await routeInboundAutomation");
 assert.ok(duplicateGuard>=0&&routerCall>duplicateGuard,"duplicate webhook deliveries must be rejected before automation routing");
});

test("Meta inbound routing keeps the three conversation modes explicit and fail closed",()=>{
 assert.match(source,/getWhatsAppConversationMode/);
 assert.match(source,/routing\.mode==="human_only"/);
 assert.match(source,/routing\.mode==="ai_assistant"/);
 assert.match(source,/runWhatsAppChatbotTurn/);
 assert.match(source,/runGovernedMetaWhatsAppAiTurn/);
 assert.match(source,/governed_ai_draft_ready/);
 assert.match(source,/governed_ai_pending/);
 assert.doesNotMatch(source,/authorizeContext\(/);
});

test("Human ownership blocks automation even if another routing mode was configured",()=>{
 assert.match(source,/if\(input\.humanOwned\)return\{status:"received",routingMode:"human_only"/);
 const humanOwnershipGuard=source.indexOf("if(input.humanOwned)");
 const aiDispatch=source.indexOf("await runGovernedMetaWhatsAppAiTurn");
 const chatbotDispatch=source.indexOf("await runWhatsAppChatbotTurn");
 assert.ok(humanOwnershipGuard>=0&&aiDispatch>humanOwnershipGuard&&chatbotDispatch>humanOwnershipGuard,"human ownership must be evaluated before AI or chatbot dispatch");
});

test("AI handoff and automation failures switch to human-only routing",()=>{
 assert.match(source,/ai\.status==="human_handoff"/);
 assert.match(source,/mode:"human_only"/);
 assert.match(source,/requestAiHumanHandoff/);
 assert.match(source,/reason:"provider_error"/);
 assert.match(source,/automationReason:"ai_handoff"/);
 assert.match(source,/automationReason:"automation_dispatch_failed"/);
});

test("Production external delivery remains disabled in the Meta webhook slice",()=>{
 assert.match(source,/externalDelivery:false/);
 assert.doesNotMatch(source,/externalDelivery:true/);
 assert.doesNotMatch(source,/autoSend:true/);
});
