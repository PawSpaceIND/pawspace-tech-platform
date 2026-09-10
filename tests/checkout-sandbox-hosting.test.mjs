import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkoutSandboxPlan, checkoutSandboxConfig, assertCheckoutCandidate, activeCheckoutVersion, readCheckoutDatabaseInventory, resolveCheckoutDatabaseGuards, CHECKOUT_REPOSITORY, CHECKOUT_BRANCH } from "../lib/checkout-sandbox-hosting.ts";

const sha="a".repeat(40);
const base=()=>({GITHUB_REPOSITORY:CHECKOUT_REPOSITORY,GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"workflow_dispatch",CONFIRM:"checkout-sandbox-674",EXPECTED_SHA:sha,GITHUB_RUN_ID:"123456789",GITHUB_RUN_ATTEMPT:"1",PRODUCTION_D1_ID:"10000000-0000-4000-8000-000000000001",SHARED_STAGING_D1_ID:"20000000-0000-4000-8000-000000000002",RELEASE_PREVIEW_D1_ID:"30000000-0000-4000-8000-000000000003",RELEASE_PREVIEW_WORKER_NAME:"pawspace-frozen-beta",PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_SyntheticHostFixture",RAZORPAY_KEY_SECRET_SANDBOX:"synthetic-api-secret",RAZORPAY_WEBHOOK_SECRET_SANDBOX:"synthetic-webhook-secret",PAWSPACE_UAT_ACCESS_CODE:"7".repeat(64),PAWSPACE_UAT_SIGNING_KEY:"8".repeat(64),PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT:"9".repeat(64),GOOGLE_MAPS_SERVER_API_KEY_UAT:"AIzaSyntheticCheckoutSandboxMapsKey123456789"});
const artifact=()=>({main:"index.js",no_bundle:true,assets:{directory:"../client"},compatibility_date:"2026-05-15",compatibility_flags:["nodejs_compat"]});
const freshId="40000000-0000-4000-8000-000000000004";
const inventory=()=>[
 {name:"pawspace-prod-bengaluru",uuid:"10000000-0000-4000-8000-000000000001"},
 {name:"pawspace-staging",uuid:"20000000-0000-4000-8000-000000000002"},
 {name:"pawspace-frozen-beta",uuid:"30000000-0000-4000-8000-000000000003"},
];
const frozenSettings=()=>({bindings:[{name:"DB",type:"d1",id:inventory()[2].uuid}]});
const resolvedPlan=(env=base())=>resolveCheckoutDatabaseGuards(checkoutSandboxPlan(env),inventory(),frozenSettings());


test("hosting plan separates run attempts and carries only explicit secret bindings",()=>{
 const one=checkoutSandboxPlan(base()),two=checkoutSandboxPlan({...base(),GITHUB_RUN_ATTEMPT:"2"});
 assert.equal(one.worker,"pawspace-checkout-674-123456789-1");assert.notEqual(one.worker,two.worker);assert.equal(Object.keys(one.secrets).length,7);
});
for(const [key,value] of [["GITHUB_REPOSITORY","foreign/repo"],["GITHUB_REF","refs/heads/feature"],["GITHUB_EVENT_NAME","pull_request"],["CONFIRM","release-preview"],["EXPECTED_SHA","main"],["EXPECTED_SHA",sha.toUpperCase()],["GITHUB_RUN_ID","1;false"],["GITHUB_RUN_ATTEMPT","0"],["PAWSPACE_PAYMENT_ENV","live"],["FORBID_PRODUCTION","false"],["PAWSPACE_PAYMENT_LIVE_APPROVED","true"],["RAZORPAY_KEY_ID_SANDBOX","rzp_live_abcd"],["RAZORPAY_KEY_ID_SANDBOX","rzp_test_placeholder"]]){
 test(`hosting refuses invalid ${key}=${value}`,()=>assert.throws(()=>checkoutSandboxPlan({...base(),[key]:value})));
}
for(const key of ["RELEASE_PREVIEW_D1_ID","RELEASE_PREVIEW_WORKER_NAME","RAZORPAY_WEBHOOK_SECRET_SANDBOX","RAZORPAY_KEY_SECRET_SANDBOX","PAWSPACE_UAT_ACCESS_CODE","PAWSPACE_UAT_SIGNING_KEY","PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT","GOOGLE_MAPS_SERVER_API_KEY_UAT"]){
 test(`hosting refuses absent ${key} instead of assuming safety`,()=>assert.throws(()=>checkoutSandboxPlan({...base(),[key]:"  "})));
}
test("hosting refuses short or previously published-shaped UAT credentials",()=>{
 for(const value of ["short","pawspace-"+"x".repeat(64)])assert.throws(()=>checkoutSandboxPlan({...base(),PAWSPACE_UAT_ACCESS_CODE:value}));
});
test("generated config strips inherited credentials, routes, schedules and unrelated bindings",()=>{
 const plan=resolvedPlan();
 const built={...artifact(),name:"pawspace-production",routes:["app.pawspace.in/*"],triggers:{crons:["* * * * *"]},vars:{RAZORPAY_KEY_SECRET:"bad",PAWSPACE_LOCAL_PREVIEW:"on"},services:[{binding:"PRODUCTION"}],r2_buckets:[{bucket_name:"real"}],queues:{consumers:[{queue:"live"}]}};
 const cfg=checkoutSandboxConfig(built,plan,freshId),serialized=JSON.stringify(cfg);
 assert.equal(cfg.name,plan.worker);assert.deepEqual(cfg.routes,[]);assert.deepEqual(cfg.triggers,{crons:[]});
 assert.deepEqual(cfg.d1_databases,[{binding:"DB",database_name:plan.worker,database_id:freshId}]);
 assert.equal(cfg.vars.PAWSPACE_LOCAL_PREVIEW,"off");assert.equal(cfg.vars.FORBID_PRODUCTION,"true");assert.equal(cfg.vars.PAWSPACE_PAYMENT_ENV,"sandbox");assert.equal(cfg.vars.PAWSPACE_PAYMENT_LIVE_APPROVED,"false");assert.equal(cfg.vars.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE,"on");
 for(const value of Object.values(plan.secrets))assert.equal(serialized.includes(value),false);
 for(const key of ["services","r2_buckets","queues"])assert.equal(key in cfg,false);
 for(const [key,value] of Object.entries(cfg.vars))if(key.startsWith("PAWSPACE_LIVE_"))assert.equal(value,"false");
});
test("generated config refuses each protected database and a frozen Worker collision",()=>{
 const env=base(),plan=resolvedPlan(env);
 for(const id of plan.protectedIds)assert.throws(()=>checkoutSandboxConfig(artifact(),plan,id.toUpperCase()));
 assert.throws(()=>checkoutSandboxPlan({...env,RELEASE_PREVIEW_WORKER_NAME:plan.worker}));
 assert.throws(()=>checkoutSandboxConfig(artifact(),plan,"not-an-id"));
});
test("generated config refuses another entrypoint, remote assets and missing runtime compatibility",()=>{
 const plan=resolvedPlan();
 for(const a of [{...artifact(),main:"../../../other.js"},{...artifact(),assets:{directory:"/outside"}},{...artifact(),no_bundle:false},{...artifact(),compatibility_flags:[]}])assert.throws(()=>checkoutSandboxConfig(a,plan,freshId));
});
test("checkout identity refuses a moved head, fork, closed PR or another branch",()=>{
 const pr={state:"open",head:{sha,ref:CHECKOUT_BRANCH,repo:{full_name:CHECKOUT_REPOSITORY}}};
 assert.doesNotThrow(()=>assertCheckoutCandidate(pr,sha));
 for(const bad of [{...pr,state:"closed"},{...pr,head:{...pr.head,sha:"b".repeat(40)}},{...pr,head:{...pr.head,ref:"main"}},{...pr,head:{...pr.head,repo:{full_name:"foreign/repo"}}}])assert.throws(()=>assertCheckoutCandidate(bad,sha));
});
test("workflow is manual protected-main only and exposes secrets only after candidate build",()=>{
 const s=readFileSync(new URL("../.github/workflows/deploy-checkout-sandbox.yml",import.meta.url),"utf8");
 assert.match(s,/workflow_dispatch:/);assert.doesNotMatch(s,/^  (push|pull_request|schedule):/m);
 assert.match(s,/github.ref == 'refs\/heads\/main'/);assert.match(s,/environment: pawspace-release-preview/);
 assert.match(s,/cancel-in-progress: false/);assert.ok(s.indexOf('RAZORPAY_KEY_SECRET_SANDBOX:')>s.indexOf('run: npm run build'));assert.ok(s.indexOf('GOOGLE_MAPS_SERVER_API_KEY_UAT:')>s.indexOf('run: npm run build'));
 assert.doesNotMatch(s,/continue-on-error: true|contents: write|--prod|deploy-release-preview.yml/);
});

// Provider transport is replaced only in this test child. No Cloudflare or Razorpay calls occur.
function runnerFixture(scenario="success"){
 const dir=mkdtempSync(resolve(tmpdir(),"checkout-host-test-")),candidate=resolve(dir,"candidate");mkdirSync(resolve(candidate,"dist/server"),{recursive:true});mkdirSync(resolve(candidate,"node_modules/.bin"),{recursive:true});
 writeFileSync(resolve(candidate,"tracked.txt"),"fixture");
 for(const args of [["init","-q"],["add","tracked.txt"],["-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","-qm","fixture"]])assert.equal(spawnSync("git",args,{cwd:candidate,encoding:"utf8"}).status,0);
 const exact=spawnSync("git",["rev-parse","HEAD"],{cwd:candidate,encoding:"utf8"}).stdout.trim();
 writeFileSync(resolve(candidate,"dist/server/wrangler.json"),JSON.stringify(artifact()));
 const stub=resolve(candidate,"node_modules/.bin/wrangler");writeFileSync(stub,'#!/usr/bin/env node\nconsole.log("https://pawspace-checkout-674-123456789-1.fixture.workers.dev");\n');chmodSync(stub,0o755);
 const preload=resolve(dir,"network-fixture.mjs");
 writeFileSync(preload,`import{readFileSync,appendFileSync}from"node:fs";\nconst id=${JSON.stringify(freshId)};globalThis.fetch=async(url,init={})=>{const u=String(url);appendFileSync(${JSON.stringify(resolve(dir,"requests.log"))},(init.method||"GET")+" "+u+"\\n");const reply=result=>Response.json({success:true,result});if(u.includes("api.github.com"))return Response.json({state:"open",head:{sha:${JSON.stringify(exact)},ref:${JSON.stringify(CHECKOUT_BRANCH)},repo:{full_name:${JSON.stringify(CHECKOUT_REPOSITORY)}}}});if(u.includes("/d1/database?"))return Response.json({success:true,result:u.endsWith("page=1")?${JSON.stringify(scenario==="missing-protected"?inventory().slice(1):inventory())}:[],result_info:{page:u.endsWith("page=1")?1:2,per_page:100}});if(u.includes("pawspace-frozen-beta/settings"))return reply(${JSON.stringify(frozenSettings())});if(u.endsWith("/deployments"))return reply({deployments:[{id:"deployment-fixture",versions:[{version_id:"version-fixture",percentage:100}]}]});if(u.endsWith("/d1/database"))return reply({uuid:id,name:JSON.parse(init.body).name});if(u.endsWith("/schedules"))return reply({schedules:[]});if(u.endsWith("/settings")){if(!globalThis.created){globalThis.created=true;return ${scenario==="exists"?'reply({bindings:[]})':'Response.json({success:false},{status:404})'};}const c=JSON.parse(readFileSync(process.env.CANDIDATE_DIR+"/dist/server/wrangler.json","utf8"));return reply({annotations:{"workers/message":"checkout-sandbox "+process.env.EXPECTED_SHA},bindings:[{name:"DB",type:"d1",id},...Object.entries(c.vars).map(([name,text])=>({name,type:"plain_text",text})),...${JSON.stringify(Object.keys(checkoutSandboxPlan(base()).secrets))}.map(name=>({name,type:"secret_text"}))]});}if(u.endsWith("/api/staging-login"))return Response.json({ok:true},{status:200,headers:{"set-cookie":"pawspace_uat=fixture; Path=/; HttpOnly"}});if(u.endsWith("/mobile-app")||u.endsWith("/staging-login"))return new Response("<html>PawSpace</html>",{headers:{"content-type":"text/html"}});if(u.includes("/api/address-autocomplete?"))return Response.json({data:{status:"configured",suggestions:[{placeId:"fixture",fullText:"Indiranagar, Bengaluru 560038"}]}});if(u.endsWith("/api/customer-checkout"))return Response.json({error:"unauthorized"},{status:401});if(u.endsWith("/api/razorpay-webhook"))return Response.json({error:"signature required"},{status:400});throw Error("Unexpected fixture network request");};`);
 const env={...process.env,...base(),EXPECTED_SHA:exact,CANDIDATE_DIR:candidate,CHECKOUT_EVIDENCE_DIR:resolve(dir,"evidence"),RUNNER_TEMP:dir,CLOUDFLARE_ACCOUNT_ID:"c".repeat(32),CLOUDFLARE_API_TOKEN:"synthetic-cloud-token",GITHUB_TOKEN:"synthetic-github-token"};
 if(scenario==="missing")delete env.RAZORPAY_WEBHOOK_SECRET_SANDBOX;
 const result=spawnSync(process.execPath,["--experimental-strip-types","--import",preload,resolve(new URL("../scripts/deploy-checkout-sandbox.mjs",import.meta.url).pathname)],{env,encoding:"utf8",timeout:20000});
 return{dir,result,env,requests:existsSync(resolve(dir,"requests.log"))?readFileSync(resolve(dir,"requests.log"),"utf8"):""};
}
test("actual provisioning runner validates settings and HTTP surfaces while keeping secrets out of artifacts",()=>{
 const f=runnerFixture();try{
  assert.equal(f.result.status,0,f.result.stderr+f.result.stdout);
  const report=JSON.parse(readFileSync(resolve(f.dir,"evidence/hosting-report.json"),"utf8"));assert.equal(report.hosted,true);assert.equal(report.customerUiVerified,false);assert.equal(report.capture,"NOT_RUN");assert.equal(report.providerWebhookDelivery,"NOT_RUN");assert.equal(report.checks.mapsAutocompleteConfigured,true);
  assert.equal(f.requests.split("POST ").length-1,4); // D1 creation, UAT login and two negative application probes.
  assert.equal(existsSync(resolve(f.dir,"checkout-private-123456789-1/secrets.json")),false);
  for(const value of Object.values(checkoutSandboxPlan(base()).secrets))assert.equal(JSON.stringify(report).includes(value),false);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test("actual provisioning runner refuses an existing Worker before creating a database",()=>{
 const f=runnerFixture("exists");try{assert.notEqual(f.result.status,0);assert.equal(f.requests.includes("POST "),false);assert.match(f.result.stderr,/will not overwrite/);}finally{rmSync(f.dir,{recursive:true,force:true});}
});
test("actual provisioning runner refuses missing sandbox webhook configuration before any request",()=>{
 const f=runnerFixture("missing");try{assert.notEqual(f.result.status,0);assert.equal(f.requests,"");}finally{rmSync(f.dir,{recursive:true,force:true});}
});

test("active deployment provenance refuses split traffic and a stale candidate message",()=>{
 const deployed={deployments:[{id:"deployment",versions:[{version_id:"version",percentage:100}]}]},settings={annotations:{"workers/message":`checkout-sandbox ${sha}`}};
 assert.deepEqual(activeCheckoutVersion(deployed,settings,sha),{deploymentId:"deployment",versionId:"version"});
 assert.throws(()=>activeCheckoutVersion({deployments:[]},settings,sha));
 assert.throws(()=>activeCheckoutVersion(deployed,{annotations:{}},sha));
 assert.throws(()=>activeCheckoutVersion(deployed,settings,"b".repeat(40)));
 assert.throws(()=>activeCheckoutVersion({deployments:[{id:"deployment",versions:[{version_id:"version",percentage:50},{version_id:"old",percentage:50}]}]},settings,sha));
});

test("secret installation refuses to silently trim a stored credential",()=>{
 assert.throws(()=>checkoutSandboxPlan({...base(),RAZORPAY_WEBHOOK_SECRET_SANDBOX:" stored-secret "}));
});

test("the opaque legacy production reference is not trusted or needed for authoritative isolation",()=>{
 const plan=resolvedPlan({...base(),PRODUCTION_D1_ID:"unresolved-legacy-reference",SHARED_STAGING_D1_ID:undefined});
 assert.deepEqual(new Set(plan.protectedIds),new Set(inventory().map(row=>row.uuid)));
 assert.throws(()=>checkoutSandboxConfig(artifact(),checkoutSandboxPlan(base()),freshId),/inventory/);
});
test("inventory guard refuses missing or ambiguous protected names and changed frozen bindings",()=>{
 const plan=checkoutSandboxPlan(base());
 assert.throws(()=>resolveCheckoutDatabaseGuards(plan,inventory().slice(1),frozenSettings()));
 assert.throws(()=>resolveCheckoutDatabaseGuards(plan,[...inventory(),{...inventory()[0],uuid:freshId}],frozenSettings()));
 assert.throws(()=>resolveCheckoutDatabaseGuards(plan,inventory(),{bindings:[{name:"DB",type:"d1",id:freshId}]}));
 assert.throws(()=>resolveCheckoutDatabaseGuards(plan,inventory(),{bindings:[]}));
 assert.throws(()=>resolveCheckoutDatabaseGuards({...plan,frozenWorker:"wrong-preview"},inventory(),frozenSettings()));
});
test("inventory guard protects every existing database, not just the three named environments",()=>{
 const extra={uuid:"50000000-0000-4000-8000-000000000005",name:"another-existing-db"};
 const plan=resolveCheckoutDatabaseGuards(checkoutSandboxPlan(base()),[...inventory(),extra],frozenSettings());
 assert.throws(()=>checkoutSandboxConfig(artifact(),plan,extra.uuid));
 assert.throws(()=>resolveCheckoutDatabaseGuards(checkoutSandboxPlan(base()),[...inventory(),{...extra,name:plan.worker}],frozenSettings()));
});
test("inventory reader continues after a short page until an explicit terminal page",async()=>{
 const calls=[];const rows=await readCheckoutDatabaseInventory(async page=>{calls.push(page);return{result:page===1?inventory().slice(0,1):page===2?inventory().slice(1):[],result_info:{page,per_page:100}};});
 assert.deepEqual(calls,[1,2,3]);assert.deepEqual(rows,inventory());
});
test("inventory reader refuses incomplete, repeated or wrongly numbered pages",async()=>{
 await assert.rejects(()=>readCheckoutDatabaseInventory(async()=>({result:{}})),/incomplete/);
 await assert.rejects(()=>readCheckoutDatabaseInventory(async()=>({result:inventory()})),/repeated/);
 await assert.rejects(()=>readCheckoutDatabaseInventory(async()=>({result:[],result_info:{page:9}})),/pagination/);
 await assert.rejects(()=>readCheckoutDatabaseInventory(async()=>({result:[{name:"invalid",uuid:"bad"}]})),/invalid identity/);
 await assert.rejects(()=>readCheckoutDatabaseInventory(async page=>{if(page===2)throw Error("provider unavailable");return{result:inventory()};}),/provider unavailable/);
});

test("actual provisioning runner refuses missing protected inventory before any resource write",()=>{
 const f=runnerFixture("missing-protected");try{assert.notEqual(f.result.status,0);assert.equal(f.requests.includes("POST "),false);assert.match(f.result.stderr,/Cannot unambiguously resolve protected database/);}finally{rmSync(f.dir,{recursive:true,force:true});}
});
test("inventory reader has a bounded completion requirement even for unique repeated pages",async()=>{
 let calls=0;await assert.rejects(()=>readCheckoutDatabaseInventory(async page=>{calls++;return{result:[{uuid:`90000000-0000-4000-8000-${String(page).padStart(12,"0")}`,name:`db-${page}`}]};}),/bounded page limit/);assert.equal(calls,100);
});

test("hosted UI workflow uses actual UAT authentication and keeps provider secrets out of the browser step",()=>{
 const workflow=readFileSync(new URL("../.github/workflows/deploy-checkout-sandbox.yml",import.meta.url),"utf8");
 const browser=readFileSync(new URL("../scripts/verify-checkout-hosted-browser.mjs",import.meta.url),"utf8");
 const step=workflow.split("- name: Verify authenticated customer UI")[1].split("- name: Retain")[0];
 assert.match(step,/PAWSPACE_UAT_ACCESS_CODE/);assert.doesNotMatch(step,/RAZORPAY_|CLOUDFLARE_|SIGNING_KEY/);
 assert.ok(workflow.indexOf("npx playwright install")<workflow.indexOf("Create-only isolated root"));
 assert.match(browser,/context.request.post\(origin\+"\/api\/staging-login"/);
 assert.match(browser,/pawspace-prototype-converged/);assert.match(browser,/viewports.some\(row=>!row.pass\)/);
 assert.doesNotMatch(browser,/setExtraHTTPHeaders|addCookies|\.route\(/);
});

test("hosted browser and assertions use the same installed Playwright runtime",()=>{
 const browser=readFileSync(new URL("../scripts/verify-checkout-hosted-browser.mjs",import.meta.url),"utf8");
 assert.match(browser,/const \{chromium,expect\}=require\("@playwright\/test"\)/);
 assert.doesNotMatch(browser,/require\("playwright"\)/);
 assert.match(browser,/hostname.startsWith\(`\$\{hosting.worker\}\.`\)/);
});

test("future provisioner retries Worker readiness and authenticates before Maps verification",()=>{
 const source=readFileSync(new URL("../scripts/deploy-checkout-sandbox.mjs",import.meta.url),"utf8");
 assert.match(source,/appEventually/);
 assert.match(source,/\/api\/staging-login/);
 assert.match(source,/PAWSPACE_UAT_ACCESS_CODE/);
 assert.match(source,/headers: \{ cookie: sessionCookie \}/);
});

test("existing sandbox verifier is read-only and exact-worker pinned",()=>{
 const source=readFileSync(new URL("../scripts/verify-existing-checkout-sandbox.mjs",import.meta.url),"utf8");
 assert.match(source,/EXPECTED_WORKER_NAME/);
 assert.match(source,/workers\/subdomain/);
 assert.match(source,/activeCheckoutVersion/);
 assert.match(source,/mapsAutocompleteConfigured/);
 assert.doesNotMatch(source,/method:\s*"(PUT|PATCH|DELETE)"|\/d1\/database",\s*\{\s*method:\s*"POST"/);
});

test("existing sandbox workflow is manual protected-main and browser step receives no provider credentials",()=>{
 const workflow=readFileSync(new URL("../.github/workflows/verify-existing-checkout-sandbox.yml",import.meta.url),"utf8");
 assert.match(workflow,/workflow_dispatch:/);
 assert.doesNotMatch(workflow,/^  (push|pull_request|schedule):/m);
 assert.match(workflow,/github.ref == 'refs\/heads\/main'/);
 assert.match(workflow,/environment: pawspace-release-preview/);
 const browser=workflow.split("- name: Verify authenticated approved customer UI")[1].split("- name: Retain")[0];
 assert.match(browser,/PAWSPACE_UAT_ACCESS_CODE/);
 assert.doesNotMatch(browser,/RAZORPAY_|CLOUDFLARE_|SIGNING_KEY|MAPS_SERVER/);
});
