import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {ProductionConfigurationError,PRODUCTION_SERVICE_REGISTRY,assertProductionReadiness,collectProductionReadinessProblems} from "../lib/production-readiness-enforcement.mjs";

const GUARD=new URL("../scripts/assert-production-readiness.mjs",import.meta.url).pathname;
// A deliberately bare environment. Spreading process.env would inherit NODE_ENV=test and whatever the
// harness exports, and the dry-run path is exactly the one that must be exercised with nothing set.
const runGuard=(env={})=>{const result=spawnSync(process.execPath,[GUARD],{env,encoding:"utf8"});return{...result,json:result.stdout.trim()?JSON.parse(result.stdout):null};};

const goodBase={PAWSPACE_PRODUCTION_ENFORCE:"true",IDFY_API_KEY:"test-key",IDFY_ACCOUNT_ID:"test-account",IDFY_URL:"https://api.idfy.com/v3/tasks",IDFY_WEBHOOK_SECRET:"test-webhook-secret",PRODUCTION_R2_BUCKET_NAME:"pawspace-private-production",CLOUDFLARE_API_TOKEN:"test-cloudflare-token",CLOUDFLARE_ACCOUNT_ID:"test-cloudflare-account",PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64:"private-key-material",PROVIDER_AGREEMENT_ESIGN_PUBLIC_KEY_SPKI_B64:"public-key-material",PROVIDER_AGREEMENT_ESIGN_KEY_ID:"provider-agreement-2026-01",META_WHATSAPP_ACCESS_TOKEN:"meta-token",META_WHATSAPP_APP_SECRET:"meta-app-secret",META_WHATSAPP_VERIFY_TOKEN:"meta-verify",INTERAKT_API_KEY:"interakt",INTERAKT_WEBHOOK_SECRET:"interakt-webhook",META_WHATSAPP_WABA_ID:"waba",META_WHATSAPP_PHONE_NUMBER_ID:"phone"};
const healthyRegistry=[{id:"healthy",driver:"production_http",requiredSecrets:["SERVICE_SECRET"],requiredConfig:["SERVICE_URL"],handlers:[{name:"request",state:"implemented"}]}];

