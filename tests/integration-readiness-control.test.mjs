import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const registry=read("lib/integration-readiness.ts"),api=read("app/api/integration-readiness/route.ts"),gateway=read("lib/api-gateway.ts"),launch=read("app/api/launch-readiness/route.ts"),page=read("app/control/integrations/page.tsx");

test("integration readiness owns one canonical registry and immutable audit trail",()=>{
 assert.match(registry,/integration_registry/);assert.match(registry,/integration_readiness_events/);assert.match(registry,/integration_code TEXT PRIMARY KEY/);assert.match(registry,/controlled_live_verified_by/);
});

test("readiness stages keep code sandbox production and controlled-live proof separate",()=>{
 for(const state of ["code_ready","sandbox_setup_required","sandbox_ready_for_test","sandbox_verified","production_setup_required","production_ready_for_controlled_test","controlled_live_verified"])assert.match(registry,new RegExp(`"${state}"`));
 assert.match(registry,/productionReady:false as const/);
});

test("credential discovery records presence only and never exposes secret values",()=>{
 // Detector names may be listed inline OR derived from the module that owns them. The telephony list
 // is now shared with lib/voice-call-gate.ts, which is what keeps the readiness surface and the dial
 // gate from disagreeing about whether a line is configured; asserting the literal in this file would
 // have forced a duplicate copy back into the registry. What matters is unchanged: every detector name
 // is discoverable, and no VALUE is.
 const detectorSources=registry+read("lib/voice-call-gate.ts");
 for(const name of ["RAZORPAY_KEY_ID_SANDBOX","RAZORPAY_KEY_SECRET_SANDBOX","RAZORPAY_WEBHOOK_SECRET_SANDBOX","WATI_API_TOKEN","SMS_API_KEY","EXOTEL_API_TOKEN","GOOGLE_MAPS_SERVER_API_KEY_UAT","AUTOMATION_CRON_SECRET"])assert.match(detectorSources,new RegExp(name));
 assert.match(registry,/secret_reference/);assert.match(registry,/Secret reference must be a reference only/);assert.match(registry,/env\|vault\|secret-manager\|platform/);
});

test("controlled-live verification requires production evidence approval and operational controls",()=>{
 assert.match(registry,/production environment/);assert.match(registry,/code boundary/);assert.match(registry,/evidence reference/);assert.match(registry,/approval reference/);
 for(const field of ["auth_verification_status","idempotency_status","replay_status","retry_status","dead_letter_status","timeout_status","rate_limit_status","reconciliation_status","monitoring_status","audit_logging_status","kill_switch_status"])assert.match(registry,new RegExp(field));
 assert.match(api,/Sandbox verification must include an evidence reference/);assert.match(api,/Controlled-live verification must include both evidence and approval references/);
});

test("integration readiness API is launch-governed and audited",()=>{
 assert.match(api,/requirePermission\(actor,"launch\.view"\)/);assert.match(api,/requirePermission\(actor,"launch\.manage"\)/);assert.match(registry,/integration\.readiness\.update/);
 assert.match(api,/sameOrigin\(request\)/);assert.match(api,/Cross-origin integration readiness write blocked/);assert.doesNotMatch(api,/error\.text\(\)/);
 assert.match(registry,/db\.batch\(\[/);assert.match(registry,/INSERT INTO security_audit_events/);
 assert.match(gateway,/\/api\/integration-readiness/);assert.match(gateway,/"launch\.view":"launch\.manage"/);
});

test("P0 integration blockers feed the canonical launch approval gate",()=>{
 assert.match(registry,/integrationLaunchBlockers/);assert.match(registry,/priority='P0'/);assert.match(registry,/readiness_state!='controlled_live_verified'/);
 assert.match(launch,/integrationLaunchBlockers/);assert.match(launch,/integrationBlockers\.length===0/);
});

test("registry covers required launch dependency classes",()=>{
 for(const code of ["INT-PAY-01","INT-COMMS-01","INT-VOICE-01","INT-MAPS-01","INT-GPS-01","INT-MEDIA-01","INT-BANK-01","INT-ACCT-01","INT-TAX-01","INT-AUTH-01","INT-OBS-01","INT-BACKUP-01","INT-SCHED-01"])assert.match(registry,new RegExp(code));
});

test("control integrations page uses the canonical register without exposing secrets",()=>{
 assert.match(page,/Integration Readiness Register/);assert.match(page,/\/api\/integration-readiness/);assert.match(page,/No secret values displayed/);assert.match(page,/Credential presence alone never satisfies this gate/);assert.doesNotMatch(page,/RAZORPAY_KEY_SECRET_SANDBOX|WATI_API_TOKEN|EXOTEL_API_TOKEN/);
});
