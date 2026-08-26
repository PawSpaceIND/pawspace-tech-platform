import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=await readFile(new URL("../lib/meta-whatsapp-uat-dispatch.ts",import.meta.url),"utf8");
const route=await readFile(new URL("../app/api/whatsapp/meta-admin/route.ts",import.meta.url),"utf8");

test("Meta dispatch is impossible unless explicit UAT delivery enablement and credentials exist",()=>{
 assert.match(source,/PAWSPACE_COMMUNICATION_ENV/);
 assert.match(source,/META_WHATSAPP_UAT_DELIVERY_ENABLED/);
 assert.match(source,/META_WHATSAPP_UAT_ACCESS_TOKEN/);
 assert.match(source,/META_WHATSAPP_PHONE_NUMBER_ID/);
 assert.match(source,/status:"not_configured"/);
});

test("Meta dispatch re-checks allowlist, canonical identity and opt-out immediately before send",()=>{
 assert.match(source,/META_WHATSAPP_UAT_ALLOWLIST/);
 assert.match(source,/recipient_not_allowlisted/);
 assert.match(source,/customerPhoneMatches/);
 assert.match(source,/recipient_customer_mismatch/);
 assert.match(source,/whatsapp_consent,opt_out/);
 assert.match(source,/consent_refused/);
});

test("outside the service window only an approved synced template can dispatch",()=>{
 assert.match(source,/24\*60\*60_000/);
 assert.match(source,/whatsapp_uat_templates/);
 assert.match(source,/approved_template_required_outside_session/);
 assert.match(source,/type:"template"/);
});

test("successful Meta acceptance binds the provider message id to the canonical message",()=>{
 assert.match(source,/provider_reference=\?/);
 assert.match(source,/messages\[0\]\?\.id/);
 assert.match(source,/eventId:`accepted:\$\{providerReference\}`/);
 assert.match(source,/provider:"meta_whatsapp"/);
});

test("dispatch races are fail-closed before network delivery",()=>{
 assert.match(source,/status='dispatching'/);
 assert.match(source,/locked\.meta\?\.changes/);
 assert.match(source,/dispatch_race_lost/);
});

test("Meta template sync is allowlisted and normalizes Meta approval status into the existing registry",()=>{
 assert.match(source,/META_WHATSAPP_TEMPLATE_ALLOWLIST/);
 assert.match(source,/allowlist_required/);
 assert.match(source,/normalizeMetaTemplateStatus/);
 assert.match(source,/ON CONFLICT\(template_key\) DO UPDATE/);
});

test("admin controls are RBAC-gated and production delivery stays disabled",()=>{
 assert.match(route,/settings\.manage/);
 assert.match(route,/communications\.manage/);
 assert.match(route,/securityAudit/);
 assert.match(route,/productionDelivery:false/);
});
