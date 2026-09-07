import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./helpers/voice-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__NOTIFICATIONS_CLOSURE_DB__", "__NOTIFICATIONS_CLOSURE_ENV__");
const guards = await import("../lib/communication-runtime-guards.ts");
const { renderInteraktTemplateValues } = await import("../lib/interakt-template-renderer.ts");
const { signCanonicalInteraktWebhook, verifyCanonicalInteraktWebhook } = await import("../lib/interakt-webhook-auth.ts");
const engine = await import("../lib/communication-engine.ts");

async function communicationWorld(){
 const sqlite=new DatabaseSync(":memory:");
 const db=makeD1(sqlite);
 globalThis.__NOTIFICATIONS_CLOSURE_DB__=db;
 await engine.ensureCommunicationTables(db);
 await engine.seedCommunicationPolicy(db);
 sqlite.prepare("UPDATE communication_policies SET quiet_start_hour=0,quiet_end_hour=0 WHERE id='comm_blr_default'").run();
 await engine.setCommunicationPreference(db,{customerId:"C-NOTIFY",serviceUpdates:true,marketing:true,preferredChannel:"whatsapp",source:"closure-test"});
 return{sqlite,db};
}

test("payment sandbox forces communication sandbox and selects UAT Meta credentials",()=>{
 const env={PAWSPACE_DEPLOYMENT_ENV:"production",PAWSPACE_COMMUNICATION_ENV:"live",PAWSPACE_PAYMENT_ENV:"sandbox",META_WHATSAPP_ACCESS_TOKEN:"LIVE-TOKEN",META_WHATSAPP_PHONE_NUMBER_ID:"LIVE-PHONE",META_WHATSAPP_WABA_ID:"LIVE-WABA",META_WHATSAPP_UAT_ACCESS_TOKEN:"UAT-TOKEN",META_WHATSAPP_PHONE_NUMBER_ID_UAT:"UAT-PHONE",META_WHATSAPP_WABA_ID_UAT:"UAT-WABA"};
 assert.equal(guards.communicationRuntimeMode(env),"sandbox");
 assert.equal(guards.liveCommunicationEnabled(env),false);
 assert.deepEqual(guards.metaWhatsAppCredentials(env),{mode:"sandbox",token:"UAT-TOKEN",phoneNumberId:"UAT-PHONE",wabaId:"UAT-WABA"});
});

test("communication sandbox cannot be promoted by live payment or live credentials",()=>{
 const env={PAWSPACE_DEPLOYMENT_ENV:"production",PAWSPACE_COMMUNICATION_ENV:"sandbox",PAWSPACE_PAYMENT_ENV:"live",META_WHATSAPP_ACCESS_TOKEN:"LIVE-TOKEN",META_WHATSAPP_PHONE_NUMBER_ID:"LIVE-PHONE",META_WHATSAPP_WABA_ID:"LIVE-WABA"};
 assert.equal(guards.communicationRuntimeMode(env),"sandbox");
 assert.equal(guards.liveCommunicationEnabled(env),false);
 const selected=guards.metaWhatsAppCredentials(env);
 assert.equal(selected.token,"");
 assert.equal(selected.phoneNumberId,"");
 assert.equal(selected.wabaId,"");
});

test("governed renderer maps lifecycle payload fields to deterministic Interakt slots",()=>{
 const values=renderInteraktTemplateValues({
  template:{variables_json:JSON.stringify(["booking_id","service_code","event_id","timestamp"])},
  payload:{bookingId:"BKG-42",serviceCode:"dog_training",eventId:"EVT-7",occurredAt:1770000000000},
  message:{booking_id:"BKG-FALLBACK",customer_id:"C-NOTIFY"},
 });
 assert.deepEqual(values,["BKG-42","dog_training","EVT-7","1770000000000"]);
 assert.throws(()=>renderInteraktTemplateValues({template:{variables_json:JSON.stringify(["booking_id","service_code"])},payload:{bookingId:"BKG-42"},message:{}}),/Missing required Interakt template variable \{\{2\}\}/);
});

test("explicit bodyValues must exactly match governed slot count",()=>{
 assert.deepEqual(renderInteraktTemplateValues({template:{variables_json:JSON.stringify(["pet_name","booking_id"])},payload:{bodyValues:["Shifa","BKG-1"]},message:{}}),["Shifa","BKG-1"]);
 assert.throws(()=>renderInteraktTemplateValues({template:{variables_json:JSON.stringify(["pet_name","booking_id"])},payload:{bodyValues:["Shifa"]},message:{}}),/requires 2 values/);
});

