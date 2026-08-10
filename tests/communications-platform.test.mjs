import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("unified communications uses canonical threads outbox delivery events and dead letters",async()=>{
 const engine=await source("lib/communication-engine.ts");
 for(const table of["communication_policies","communication_threads","communication_participants","communication_messages","communication_outbox","communication_message_delivery_events","communication_dead_letters","communication_preferences"])assert.match(engine,new RegExp(table));
 assert.match(engine,/idempotency_key TEXT NOT NULL UNIQUE/);
 assert.match(engine,/UNIQUE\(provider,event_id\)/);
 assert.match(engine,/marketing_opt_out|marketing_consent_unknown/);
 assert.match(engine,/service_updates_opt_out/);
 assert.match(engine,/booking_link_required/);
 assert.match(engine,/quiet_hours/);
 assert.match(engine,/frequency_cap_7d/);
 assert.match(engine,/enforcement_mode/);
 assert.match(engine,/retryBaseMinutes/);
 assert.match(engine,/Math\.pow\(2,attempts-1\)/);
 assert.match(engine,/dead_letter/);
});

test("communication adapters are provider-independent and sandbox-first",async()=>{
 const adapters=await source("lib/communication-adapters.ts");
 for(const name of["limechat","meta_whatsapp","exotel_sms","sms_provider","email_provider","push_provider","exotel_voice","autodialer","sandbox_simulator"])assert.match(adapters,new RegExp(name));
 assert.match(adapters,/configuration_required/);
 assert.match(adapters,/sandbox_ready/);
 assert.match(adapters,/externalDelivery:false/);
 assert.match(adapters,/already_dispatched/);
 assert.match(adapters,/status='dispatching'/);
 assert.doesNotMatch(adapters,/fetch\(/);
});

test("communications API separates staff actions by permission and keeps policy configurable",async()=>{
 const[api,gateway]=await Promise.all([source("app/api/communications/route.ts"),source("lib/api-gateway.ts")]);
 assert.match(gateway,/url\.pathname==="\/api\/communications"/);
 assert.match(gateway,/adapter_readiness.*policy_update/);
 assert.match(gateway,/settings\.manage/);
 assert.match(gateway,/customers\.manage/);
 assert.match(gateway,/communications\.message/);
 assert.match(api,/action==="policy_update"/);
 for(const key of["enforcement_mode","quiet_start_hour","quiet_end_hour","promotional_cap_7d","max_attempts","retry_base_minutes","effective_from","effective_to"])assert.match(api,new RegExp(key));
 assert.match(api,/version=version\+1/);
 assert.match(api,/communication\.policy_update/);
 assert.match(api,/action==="adapter_readiness"/);
 assert.match(api,/action==="delivery_event"/);
 assert.match(api,/action==="fail_attempt"/);
});

test("legacy customer contact cannot bypass canonical communication governance",async()=>{
 const route=await source("app/api/customer-contact/route.ts");
 assert.match(route,/enqueueCommunication/);
 assert.match(route,/mode:"governed_outbox"/);
 assert.match(route,/provider:"not_dispatched"/);
 assert.doesNotMatch(route,/EXOTEL_API_KEY/);
 assert.doesNotMatch(route,/mode:live/);
});