test("non-production profiles remain explicitly non-signable",()=>{assert.deepEqual(assertProductionReadiness({NODE_ENV:"test"},healthyRegistry),{ok:true,enforced:false,profile:"test",productionReady:false,zeroP0P1Blockers:false,releaseSignOffAllowed:false});});
test("PAWSPACE_PRODUCTION_ENFORCE=true activates the production guard",()=>{const result=assertProductionReadiness({PAWSPACE_PRODUCTION_ENFORCE:"true",SERVICE_SECRET:"s",SERVICE_URL:"https://service.example"},healthyRegistry);assert.equal(result.enforced,true);assert.equal(result.productionReady,true);assert.equal(result.zeroP0P1Blockers,true);assert.equal(result.releaseSignOffAllowed,true);});
test("production rejects mock or sandbox drivers",()=>{const registry=[{id:"database",driverEnv:"DATABASE_DRIVER",handlers:[{name:"connect",state:"implemented"}]}];assert.throws(()=>assertProductionReadiness({PAWSPACE_PRODUCTION_ENFORCE:"true",DATABASE_DRIVER:"memory"},registry),(error)=>error instanceof ProductionConfigurationError&&/mock or sandbox-only/.test(error.message));});
test("production rejects unbuilt handlers even when credentials are present",()=>{const registry=[{id:"documents",driver:"r2",handlers:[{name:"upload",state:"missing"}]}];assert.throws(()=>assertProductionReadiness({PAWSPACE_PRODUCTION_ENFORCE:"true"},registry),ProductionConfigurationError);});
test("private R2 storage is implemented but still requires deployment credentials and a production bucket",()=>{const storage=PRODUCTION_SERVICE_REGISTRY[1],problems=collectProductionReadinessProblems({PAWSPACE_PRODUCTION_ENFORCE:"true"},[storage]);for(const name of["CLOUDFLARE_API_TOKEN","CLOUDFLARE_ACCOUNT_ID","PRODUCTION_R2_BUCKET_NAME"])assert.ok(problems.some(problem=>problem.includes(name)));assert.ok(!problems.some(problem=>/server_owned_secure_upload is missing/.test(problem)));});
test("production provider agreement e-sign requires asymmetric signing material and key identity",()=>{const esign=PRODUCTION_SERVICE_REGISTRY[2],problems=collectProductionReadinessProblems({PAWSPACE_PRODUCTION_ENFORCE:"true"},[esign]);for(const name of["PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64","PROVIDER_AGREEMENT_ESIGN_PUBLIC_KEY_SPKI_B64","PROVIDER_AGREEMENT_ESIGN_KEY_ID"])assert.ok(problems.some(problem=>problem.includes(name)));assert.ok(!problems.some(problem=>/mock or sandbox-only|verified_digital_esign is mock/.test(problem)));});
test("canonical production registry can report all three sign-off booleans only when every dependency is declared",()=>{const result=assertProductionReadiness(goodBase);assert.equal(result.productionReady,true);assert.equal(result.zeroP0P1Blockers,true);assert.equal(result.releaseSignOffAllowed,true);});
test("the approved policy accepts complete IDfy sandbox and messaging UAT credentials",()=>{const env={...goodBase,PAWSPACE_TEST_API_POLICY_OVERRIDE:"true",IDFY_API_KEY_SANDBOX:"sandbox-key",IDFY_ACCOUNT_ID_SANDBOX:"sandbox-account",IDFY_WEBHOOK_SECRET_SANDBOX:"sandbox-webhook",IDFY_URL_SANDBOX:"https://sandbox.idfy.com",META_WHATSAPP_UAT_ACCESS_TOKEN:"uat-token",META_WHATSAPP_APP_SECRET_UAT:"uat-app-secret",META_WHATSAPP_VERIFY_TOKEN_UAT:"uat-verify",INTERAKT_API_KEY_SANDBOX:"interakt-test",INTERAKT_WEBHOOK_SECRET_SANDBOX:"interakt-test-webhook",META_WHATSAPP_WABA_ID_UAT:"uat-waba",META_WHATSAPP_PHONE_NUMBER_ID_UAT:"uat-phone"};for(const name of["IDFY_API_KEY","IDFY_ACCOUNT_ID","IDFY_WEBHOOK_SECRET","IDFY_URL","META_WHATSAPP_ACCESS_TOKEN","META_WHATSAPP_APP_SECRET","META_WHATSAPP_VERIFY_TOKEN","INTERAKT_API_KEY","INTERAKT_WEBHOOK_SECRET","META_WHATSAPP_WABA_ID","META_WHATSAPP_PHONE_NUMBER_ID"])delete env[name];const result=assertProductionReadiness(env);assert.equal(result.releaseSignOffAllowed,true);assert.deepEqual(result.policyOverridesApplied,["idfy_provider_verification","whatsapp_messaging"]);});
test("sandbox aliases are rejected unless the explicit policy override is enabled",()=>{const env={...goodBase,IDFY_API_KEY_SANDBOX:"sandbox-key"};delete env.IDFY_API_KEY;assert.throws(()=>assertProductionReadiness(env),error=>error instanceof ProductionConfigurationError&&/IDFY_API_KEY/.test(error.message));});
test("the policy override still fails closed when a test API credential is missing",()=>{const env={...goodBase,PAWSPACE_TEST_API_POLICY_OVERRIDE:"true",META_WHATSAPP_UAT_ACCESS_TOKEN:"uat-token"};for(const name of["META_WHATSAPP_ACCESS_TOKEN","META_WHATSAPP_APP_SECRET","META_WHATSAPP_APP_SECRET_UAT"])delete env[name];assert.throws(()=>assertProductionReadiness(env),error=>error instanceof ProductionConfigurationError&&/META_WHATSAPP_APP_SECRET_UAT/.test(error.message));});
test("the command-line production guard fails closed when a signing secret is absent",()=>{const env={...process.env,...goodBase};delete env.PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64;const result=spawnSync(process.execPath,[new URL("../scripts/assert-production-readiness.mjs",import.meta.url).pathname],{env,encoding:"utf8"});assert.notEqual(result.status,0);assert.match(result.stderr,/PRODUCTION_CONFIGURATION_ERROR/);assert.match(result.stderr,/PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64/);});

// --- Dry-run diagnostics -----------------------------------------------------------------------
// The Production Sign-Off workflow runs this guard with PAWSPACE_PRODUCTION_ENFORCE=false. Before
// these tests it printed a success-shaped payload and exited 0 having evaluated nothing, so a step
// named "production readiness audit" was green with 28 secrets injected and none of them checked.
// A dry run still cannot certify - that is what enforcement is for - but it must never be SILENT.