test("canonical Interakt verifier accepts only documented Interakt-Signature HMAC",async()=>{
 const raw=JSON.stringify({type:"message_api_delivered",data:{message:{id:"INTERAKT-1"}}});
 const env={INTERAKT_WEBHOOK_SECRET:"closure-secret"};
 const signature=await signCanonicalInteraktWebhook(env.INTERAKT_WEBHOOK_SECRET,raw);
 assert.deepEqual(await verifyCanonicalInteraktWebhook(raw,new Headers({"Interakt-Signature":signature}),env),{ok:true});
 const legacy=await verifyCanonicalInteraktWebhook(raw,new Headers({"x-interakt-signature":signature}),env);
 assert.equal(legacy.ok,false);
 assert.equal(legacy.status,401);
});

test("new enqueue creates message and outbox together, and idempotent retry repairs legacy stranded rows",async()=>{
 const {sqlite,db}=await communicationWorld();
 const input={customerId:"C-NOTIFY",cityId:"blr",channel:"whatsapp",purpose:"transactional",bookingId:"BKG-NOTIFY",idempotencyKey:"notify-atomic-1",templateKey:"booking_confirmed",payload:{bookingId:"BKG-NOTIFY"},createdBy:"closure-test",asOf:Date.now()};
 const first=await engine.enqueueCommunication(db,input);
 assert.equal(first.duplicatePrevented,false);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE id=?").get(first.messageId).n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox WHERE message_id=?").get(first.messageId).n,1);
 sqlite.prepare("DELETE FROM communication_outbox WHERE message_id=?").run(first.messageId);
 const replay=await engine.enqueueCommunication(db,input);
 assert.equal(replay.duplicatePrevented,true);
 assert.equal(replay.outboxRepaired,true);
 const repaired=sqlite.prepare("SELECT status,last_error FROM communication_outbox WHERE message_id=?").get(first.messageId);
 assert.equal(repaired.status,"queued");
 assert.equal(repaired.last_error,"reconstructed_after_idempotent_retry");
});

test("HTTP callback route sends both Interakt provider aliases to the canonical atomic delivery handler",()=>{
 const route=fs.readFileSync("app/api/communication-provider-callback/route.ts","utf8");
 assert.match(route,/provider==="interakt"\|\|provider===INTERAKT_WHATSAPP_PROVIDER/);
 assert.match(route,/isInteraktDeliveryWebhook\(rawBody\)\?await recordInteraktDeliveryWebhookAtomic/);
 const atomic=fs.readFileSync("lib/interakt-delivery-atomic.ts","utf8");
 assert.match(atomic,/verifyCanonicalInteraktWebhook/);
 assert.doesNotMatch(atomic,/x-interakt-signature/);
});

test("WhatsApp dispatcher has no sandbox path to live Meta token or production phone id",()=>{
 const runtime=fs.readFileSync("lib/whatsapp-production-runtime.ts","utf8");
 assert.match(runtime,/liveCommunicationEnabled\(env\)/);
 assert.match(runtime,/dispatchMetaWhatsAppUat/);
 assert.match(runtime,/metaWhatsAppCredentials\(env\)/);
 assert.doesNotMatch(runtime,/META_WHATSAPP_ACCESS_TOKEN\|\|META_WHATSAPP_UAT_ACCESS_TOKEN/);
 const uat=fs.readFileSync("lib/meta-whatsapp-uat-dispatch.ts","utf8");
 assert.match(uat,/META_WHATSAPP_UAT_DELIVERY_ENABLED/);
 assert.match(uat,/META_WHATSAPP_UAT_ALLOWLIST\|\|env\.PAWSPACE_COMMUNICATION_UAT_ALLOWLIST/);
});

test("undispatchable generic rows consume retry budget instead of hot-looping",()=>{
 const dispatcher=fs.readFileSync("lib/communication-outbox-dispatcher.ts","utf8");
 assert.match(dispatcher,/sandbox_\$\{channel\}_adapter_not_configured/);
 assert.match(dispatcher,/failOutboxAttempt\(db,messageId,"canonical_recipient_missing"\)/);
 assert.match(dispatcher,/deadLetterOutbox\(db,messageId,"unsupported_outbox_channel"/);
});

test("order notification telemetry preserves scheduled and suppressed communication states",()=>{
 const source=fs.readFileSync("lib/order-notification-governance.ts","utf8");
 assert.match(source,/deliveryStatus=text\(\(communication as Row\)\.status\)\|\|text\(message\?\.status\)\|\|"queued"/);
 assert.match(source,/communication_suppressed/);
 assert.match(source,/communication_scheduled/);
});
