import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkoutSandboxPlan, checkoutSandboxConfig, assertCheckoutCandidate, activeCheckoutVersion, CHECKOUT_REPOSITORY, CHECKOUT_BRANCH } from "../lib/checkout-sandbox-hosting.ts";

const sha="a".repeat(40);
const base=()=>({GITHUB_REPOSITORY:CHECKOUT_REPOSITORY,GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"workflow_dispatch",CONFIRM:"checkout-sandbox-674",EXPECTED_SHA:sha,GITHUB_RUN_ID:"123456789",GITHUB_RUN_ATTEMPT:"1",PRODUCTION_D1_ID:"10000000-0000-4000-8000-000000000001",SHARED_STAGING_D1_ID:"20000000-0000-4000-8000-000000000002",RELEASE_PREVIEW_D1_ID:"30000000-0000-4000-8000-000000000003",RELEASE_PREVIEW_WORKER_NAME:"pawspace-frozen-beta",PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_SyntheticHostFixture",RAZORPAY_KEY_SECRET_SANDBOX:"synthetic-api-secret",RAZORPAY_WEBHOOK_SECRET_SANDBOX:"synthetic-webhook-secret",PAWSPACE_UAT_ACCESS_CODE:"7".repeat(64),PAWSPACE_UAT_SIGNING_KEY:"8".repeat(64),PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT:"9".repeat(64)});
const artifact=()=>({main:"index.js",no_bundle:true,assets:{directory:"../client"},compatibility_date:"2026-05-15",compatibility_flags:["nodejs_compat"]});
const freshId="40000000-0000-4000-8000-000000000004";

test("hosting plan separates run attempts and carries only explicit secret bindings",()=>{
 const one=checkoutSandboxPlan(base()),two=checkoutSandboxPlan({...base(),GITHUB_RUN_ATTEMPT:"2"});
 assert.equal(one.worker,"pawspace-checkout-674-123456789-1");assert.notEqual(one.worker,two.worker);assert.equal(Object.keys(one.secrets).length,6);
});
for(const [key,value] of [["GITHUB_REPOSITORY","foreign/repo"],["GITHUB_REF","refs/heads/feature"],["GITHUB_EVENT_NAME","pull_request"],["CONFIRM","release-preview"],["EXPECTED_SHA","main"],["EXPECTED_SHA",sha.toUpperCase()],["GITHUB_RUN_ID","1;false"],["GITHUB_RUN_ATTEMPT","0"],["PAWSPACE_PAYMENT_ENV","live"],["FORBID_PRODUCTION","false"],["PAWSPACE_PAYMENT_LIVE_APPROVED","true"],["RAZORPAY_KEY_ID_SANDBOX","rzp_live_abcd"],["RAZORPAY_KEY_ID_SANDBOX","rzp_test_placeholder"]]){
 test(`hosting refuses invalid ${key}=${value}`,()=>assert.throws(()=>checkoutSandboxPlan({...base(),[key]:value})));
}
for(const key of ["PRODUCTION_D1_ID","SHARED_STAGING_D1_ID","RELEASE_PREVIEW_D1_ID","RELEASE_PREVIEW_WORKER_NAME","RAZORPAY_WEBHOOK_SECRET_SANDBOX","RAZORPAY_KEY_SECRET_SANDBOX","PAWSPACE_UAT_ACCESS_CODE","PAWSPACE_UAT_SIGNING_KEY","PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT"]){
 test(`hosting refuses absent ${key} instead of assuming safety`,()=>assert.throws(()=>checkoutSandboxPlan({...base(),[key]:"  "})));
}
test("hosting refuses short or previously published-shaped UAT credentials",()=>{
 for(const value of ["short","pawspace-"+"x".repeat(64)])assert.throws(()=>checkoutSandboxPlan({...base(),PAWSPACE_UAT_ACCESS_CODE:value}));
});
test("generated config strips inherited credentials, routes, schedules and unrelated bindings",()=>{
 const plan=checkoutSandboxPlan(base());
 const built={...artifact(),name:"pawspace-production",routes:["app.pawspace.in/*"],triggers:{crons:["* * * * *"]},vars:{RAZORPAY_KEY_SECRET:"bad",PAWSPACE_LOCAL_PREVIEW:"on"},services:[{binding:"PRODUCTION"}],r2_buckets:[{bucket_name:"real"}],queues:{consumers:[{queue:"live"}]}};
 const cfg=checkoutSandboxConfig(built,plan,freshId),serialized=JSON.stringify(cfg);
 assert.equal(cfg.name,plan.worker);assert.deepEqual(cfg.routes,[]);assert.deepEqual(cfg.triggers,{crons:[]});
 assert.deepEqual(cfg.d1_databases,[{binding:"DB",database_name:plan.worker,database_id:freshId}]);
 assert.equal(cfg.vars.PAWSPACE_LOCAL_PREVIEW,"off");assert.equal(cfg.vars.FORBID_PRODUCTION,"true");assert.equal(cfg.vars.PAWSPACE_PAYMENT_ENV,"sandbox");assert.equal(cfg.vars.PAWSPACE_PAYMENT_LIVE_APPROVED,"false");
 for(const value of Object.values(plan.secrets))assert.equal(serialized.includes(value),false);
 for(const key of ["services","r2_buckets","queues"])assert.equal(key in cfg,false);
 for(const [key,value] of Object.entries(cfg.vars))if(key.startsWith("PAWSPACE_LIVE_"))assert.equal(value,"false");
});
test("generated config refuses each protected database and a frozen Worker collision",()=>{
 const env=base(),plan=checkoutSandboxPlan(env);
 for(const id of plan.protectedIds)assert.throws(()=>checkoutSandboxConfig(artifact(),plan,id.toUpperCase()));
 assert.throws(()=>checkoutSandboxPlan({...env,RELEASE_PREVIEW_WORKER_NAME:plan.worker}));
 assert.throws(()=>checkoutSandboxConfig(artifact(),plan,"not-an-id"));
});
test("generated config refuses another entrypoint, remote assets and missing runtime compatibility",()=>{
 const plan=checkoutSandboxPlan(base());
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
 assert.match(s,/cancel-in-progress: false/);assert.ok(s.indexOf('RAZORPAY_KEY_SECRET_SANDBOX:')>s.indexOf('run: npm run build'));
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
 writeFileSync(preload,`import{readFileSync,appendFileSync}from"node:fs";\nconst id=${JSON.stringify(freshId)};globalThis.fetch=async(url,init={})=>{const u=String(url);appendFileSync(${JSON.stringify(resolve(dir,"requests.log"))},(init.method||"GET")+" "+u+"\\n");const reply=result=>Response.json({success:true,result});if(u.includes("api.github.com"))return Response.json({state:"open",head:{sha:${JSON.stringify(exact)},ref:${JSON.stringify(CHECKOUT_BRANCH)},repo:{full_name:${JSON.stringify(CHECKOUT_REPOSITORY)}}}});if(u.endsWith("/deployments"))return reply({deployments:[{id:"deployment-fixture",versions:[{version_id:"version-fixture",percentage:100}]}]});if(u.endsWith("/d1/database"))return reply({uuid:id,name:JSON.parse(init.body).name});if(u.endsWith("/schedules"))return reply({schedules:[]});if(u.endsWith("/settings")){if(!globalThis.created){globalThis.created=true;return ${scenario==="exists"?'reply({bindings:[]})':'Response.json({success:false},{status:404})'};}const c=JSON.parse(readFileSync(process.env.CANDIDATE_DIR+"/dist/server/wrangler.json","utf8"));return reply({annotations:{"workers/message":"checkout-sandbox "+process.env.EXPECTED_SHA},bindings:[{name:"DB",type:"d1",id},...Object.entries(c.vars).map(([name,text])=>({name,type:"plain_text",text})),...${JSON.stringify(Object.keys(checkoutSandboxPlan(base()).secrets))}.map(name=>({name,type:"secret_text"}))]});}if(u.endsWith("/mobile-app")||u.endsWith("/staging-login"))return new Response("<html>PawSpace</html>",{headers:{"content-type":"text/html"}});if(u.endsWith("/api/customer-checkout"))return Response.json({error:"unauthorized"},{status:401});if(u.endsWith("/api/razorpay-webhook"))return Response.json({error:"signature required"},{status:400});throw Error("Unexpected fixture network request");};`);
 const env={...process.env,...base(),EXPECTED_SHA:exact,CANDIDATE_DIR:candidate,CHECKOUT_EVIDENCE_DIR:resolve(dir,"evidence"),RUNNER_TEMP:dir,CLOUDFLARE_ACCOUNT_ID:"c".repeat(32),CLOUDFLARE_API_TOKEN:"synthetic-cloud-token",GITHUB_TOKEN:"synthetic-github-token"};
 if(scenario==="missing")delete env.RAZORPAY_WEBHOOK_SECRET_SANDBOX;
 const result=spawnSync(process.execPath,["--experimental-strip-types","--import",preload,resolve(new URL("../scripts/deploy-checkout-sandbox.mjs",import.meta.url).pathname)],{env,encoding:"utf8",timeout:20000});
 return{dir,result,env,requests:existsSync(resolve(dir,"requests.log"))?readFileSync(resolve(dir,"requests.log"),"utf8"):""};
}
test("actual provisioning runner validates settings and HTTP surfaces while keeping secrets out of artifacts",()=>{
 const f=runnerFixture();try{
  assert.equal(f.result.status,0,f.result.stderr+f.result.stdout);
  const report=JSON.parse(readFileSync(resolve(f.dir,"evidence/hosting-report.json"),"utf8"));assert.equal(report.hosted,true);assert.equal(report.capture,"NOT_RUN");assert.equal(report.providerWebhookDelivery,"NOT_RUN");
  assert.equal(f.requests.split("POST ").length-1,3); // D1 creation plus two negative application probes.
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
