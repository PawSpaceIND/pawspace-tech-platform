import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,delimiter} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {d1} from "./helpers/execution-harness.mjs";
installWorkersHooks("__SCHEDULER_CHOICE_DB__");
const {providerChoiceProblem,preferredModeForChoice,providerChoiceMatchesStored}=await import("../lib/scheduling-provider-choice.ts");
const {resolveAssignmentPolicy,upgradeUntouchedTrainingSeed}=await import("../lib/provider-assignment-policy.ts");
const {writeServicePolicy}=await import("../lib/service-policy-governance.ts");
const {trainingReservationForChoice}=await import("../lib/training-availability-client.ts");
const domain="provider_assignment_policy",id="spolicy_provider_assignment_policy_dog_training_any";
async function world(t){const sql=new DatabaseSync(":memory:"),db=d1(sql);t.after(()=>sql.close());await resolveAssignmentPolicy(db,"dog_training","blr");return{sql,db};}
function oldSeed(sql){const row=sql.prepare("SELECT config_json FROM service_policy_configs WHERE id=?").get(id);const cfg={...JSON.parse(row.config_json),assignmentMode:"customer_select",preferredProviderMode:"strict"};sql.prepare("UPDATE service_policy_configs SET config_json=?,notes=?,version=1,updated_by='founder_seed' WHERE id=?").run(JSON.stringify(cfg),"Training customer selection is strict; never silently substitute",id);}