test("a dry run reports the full configuration gap inventory instead of a silent pass",()=>{
 const result=runGuard({PAWSPACE_PRODUCTION_ENFORCE:"false"});
 assert.equal(result.status,0,"a dry run stays non-blocking by default");
 assert.equal(result.json.dryRun,true);
 assert.equal(result.json.readinessVerified,false,"a dry run must never claim readiness was verified");
 assert.equal(result.json.releaseSignOffAllowed,false);
 assert.equal(result.json.gapCount,result.json.gaps.length);
 assert.ok(result.json.gapCount>0,"an empty environment has gaps and they must be reported");
 // Every declared service has to appear, or the inventory is not an inventory.
 for(const service of PRODUCTION_SERVICE_REGISTRY.map(entry=>entry.id))
  assert.ok(result.json.gaps.some(gap=>gap.startsWith(`${service}:`)),`${service} missing from the dry-run inventory`);
 assert.match(result.stderr,/NOT a production sign-off/);
 assert.match(result.stderr,/::warning title=Production readiness gap::/);
});

test("a dry run names every missing secret and configuration value the enforcing run would name",()=>{
 const dry=runGuard({PAWSPACE_PRODUCTION_ENFORCE:"false"});
 const enforced=collectProductionReadinessProblems({PAWSPACE_PRODUCTION_ENFORCE:"true"},PRODUCTION_SERVICE_REGISTRY);
 assert.deepEqual(dry.json.gaps,enforced,"the dry run must report exactly what enforcement would refuse on");
});

test("a dry run never prints the value of a configured secret, only its name",()=>{
 const canary="canary-value-that-must-never-be-printed";
 const env={PAWSPACE_PRODUCTION_ENFORCE:"false",IDFY_API_KEY:canary,META_WHATSAPP_ACCESS_TOKEN:canary};
 const result=runGuard(env);
 assert.equal(result.stdout.includes(canary),false,"a secret value leaked into stdout");
 assert.equal(result.stderr.includes(canary),false,"a secret value leaked into stderr");
 // The names of the two that ARE set drop out of the gap list; the rest are still reported.
 assert.equal(result.json.gaps.some(gap=>gap.includes("IDFY_API_KEY")),false);
 assert.ok(result.json.gaps.some(gap=>gap.includes("IDFY_ACCOUNT_ID")));
});

test("a dry run with a complete configuration reports no gaps",()=>{
 const env={...goodBase,PAWSPACE_PRODUCTION_ENFORCE:"false"};
 const result=runGuard(env);
 assert.equal(result.status,0);
 assert.equal(result.json.gapCount,0);
 assert.deepEqual(result.json.gaps,[]);
 assert.equal(result.json.readinessVerified,false,"a clean dry run is still not a sign-off");
 assert.match(result.stderr,/No configuration gaps detected/);
});

test("PAWSPACE_READINESS_DRY_RUN_STRICT turns a dry-run gap into a failing job",()=>{
 const gapped=runGuard({PAWSPACE_PRODUCTION_ENFORCE:"false",PAWSPACE_READINESS_DRY_RUN_STRICT:"true"});
 assert.equal(gapped.status,1);
 assert.equal(gapped.json.blocking,true);
 assert.match(gapped.stderr,/failing because the dry run found configuration gaps/);
 // Strict mode must not invent a failure when the configuration is actually complete.
 const clean=runGuard({...goodBase,PAWSPACE_PRODUCTION_ENFORCE:"false",PAWSPACE_READINESS_DRY_RUN_STRICT:"true"});
 assert.equal(clean.status,0);
 assert.equal(clean.json.blocking,false);
});

test("a dry run writes the gap table to the GitHub job summary when one is available",()=>{
 const path=join(mkdtempSync(join(tmpdir(),"readiness-summary-")),"summary.md");
 const result=runGuard({PAWSPACE_PRODUCTION_ENFORCE:"false",GITHUB_STEP_SUMMARY:path});
 assert.equal(result.status,0);
 const summary=readFileSync(path,"utf8");
 assert.match(summary,/DRY RUN \(nothing was certified\)/);
 assert.match(summary,/IDFY_API_KEY/);
 assert.match(summary,/whatsapp_messaging/);
});

test("enforcement is untouched by the dry-run diagnostics",()=>{
 const enforced=runGuard({...goodBase});
 assert.equal(enforced.status,0);
 assert.equal(enforced.json.enforced,true);
 assert.equal(enforced.json.releaseSignOffAllowed,true);
 assert.equal(enforced.json.dryRun,undefined,"the enforcing payload must not carry dry-run fields");
 const broken={...goodBase};delete broken.CLOUDFLARE_API_TOKEN;
 const failed=runGuard(broken);
 assert.equal(failed.status,1);
 assert.match(failed.stderr,/PRODUCTION_CONFIGURATION_ERROR/);
 assert.match(failed.stderr,/CLOUDFLARE_API_TOKEN/);
});
