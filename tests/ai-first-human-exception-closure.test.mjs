import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";
installWorkersHooks();
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

const control=await import("../lib/ai-first-control-plane.ts");

test("authenticated callback phrases are deterministic and arbitrary chat is not",()=>{
 assert.equal(control.isCustomerCallbackRequest("Please call me about grooming"),true);
 assert.equal(control.isCustomerCallbackRequest("Can you give me a call?"),true);
 assert.equal(control.isCustomerCallbackRequest("What is the grooming price?"),false);
});

test("WhatsApp auto-send permits only grounded low-risk replies",()=>{
 const base={intent:"booking_status",outcome:"reply_ready",humanOwned:false,customerConsented:true,optedOut:false,grounded:true,containsHighImpactClaim:false,messageType:"eta_update"};
 assert.equal(control.evaluateWhatsAppAutoSend(base).allowed,true);
 for(const patch of[{humanOwned:true},{customerConsented:false},{optedOut:true},{grounded:false},{containsHighImpactClaim:true},{intent:"refund_review",messageType:null},{outcome:"handoff"}])assert.equal(control.evaluateWhatsAppAutoSend({...base,...patch}).allowed,false,JSON.stringify(patch));
});

test("high-impact tools remain outside autonomous allow-list",()=>{
 for(const code of["refund.issue","payment.capture","payout.release","price.override","provider.assign","campaign.activate","communication.send","customer.merge"])assert.equal(control.NEVER_AUTONOMOUS_TOOLS.has(code),true,code);
 for(const code of["service_catalogue.read","customer_bookings.read","booking_status.read","provider_status.read","subscription_wallet.read","case_status.read","approved_knowledge.read","quote.request"])assert.equal(control.LOW_RISK_AUTO_TOOLS.has(code),true,code);
 assert.equal(control.CONFIRMABLE_SAFE_MUTATIONS.has("booking.request"),true);
});

test("controlled-live readiness never mistakes configured credentials for verified traffic",()=>{
 const all={HAPTIK_API_KEY:"x",HAPTIK_OUTBOUND_API_KEY:"x",HAPTIK_OUTBOUND_URL:"https://h.example",INTERAKT_WEBHOOK_SECRET:"x",INTERAKT_API_KEY:"x",EXOTEL_API_KEY:"x",EXOTEL_API_TOKEN:"x",EXOTEL_SID:"x",EXOTEL_CALLER_ID:"x",EXOTEL_VOICE_APP_ID:"x",EXOTEL_WEBHOOK_SECRET:"x",PAWSPACE_VOICE_STATUS_CALLBACK_URL:"https://app.example/api/voice-provider-webhook"};
 const ready=control.controlledLiveProviderReadiness(all);
 assert.equal(ready.providers.haptik.configured,true);assert.equal(ready.providers.interakt.configured,true);assert.equal(ready.providers.exotel.configured,true);
 assert.equal(ready.controlledLiveVerified,false);assert.match(ready.claim,/executed provider evidence/);
});

test("chat callback wiring uses canonical phone, persisted consent, Customer360 and voice policy engine",()=>{
 const source=read("lib/ai-first-control-plane.ts"),route=read("app/api/ai-web-chat/route.ts");
 assert.match(source,/SELECT id,primary_phone FROM canonical_customers/);assert.match(source,/recordVoiceConsent/);assert.match(source,/buildCustomer360/);assert.match(source,/requestOutboundVoiceCall/);assert.match(source,/idempotencyKey:`ai-callback:/);
 assert.match(route,/mode==="public"/);assert.match(route,/callbackAutomation:false/);assert.match(route,/isCustomerCallbackRequest/);
});

test("inbound carrier boundary verifies provider signature before STT-AI-TTS pipeline",()=>{
 const route=read("app/api/voice-provider-webhook/route.ts"),inbound=read("lib/inbound-ai-telephony.ts");
 assert.match(route,/provider\.verifyWebhook/);assert.match(route,/inbound_ai_start/);assert.match(route,/inbound_ai_turn/);assert.match(route,/inbound_ai_end/);
 assert.match(inbound,/resolveWorkersAiStt/);assert.match(inbound,/orchestrateAiTurn/);assert.match(inbound,/resolveWorkersAiTts/);assert.match(inbound,/buildCustomer360/);assert.match(inbound,/requestAiHumanHandoff/);
});

test("AI tools expose low-risk auto_execute but preserve existing prepare-confirm path",()=>{
 const route=read("app/api/ai-tools/route.ts");assert.match(route,/action\?:"prepare"\|"confirm"\|"auto_execute"/);assert.match(route,/executeGovernedLowRiskTool/);assert.match(route,/confirmAiToolExecution/);
});

test("Meta AI queues low-risk replies through communication governance and never auto-sends a handoff",()=>{
 const source=read("lib/meta-whatsapp-ai-executor.ts");assert.match(source,/evaluateWhatsAppAutoSend/);assert.match(source,/enqueueCommunication/);assert.match(source,/ai_auto_send_queued/);assert.match(source,/outcome==="handoff"/);assert.match(source,/autoSend:false/);
});

test("human exception classes route into existing paused AI handoff centre",()=>{
 const source=read("lib/ai-first-control-plane.ts"),handoff=read("lib/ai-human-handoff.ts");
 for(const kind of["pet_safety","emergency","payment_dispute","complex_complaint","customer_requested_human","provider_failure"])assert.match(source,new RegExp(kind));
 assert.match(source,/requestAiHumanHandoff/);assert.match(handoff,/assertAiMayReply/);assert.match(handoff,/AI replies are paused while the conversation is owned by staff/);assert.match(handoff,/Resume reason is required/);
});