test("customer selection can narrow preference but cannot invent a mode",()=>{
 assert.equal(providerChoiceProblem({providerSelection:"auto"}),null);
 assert.equal(providerChoiceProblem({providerSelection:"specific",preferredProviderId:"P1"}),null);
 for(const input of [{providerSelection:"other"},{providerSelection:"specific"},{providerSelection:"specific",preferredProviderId:" "},{providerSelection:"auto",preferredProviderId:"P1"}])assert.ok(providerChoiceProblem(input));
 assert.equal(preferredModeForChoice({providerSelection:"specific"},"preference"),"strict");
 assert.equal(preferredModeForChoice({providerSelection:"auto"},"strict"),"strict");
 assert.equal(preferredModeForChoice({},"preference"),"preference");
});
test("replays cannot change automatic/specific intent or a selected person",()=>{
 assert.equal(providerChoiceMatchesStored({providerSelection:"auto"},{providerSelection:"auto"}),true);
 assert.equal(providerChoiceMatchesStored({providerSelection:"specific",preferredProviderId:"P1"},{providerSelection:"specific",preferredProviderId:"P2"}),false);
 assert.equal(providerChoiceMatchesStored({providerSelection:"auto"},{providerSelection:"specific",preferredProviderId:"P1"}),false);
 assert.equal(providerChoiceMatchesStored({providerSelection:"specific",preferredProviderId:"P1"},{preferredProviderId:"P1"}),true);
});
test("fresh defaults restore auto Training but preserve explicit choice and host selection",async t=>{
 const {db}=await world(t);
 for(const service of ["grooming","dog_training","pet_taxi","dog_walking","vet_consult"])assert.equal((await resolveAssignmentPolicy(db,service,"blr")).config.assignmentMode,"auto",service);
 assert.equal((await resolveAssignmentPolicy(db,"dog_training","blr")).config.preferredProviderMode,"strict");
 for(const service of ["boarding","pet_sitting"])assert.equal((await resolveAssignmentPolicy(db,service,"blr")).config.assignmentMode,"customer_select",service);
 for(const service of ["food","relocation","funeral_memorial"])assert.equal((await resolveAssignmentPolicy(db,service,"blr")).config.assignmentMode,"manual_workflow",service);
});
test("only the untouched old Training seed is upgraded, once, with its audit trail",async t=>{
 const {sql,db}=await world(t);oldSeed(sql);
 await upgradeUntouchedTrainingSeed(db);await upgradeUntouchedTrainingSeed(db);
 const row=sql.prepare("SELECT * FROM service_policy_configs WHERE id=?").get(id);
 assert.equal(JSON.parse(row.config_json).assignmentMode,"auto");assert.equal(row.version,2);
 const audits=sql.prepare("SELECT * FROM service_policy_audit WHERE action='seed_upgrade'").all();assert.equal(audits.length,1);
 assert.equal(JSON.parse(audits[0].before_json).config.assignmentMode,"customer_select");
 assert.equal(JSON.parse(audits[0].after_json).config.preferredProviderMode,"strict");
});
for(const patch of ["updated_by='founder@pawspace.in'","version=2","active=0","effective_from='2027-01-01'","effective_to='2026-12-01'","notes='Operator-authored restriction'"])test(`upgrade preserves edited row: ${patch}`,async t=>{
 const {sql,db}=await world(t);oldSeed(sql);sql.exec(`UPDATE service_policy_configs SET ${patch} WHERE id='${id}'`);
 const before=sql.prepare("SELECT * FROM service_policy_configs WHERE id=?").get(id);await upgradeUntouchedTrainingSeed(db);
 assert.deepEqual(sql.prepare("SELECT * FROM service_policy_configs WHERE id=?").get(id),before);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM service_policy_audit WHERE action='seed_upgrade'").get().n,0);
});
test("upgrade preserves a customized seed weight even when its ownership marker is unchanged",async t=>{
 const {sql,db}=await world(t);oldSeed(sql);sql.exec(`UPDATE service_policy_configs SET config_json=json_set(config_json,'$.qualityWeight',7) WHERE id='${id}'`);
 await upgradeUntouchedTrainingSeed(db);const p=await resolveAssignmentPolicy(db,"dog_training","blr");assert.equal(p.config.assignmentMode,"customer_select");assert.equal(p.config.qualityWeight,7);
});
test("city-specific Operations policy retains authority over upgraded defaults",async t=>{
 const {sql,db}=await world(t);oldSeed(sql);
 await writeServicePolicy(db,{domain,serviceCode:"dog_training",cityId:"blr",config:{assignmentMode:"ops_select"}},"founder@pawspace.in","Bengaluru requires Operations selection");
 await upgradeUntouchedTrainingSeed(db);assert.equal((await resolveAssignmentPolicy(db,"dog_training","blr")).config.assignmentMode,"ops_select");
});
test("upgrade and its audit are atomic when the policy write fails",async t=>{
 const {sql,db}=await world(t);oldSeed(sql);
 sql.exec("CREATE TRIGGER refuse_upgrade BEFORE UPDATE ON service_policy_configs BEGIN SELECT RAISE(ABORT,'injected policy write failure'); END");
 await assert.rejects(upgradeUntouchedTrainingSeed(db),/injected policy write failure/);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM service_policy_audit WHERE action='seed_upgrade'").get().n,0);
 assert.equal(JSON.parse(sql.prepare("SELECT config_json FROM service_policy_configs WHERE id=?").get(id).config_json).assignmentMode,"customer_select");
});
test("Training automatic retry identity ignores rankings but changes for explicit trainer choice",()=>{
 const selection={customerId:"C1",petIds:["P1"],cityId:"blr",zoneId:"blr-east",scheduledStart:new Date(Date.now()+5*86400000).toISOString(),cadenceDays:7,quote:{quoteId:"Q1",petCount:1,minutesPerSession:60,sessions:2,validityDays:30,expiresAt:Date.now()+60000}};
 const a=trainingReservationForChoice(selection,{mode:"auto",providerId:"preview-1"}),b=trainingReservationForChoice(selection,{mode:"auto",providerId:"preview-2"});
 assert.equal(a.clientRequestId,b.clientRequestId);assert.equal(a.preferredProviderId,undefined);assert.equal(a.occurrences,2);
 const specific=trainingReservationForChoice(selection,{mode:"specific",providerId:"trainer-1"});
 assert.notEqual(a.clientRequestId,specific.clientRequestId);assert.equal(specific.preferredProviderId,"trainer-1");
 assert.throws(()=>trainingReservationForChoice(selection,{mode:"specific"}),/Choose your trainer/);
});

