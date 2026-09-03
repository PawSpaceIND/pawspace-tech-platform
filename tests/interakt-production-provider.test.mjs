import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

/*
 * Mostly a source-contract suite, but one test below really imports lib/interakt-whatsapp.ts to
 * exercise signInteraktWebhook. That module imports its siblings extensionlessly, so without the
 * harness resolver the import fails with "Cannot find module .../lib/canonical-recipient-ownership".
 * The import there is already dynamic (inside the test), so registering the hooks here is enough.
 */
installWorkersHooks("__INTERAKT_PROVIDER_DB__", "__INTERAKT_PROVIDER_ENV__");

const read=(path)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("Interakt adapter is production-gated, canonical-owned, consent-gated and template-approved",()=>{
 const source=read("lib/interakt-whatsapp.ts");
 assert.match(source,/PAWSPACE_DEPLOYMENT_ENV/);
 assert.match(source,/PAWSPACE_COMMUNICATION_ENV/);
 assert.match(source,/INTERAKT_API_KEY/);
 assert.match(source,/resolveCanonicalRecipientOwnership/);
 assert.match(source,/SELECT whatsapp_consent,opt_out FROM customer_contact_preferences/);
 assert.match(source,/Number\(row!\.whatsapp_consent\)===1/);
 assert.match(source,/Number\(row!\.opt_out\|\|0\)===0/);
 assert.match(source,/text\(row\.status\)!=="approved"/);
 assert.match(source,/failOutboxAttempt/);
 assert.match(source,/recordAtomicDeliveryEvent/);
 assert.match(source,/https:\/\/api\.interakt\.ai\/v1\/public\/message\//);
 assert.match(source,/authorization:`Basic \$\{apiKey\}`/);
});

test("Interakt webhook signature matches the vendor sha256=HMAC-SHA256 contract",async()=>{
 const adapter=await import("../lib/interakt-whatsapp.ts");
 const secret="test-only-interakt-webhook-secret",raw='{"foo":1,"bar":2}';
 const expected=`sha256=${createHmac("sha256",secret).update(raw).digest("hex")}`;
 assert.equal(await adapter.signInteraktWebhook(secret,raw),expected);
 const verifier=read("lib/interakt-whatsapp-base.ts");
 assert.match(verifier,/interakt-signature/);
 assert.match(verifier,/invalid_interakt_signature/);
});

test("production workflow binds Interakt secrets through the 0600 secrets file and keeps live voice unavailable",()=>{
 const workflow=read(".github/workflows/deploy-production.yml");
 for(const name of ["INTERAKT_API_KEY","INTERAKT_WEBHOOK_SECRET"])assert.match(workflow,new RegExp(name));
 assert.match(workflow,/writeFileSync\(process\.env\.SECRETS_FILE, JSON\.stringify\(values\), \{ mode: 0o600 \}\)/);
 assert.match(workflow,/options: \[disabled, uat\]/);
 assert.doesNotMatch(workflow,/options: \[disabled, uat, live\]/);
});

test("production config declares voice disabled by default and refuses live activation",()=>{
 const config=read("scripts/prod-config.mjs");
 assert.match(config,/PAWSPACE_VOICE_ENV \|\| "disabled"/);
 assert.match(config,/PAWSPACE_VOICE_UAT_APPROVED \|\| "false"/);
 assert.match(config,/\["disabled", "uat"\]/);
 assert.match(config,/PAWSPACE_VOICE_ENV: voiceEnv/);
 assert.match(config,/PAWSPACE_VOICE_UAT_APPROVED: voiceUatApproved/);
});