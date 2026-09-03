import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const isolated=read(".github/workflows/deploy-whatsapp-uat-staging.yml");
const full=read(".github/workflows/deploy-staging.yml");
const exotel=["EXOTEL_API_KEY","EXOTEL_API_TOKEN","EXOTEL_SID","EXOTEL_CALLER_ID","EXOTEL_VOICE_APP_ID","EXOTEL_WEBHOOK_SECRET"];

test("WhatsApp-only staging deploy has no Exotel dependency",()=>{
 for(const name of exotel)assert.doesNotMatch(isolated,new RegExp(name),`${name} must not block WhatsApp-only UAT`);
 assert.match(isolated,/META_WHATSAPP_UAT_ACCESS_TOKEN:\s*\$\{\{\s*secrets\.META_WHATSAPP_UAT_ACCESS_TOKEN\s*\}\}/);
});

test("isolated workflow pins one exact application SHA to pawspace-staging",()=>{
 assert.match(isolated,/TARGET_SHA:/);assert.match(isolated,/git rev-parse HEAD/);
 assert.match(isolated,/npx wrangler deploy --keep-vars --message "staging \$TARGET_SHA"/);
 assert.match(isolated,/STAGING_URL: https:\/\/pawspace-staging\.karthik-fce\.workers\.dev/);
 assert.match(isolated,/node tests\/e2e\/staging-certification\.mjs --isolation-only/);
 assert.match(isolated,/PRODUCTION_D1_ID/);assert.match(isolated,/PRODUCTION_WORKER_NAME/);
 assert.doesNotMatch(isolated,/deploy-production|pawspace-prod-bengaluru|PAWSPACE_PAYMENT_LIVE_APPROVED\s*:\s*['"]?true/i);
});

test("staging restores only when Meta readiness is incomplete",()=>{
 assert.match(isolated,/configuredForExternalTest===true/);
 assert.match(isolated,/wrangler rollback --name pawspace-staging/);
 assert.match(isolated,/rollback not required/);
});

test("all existing plain staging bindings are snapshotted without logging values",()=>{
 assert.match(isolated,/workers\/scripts\/pawspace-staging\/settings/);
 assert.match(isolated,/binding\?\.type!=="plain_text"/);
 assert.match(isolated,/config\.vars=\{\.\.\.remoteVars,\.\.\.\(config\.vars\|\|\{\}\)\}/);
 assert.match(isolated,/config\.keep_vars=true/);
 assert.match(isolated,/names and values withheld/);
 assert.doesNotMatch(isolated,/console\.log\([^\n]*(?:binding\?\.text|binding\?\.value|remoteVars\[)/);
});

test("raw Cloudflare and Wrangler deployment output is contained",()=>{
 assert.match(isolated,/> "\$DEPLOY_LOG" 2>&1/);assert.doesNotMatch(isolated,/wrangler deploy[^\n]*\|\s*tee/);
 assert.match(isolated,/raw output withheld/);
});

test("WhatsApp-only staging remains UAT sandbox and proves public webhook boundary",()=>{
 assert.match(isolated,/node scripts\/stage-config\.mjs/);assert.match(isolated,/PAWSPACE_STAGING_LIVE_CUSTOMER_OTP="false"/);
 assert.match(isolated,/healthz=200/);assert.match(isolated,/webhook bypasses staging-login/);assert.match(isolated,/invalid signature rejected/);
 assert.match(isolated,/action:"sync_templates"/);assert.match(isolated,/approvedAllowlistedTemplateCount/);
});

test("full staging voice mode remains fail-closed on every Exotel credential",()=>{
 const requiredBlock=full.match(/const requiredNames = \[([\s\S]*?)\];/)?.[1]||"";
 for(const name of exotel){assert.match(full,new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`),`${name} must still be sourced from GitHub Secrets`);assert.match(requiredBlock,new RegExp(`["']${name}["']`),`${name} must remain required by full staging`);}
 assert.match(full,/if \(Object\.values\(required\)\.some\(value => !value\)\) throw new Error\("a required staging secret is missing"\)/);
});