// CI dependency assertions belong with the scheduler runtime and database regressions.
const workflow = readFileSync(new URL("../.github/workflows/v2-scheduler-choice.yml", import.meta.url), "utf8");
const trigger = workflow.slice(workflow.indexOf("  pull_request:"), workflow.indexOf("  workflow_dispatch:"));
const paths = [...trigger.matchAll(/^\s+- '([^']+)'$/gm)].map(match => match[1]);
const covered = file => paths.some(pattern => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${regex}$`).test(file);
});

test("scheduler CI triggers when its shared browser configuration or server harness changes", () => {
  for (const path of ["playwright.config.ts", "playwright.scheduler-choice.config.ts", "scripts/e2e/serve.sh", "scripts/e2e/seed-identities.mjs", "package.json", "package-lock.json"])
    assert.ok(covered(path), `Missing scheduler CI trigger: ${path}`);
});
test("scheduler CI triggers for every executed regression and its shared fixtures", () => {
  const executed = [...workflow.matchAll(/\b(tests\/[\w/-]+\.test\.mjs)\b/g)].map(match => match[1]);
  assert.ok(executed.length >= 7, "keep the existing regression suite");
  for (const path of [...executed, "tests/helpers/module-hooks.mjs", "tests/helpers/execution-harness.mjs", "tests/fixtures/v2-ui-wiring-contract.json", "tests/scheduler-provider-choice.test.mjs"])
    assert.ok(covered(path), `Missing scheduler CI trigger: ${path}`);
});

test("scheduler CI watches transitive engine, capacity, identity and application-shell changes", () => {
  for (const path of ["backend/src/scheduling.ts", "lib/provider-capacity-governance.ts", "lib/platform-session.ts", "worker/index.ts", "app/v2/layout.tsx", "vite.config.ts", "wrangler.toml"])
    assert.ok(covered(path), `Missing transitive scheduler CI trigger: ${path}`);
});


// Execute the real shell entrypoint with all runtime commands replaced by local stubs. Never read
// the checkout's .dev.vars: these tests create only fake credentials in a disposable directory.
const personaServe = fileURLToPath(new URL("../scripts/e2e/serve.sh", import.meta.url));
function runPersonaServe(t, bindings, overrides = {}) {
 const cwd = mkdtempSync(join(tmpdir(), "pawspace-persona-bindings-"));
 t.after(() => rmSync(cwd, {recursive:true,force:true}));
 const bin = join(cwd, "bin"), log = join(cwd, "commands.log"), vars = join(cwd, ".dev.vars");
 mkdirSync(bin);
 for (const command of ["npx","node","npm"]) writeFileSync(join(bin,command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$PERSONA_STUB_LOG"\nexit 0\n`, {mode:0o755});
 if (bindings !== null) writeFileSync(vars, bindings);
 const result = spawnSync("bash", [personaServe], {cwd,encoding:"utf8",timeout:5000,env:{
  PATH:bin+delimiter+process.env.PATH, PERSONA_STUB_LOG:log,
  PW_UAT_SERVICE_DATE:"2026-10-05", PAWSPACE_UAT_EXECUTION_NOW_MS:"1791189000000",
  PAWSPACE_PAYMENT_ENV:"sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED:"false", ...overrides,
 }});
 assert.ifError(result.error);
 return {...result,executedBinding:existsSync(join(cwd,"should-not-exist")),bindings:existsSync(vars)?readFileSync(vars,"utf8"):null,
  commands:existsSync(log)?readFileSync(log,"utf8").trim().split("\n"):[]};
}
function assertPersonaSandbox(result) {
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.executedBinding,false);
 assert.deepEqual(result.commands,["npx","node","npm"]);
 const actual = Object.fromEntries(result.bindings.trim().split("\n").map(line => {
  const equals=line.indexOf("=");return [line.slice(0,equals),JSON.parse(line.slice(equals+1))];
 }));
 assert.equal(actual.PAWSPACE_DEPLOYMENT_ENV,"e2e");
 assert.equal(actual.FORBID_PRODUCTION,"true");
 assert.equal(actual.PAWSPACE_PAYMENT_ENV,"sandbox");
 assert.equal(actual.PAWSPACE_PAYMENT_LIVE_APPROVED,"false");
 assert.equal(actual.PAWSPACE_SCHEDULING_ENV,"uat");
 assert.equal(actual.PAWSPACE_MEDIA_ENV,"uat");
 assert.equal(actual.PAWSPACE_IDENTITY_ENV,"sandbox");
 assert.equal(actual.PAWSPACE_UAT_SERVICE_CLOCK,"on");
 assert.equal(actual.PAWSPACE_UAT_EXECUTION_NOW_MS,"1791189000000");
 return actual;
}
test("persona shell starts without a Maps key and retains only its explicit sandbox defaults", t => {
 const result=runPersonaServe(t,null),actual=assertPersonaSandbox(result);
 assert.equal(Object.hasOwn(actual,"GOOGLE_MAPS_SERVER_API_KEY_UAT"),false);
});
test("persona shell retains the workflow's quoted UAT Maps key and discards every other inherited binding", t => {
 const secret="fake_uat_maps_key-not-a-real-credential";
 const result=runPersonaServe(t,[`GOOGLE_MAPS_SERVER_API_KEY_UAT=${JSON.stringify(secret)}`,
  'GOOGLE_MAPS_SERVER_API_KEY="fake-live-maps"','RAZORPAY_KEY_SECRET_LIVE="fake-live-payment"',
  'ELEVENLABS_API_KEY="fake-provider-secret"','OPENAI_API_KEY="fake-ai-secret"',
  'PAWSPACE_PAYMENT_ENV="live"','PAWSPACE_PAYMENT_LIVE_APPROVED="true"',
  'PAWSPACE_DEPLOYMENT_ENV="production"','FORBID_PRODUCTION="false"',
  'PAWSPACE_UAT_SIGNING_KEY="fake-inherited-signing-key"',
  'UNRECOGNIZED_BINDING="discard-me"','IGNORED_COMMAND=$(touch should-not-exist)',
 ].join("\n"));
 const actual=assertPersonaSandbox(result);
 assert.equal(actual.GOOGLE_MAPS_SERVER_API_KEY_UAT,secret);
 assert.equal(actual.PAWSPACE_UAT_SIGNING_KEY,"pawspace-e2e-signing-key-local-only-20260911");
 for(const key of ["GOOGLE_MAPS_SERVER_API_KEY","RAZORPAY_KEY_SECRET_LIVE","ELEVENLABS_API_KEY","OPENAI_API_KEY","UNRECOGNIZED_BINDING","IGNORED_COMMAND"])assert.equal(Object.hasOwn(actual,key),false,key);
 assert.equal(result.stdout.includes(secret),false);assert.equal(result.stderr.includes(secret),false);
 assert.equal(result.bindings.includes("fake-live"),false);assert.equal(result.bindings.includes("fake-provider"),false);
});
for(const [label,bindings] of [
 ["unterminated",'GOOGLE_MAPS_SERVER_API_KEY_UAT="fake-secret'],
 ["unquoted",'GOOGLE_MAPS_SERVER_API_KEY_UAT=fake-secret'],
 ["shell interpolation",'GOOGLE_MAPS_SERVER_API_KEY_UAT="$(touch should-not-exist)"'],
 ["embedded line break",'GOOGLE_MAPS_SERVER_API_KEY_UAT="fake-secret\\nPAWSPACE_PAYMENT_ENV=live"'],
 ["empty",'GOOGLE_MAPS_SERVER_API_KEY_UAT=""'],
 ["duplicate",'GOOGLE_MAPS_SERVER_API_KEY_UAT="fake-secret-one"\nGOOGLE_MAPS_SERVER_API_KEY_UAT="fake-secret-two"'],
 ["export duplicate",'GOOGLE_MAPS_SERVER_API_KEY_UAT="fake-secret-one"\nexport GOOGLE_MAPS_SERVER_API_KEY_UAT="fake-secret-two"'],
])test(`persona shell refuses ${label} Maps bindings before rewrite or runtime commands`,t=>{
 const result=runPersonaServe(t,bindings);
 assert.notEqual(result.status,0);assert.deepEqual(result.commands,[]);assert.equal(result.executedBinding,false);
 assert.equal(result.bindings,bindings,"invalid input must not be partly rewritten");
 assert.equal(result.stdout,"");
 assert.equal(result.stderr.trim(),"[persona-e2e] refusing to start: invalid or duplicate UAT Maps binding");
 assert.equal(result.stderr.includes("fake-secret"),false);
});
for(const override of [{PAWSPACE_PAYMENT_ENV:"live"},{PAWSPACE_PAYMENT_LIVE_APPROVED:"true"}])test(`persona shell retains its live-money refusal: ${Object.keys(override)[0]}`,t=>{
 const bindings='GOOGLE_MAPS_SERVER_API_KEY_UAT="fake-secret"';
 const result=runPersonaServe(t,bindings,override);
 assert.notEqual(result.status,0);assert.deepEqual(result.commands,[]);assert.equal(result.bindings,bindings);
 assert.match(result.stderr,/refusing to start/);assert.equal(result.stderr.includes("fake-secret"),false);
});
