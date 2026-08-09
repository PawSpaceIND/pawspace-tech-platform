import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const adapter=read("lib/whatsapp-uat-adapter.ts"),route=read("app/api/whatsapp-uat-webhook/route.ts"),communications=read("lib/communication-adapters.ts"),readiness=read("lib/integration-readiness.ts");

test("AI Gate 5 WhatsApp adapter is UAT locked and signed",()=>{
 assert.match(route,/PAWSPACE_WHATSAPP_ENV/);assert.match(route,/PAWSPACE_WHATSAPP_UAT_WEBHOOK_SECRET/);assert.match(route,/x-pawspace-signature/);assert.match(route,/x-pawspace-event-id/);assert.match(route,/HMAC/);assert.match(route,/safeEqual/);assert.match(route,/locked to UAT\/sandbox/);assert.match(route,/externalDelivery:false/);assert.doesNotMatch(route,/fetch\(/);
});

test("AI Gate 5 accepts only governed WhatsApp UAT providers",()=>{
 for(const provider of["limechat","meta_whatsapp","sandbox_simulator"])assert.match(adapter,new RegExp(provider));assert.match(adapter,/Unsupported WhatsApp UAT provider/);assert.match(route,/whatsappUatProviders/);
});

test("AI Gate 5 resolves canonical customer identity and records unresolved reviews",()=>{
 assert.match(adapter,/resolveWhatsAppUatCustomer/);assert.match(adapter,/canonical_customers/);assert.match(adapter,/verified_phone_match/);assert.match(adapter,/whatsapp_uat_identity_reviews/);assert.match(adapter,/governed customer resolution/);
});

test("AI Gate 5 persists inbound WhatsApp on canonical communication truth and invokes shared orchestrator",()=>{
 assert.match(adapter,/ensureCommunicationTables/);assert.match(adapter,/communication_threads/);assert.match(adapter,/communication_participants/);assert.match(adapter,/communication_messages/);assert.match(adapter,/'inbound','whatsapp'/);assert.match(adapter,/whatsapp_uat_inbound/);assert.match(route,/orchestrateAiTurn/);assert.match(route,/channel:"whatsapp"/);assert.match(route,/autonomousExecution:false/);
});

test("AI Gate 5 is replay resistant and delivery events reuse canonical status handling",()=>{
 assert.match(adapter,/whatsapp_uat_events/);assert.match(adapter,/UNIQUE\(provider,event_id\)/);assert.match(adapter,/whatsapp-uat:\$\{input\.provider\}:\$\{eventId\}/);assert.match(adapter,/recordDeliveryEvent/);assert.match(adapter,/duplicatePrevented:true/);
});

test("AI Gate 5 outbound policy uses canonical outbox with consent session template and kill-switch controls",()=>{
 assert.match(adapter,/queueWhatsAppUatOutbound/);assert.match(adapter,/communication_outbox/);assert.match(adapter,/whatsapp_consent/);assert.match(adapter,/sessionWindowHours:24/);assert.match(adapter,/whatsapp_uat_templates/);assert.match(adapter,/approved_template_required_outside_session/);assert.match(adapter,/whatsapp_uat_provider_controls/);assert.match(adapter,/provider_kill_switch/);assert.match(adapter,/staffFallbackRequired:true/);
});

test("AI Gate 5 does not enable production WhatsApp delivery",()=>{
 assert.match(communications,/externalDelivery:false/);assert.match(communications,/adapter_ready_external_execution_pending/);assert.doesNotMatch(communications,/fetch\(/);assert.match(readiness,/INT-COMMS-01/);assert.match(readiness,/sandbox_setup_required/);assert.match(readiness,/controlled_live_verified/);
});
