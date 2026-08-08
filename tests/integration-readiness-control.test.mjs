import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const registry=read("lib/integration-readiness.ts"),api=read("app/api/integration-readiness/route.ts"),gateway=read("lib/api-gateway.ts"),launch=read("app/api/launch-readiness/route.ts");

test("integration readiness owns one canonical registry and immutable audit trail",()=>{
 assert.match(registry,/integration_registry/);assert.match(registry,/integration_readiness_events/);assert.match(registry,/integration_code TEXT PRIMARY KEY/);assert.match(registry,/controlled_live_verified_by/);
});

test("readiness stages keep code sandbox production and controlled-live proof separate",()=>{
 for(const state of ["code_ready","sandbox_setup_required","sandbox_ready_for_test","sandbox_verified","production_setup_required","production_ready_for_controlled_test","controlled_live_verified"])assert.match(registry,new RegExp(`"${state}"`));
 assert.match(registry,/productionReady:false as const/);
});

test("credential discovery records presence only and never exposes secret values",()=>{
 for(const name of ["RAZORPAY_KEY_ID_SANDBOX","RAZORPAY_KEY_SECRET_SANDBOX","RAZORPAY_WEBHOOK_SECRET_SANDBOX","WATI_API_TOKEN","SMS_API_KEY","EXOTEL_API_TOKEN","GOOGLE_MAPS_SERVER_API_KEY_UAT","AUTOMATION_CRON_SECRET"])assert.match(registry,new RegExp(name));
 assert.match(registry,/secret_reference/);assert.match(registry,/Secret reference must be a reference only/);assert.match(registry,/env\|vault\|secret-manager\|platform/);
});

test("controlled-live verification requires production evidence approval and operational controls",()=>{
 assert.match(registry,/production environment/);assert.match(registry,/code boundary/);assert.match(registry,/evidence reference/);assert.match(registry,/approval reference/);
 for(const field of ["auth_verification_status","idempotency_status","replay_status","retry_status","dead_letter_status","timeout_status","rate_limit_status","reconciliation_status","monitoring_status","audit_logging_status","kill_switch_status"])assert.match(registry,new RegExp(field));
 assert.match(api,/Controlled-live verification must include both evidence and approval references/);
});

test("integration readiness API is launch-governed and audited",()=>{
 assert.match(api,/requirePermission\(actor,"launch\.view"\)/);assert.match(api,/requirePermission\(actor,"launch\.manage"\)/);assert.match(api,/integration\.readiness\.update/);
 assert.match(gateway,/\/api\/integration-readiness/);assert.match(gateway,/"launch\.view":"launch\.manage"/);
});

test("P0 integration blockers feed the canonical launch approval gate",()=>{
 assert.match(registry,/integrationLaunchBlockers/);assert.match(registry,/priority='P0'/);assert.match(registry,/readiness_state!='controlled_live_verified'/);
 assert.match(launch,/integrationLaunchBlockers/);assert.match(launch,/integrationBlockers\.length===0/);
});

test("registry covers required launch dependency classes",()=>{
 for(const code of ["INT-PAY-01","INT-COMMS-01","INT-VOICE-01","INT-MAPS-01","INT-GPS-01","INT-MEDIA-01","INT-BANK-01","INT-ACCT-01","INT-TAX-01","INT-AUTH-01","INT-OBS-01","INT-BACKUP-01","INT-SCHED-01"])assert.match(registry,new RegExp(code));
});
