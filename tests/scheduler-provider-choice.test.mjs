import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
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
