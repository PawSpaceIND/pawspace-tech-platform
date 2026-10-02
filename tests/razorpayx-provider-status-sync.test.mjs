import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__RPX_SYNC_DB__","__RPX_SYNC_ENV__");

function d1(sqlite){const st=(sql,args=[])=>({bind:(...b)=>st(sql,b),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const x=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(x.changes)}}},all:async()=>({results:sqlite.prepare(sql).all(...args)})});return{prepare:s=>st(s),batch:async items=>{const out=[];for(const item of items)out.push(await item.run());return out;},exec:async sql=>{sqlite.exec(sql);return{count:0,duration:0}}};}
const baseEnv=url=>({PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_RAZORPAYX_ENV:"sandbox",PAWSPACE_RAZORPAYX_LIVE_APPROVED:"false",RAZORPAYX_KEY_ID_SANDBOX:"rzp_test_provider",RAZORPAYX_KEY_SECRET_SANDBOX:"secret",RAZORPAYX_ACCOUNT_NUMBER_SANDBOX:"7878780080316316",RAZORPAYX_WEBHOOK_SECRET_SANDBOX:"webhook-secret",PAWSPACE_RAZORPAYX_CONTRACT_TEST:"true",PAWSPACE_RAZORPAYX_API_BASE_URL:url});
async function provider(status="processed",overrides={}){const calls=[];const server=http.createServer((req,res)=>{let raw="";req.on("data",x=>raw+=x);req.on("end",()=>{calls.push({method:req.method,url:req.url});if(req.method==="GET"&&req.url==="/v1/payouts/pout_TEST123"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"pout_TEST123",entity:"payout",fund_account_id:"fa_TEST123",amount:50000,currency:"INR",status,reference_id:"RPX-LOCAL-1",utr:"UTR-SYNC",...overrides}));return;}if(req.method==="POST"){res.writeHead(500);res.end(JSON.stringify({error:{description:"create must not run"}}));return;}res.writeHead(404);res.end("{}");});});await new Promise(r=>server.listen(0,"127.0.0.1",r));return{calls,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>server.close(r))};}
async function world(){const sqlite=new DatabaseSync(":memory:"),db=d1(sqlite);globalThis.__RPX_SYNC_DB__=db;const governance=await import("../lib/provider-commission-governance.ts"),settlement=await import("../lib/partner-settlement-governance.ts"),accounts=await import("../lib/finance-accounts.ts");await governance.ensureProviderCommissionTables(db);await settlement.ensurePartnerSettlementTables(db);await accounts.ensureFinanceJournalTable(db);return{sqlite,db,runtime:await import("../lib/razorpayx-payout-runtime.ts")};}
function seedCommission(w,{withProvider=true,status="provider_processing_sandbox",amount=500}={}){const t=Date.now();w.sqlite.prepare("INSERT INTO provider_order_payouts (id,booking_id,provider_id,amount,currency,rail,environment,status,due_at,razorpayx_contact_id,razorpayx_fund_account_id,idempotency_key,provider_reference,created_by,created_at,updated_at) VALUES (?,?,?,?,'INR','razorpayx','sandbox',?,?, 'cont_TEST',?,?,?,'checker2',?,?)").run("RPX-LOCAL-1","BK-RPX-1","PRV-RPX",amount,status,t+10000,"fa_TEST123","idem-rpx-1",withProvider?"pout_TEST123":null,t,t);w.sqlite.prepare("INSERT INTO provider_order_commissions (id,booking_id,work_order_id,provider_id,service_code,order_amount,commission_mode,commission_value,commission_amount,commission_source,status,completed_at,due_at,confirmed_by,confirmed_at,approval_level_1_by,approval_level_1_at,approval_level_2_by,approval_level_2_at,payout_id,created_at,updated_at) VALUES (?,?,?,?,?,2500,'percent',20,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("COMM-RPX","BK-RPX-1","WO-RPX","PRV-RPX","pet_grooming",amount,"provider_default",status,t,t+10000,"maker",t,"checker1",t,"checker2",t,"RPX-LOCAL-1",t,t);if(withProvider){return w.runtime.ensureRazorpayXPayoutRuntime(w.db).then(()=>{w.sqlite.prepare("INSERT INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,created_at,updated_at) VALUES ('RPX-LOCAL-1','commission','BK-RPX-1','PRV-RPX',?,'INR','fa_TEST123','idem-rpx-1','pout_TEST123','processing',?,?)").run(amount*100,t,t);});}return w.runtime.ensureRazorpayXPayoutRuntime(w.db);}
function seedRelease(w,amount=500){const t=Date.now();w.sqlite.prepare("INSERT INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,debit,credit,narration,period_code,posted,created_at) VALUES ('REL-1','2026-10-02','provider_payout_release','BK-RPX-1','2110-Provider Payable',?,0,'release','2026-10',1,?)").run(amount,t);w.sqlite.prepare("INSERT INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,debit,credit,narration,period_code,posted,created_at) VALUES ('REL-2','2026-10-02','provider_payout_release','BK-RPX-1','2115-Provider Payouts in Transit',0,?,'release','2026-10',1,?)").run(amount,t);}

test("fetch\u2192apply processed advances commission status and settles books",async()=>{
 const p=await provider("processed");try{const w=await world();await seedCommission(w);seedRelease(w);const env=baseEnv(p.url);
  const r=await w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,env,{payoutId:"RPX-LOCAL-1",actorId:"finance@qa.test"});
  assert.equal(r.connected,true);assert.equal(r.providerStatus,"processed");assert.equal(r.advanced,true);assert.equal(r.accounting.status,"principal_settled");assert.equal(r.liveMoney,false);
  assert.equal(w.sqlite.prepare("SELECT status FROM provider_order_payouts WHERE id='RPX-LOCAL-1'").get().status,"payout_processed_sandbox");
  assert.equal(w.sqlite.prepare("SELECT provider_status FROM razorpayx_payout_provider_state WHERE local_payout_id='RPX-LOCAL-1'").get().provider_status,"processed");
  assert.equal(w.sqlite.prepare("SELECT status FROM razorpayx_payout_accounting WHERE local_payout_id='RPX-LOCAL-1'").get().status,"principal_settled");
  assert.equal(p.calls.filter(c=>c.method==="GET").length,1);assert.equal(p.calls.filter(c=>c.method==="POST").length,0);
 }finally{await p.close();}
});

test("identity mismatch refuses without mutating payout status",async()=>{
 const p=await provider("processed",{amount:49999});try{const w=await world();await seedCommission(w);seedRelease(w);const env=baseEnv(p.url);
  await assert.rejects(()=>w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,env,{payoutId:"RPX-LOCAL-1"}),e=>e instanceof Response&&e.status===409);
  assert.equal(w.sqlite.prepare("SELECT status FROM provider_order_payouts WHERE id='RPX-LOCAL-1'").get().status,"provider_processing_sandbox");
  assert.equal(w.sqlite.prepare("SELECT provider_status FROM razorpayx_payout_provider_state").get().provider_status,"processing");
 }finally{await p.close();}
});

test("missing provider id refuses without creating a payout",async()=>{
 const p=await provider("processed");try{const w=await world();await seedCommission(w,{withProvider:false,status:"queued_sandbox"});const env=baseEnv(p.url);
  let err;try{await w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,env,{payoutId:"RPX-LOCAL-1"});}catch(e){err=e;}
  assert.ok(err instanceof Response);assert.equal(err.status,409);assert.match(await err.text(),/cannot create a payout/i);
  assert.equal(p.calls.length,0);assert.equal(w.sqlite.prepare("SELECT provider_reference FROM provider_order_payouts").get().provider_reference,null);
 }finally{await p.close();}
});

test("non-regressing status: queued fetch cannot undo processed",async()=>{
 const p=await provider("queued");try{const w=await world();await seedCommission(w,{status:"payout_processed_sandbox"});seedRelease(w);
  w.sqlite.prepare("UPDATE razorpayx_payout_provider_state SET provider_status='processed' WHERE local_payout_id='RPX-LOCAL-1'").run();
  const env=baseEnv(p.url);
  const r=await w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,env,{payoutId:"RPX-LOCAL-1"});
  assert.equal(r.providerStatus,"processed");assert.equal(r.advanced,false);
  assert.equal(w.sqlite.prepare("SELECT status FROM provider_order_payouts").get().status,"payout_processed_sandbox");
 }finally{await p.close();}
});

test("sandbox gate refuses live / unlocked configuration before provider fetch",async()=>{
 const p=await provider("processed");try{const w=await world();await seedCommission(w);
  await assert.rejects(()=>w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,{...baseEnv(p.url),PAWSPACE_PAYMENT_ENV:"live"},{payoutId:"RPX-LOCAL-1"}),e=>e instanceof Response&&(e.status===503||e.status===409));
  await assert.rejects(()=>w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,{...baseEnv(p.url),PAWSPACE_RAZORPAYX_LIVE_APPROVED:"true"},{payoutId:"RPX-LOCAL-1"}),e=>e instanceof Response&&(e.status===503||e.status===409));
  assert.equal(p.calls.length,0);
 }finally{await p.close();}
});

test("idempotent re-run keeps processed books settled without a second provider create",async()=>{
 const p=await provider("processed");try{const w=await world();await seedCommission(w);seedRelease(w);const env=baseEnv(p.url);
  const first=await w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,env,{payoutId:"RPX-LOCAL-1"});
  const second=await w.runtime.reconcileRazorpayXProviderStatusFromApi(w.db,env,{payoutId:"RPX-LOCAL-1"});
  assert.equal(first.accounting.status,"principal_settled");assert.equal(second.accounting.status,"principal_settled");assert.equal(second.advanced,false);
  assert.equal(p.calls.filter(c=>c.method==="GET").length,2);assert.equal(p.calls.filter(c=>c.method==="POST").length,0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries WHERE source_type='razorpayx_payout_settlement'").get().n,2);
 }finally{await p.close();}
});

test("books-only reconcile stays separate and never contacts RazorpayX",async()=>{
 const w=await world();await seedCommission(w,{status:"payout_processed_sandbox"});
 w.sqlite.prepare("UPDATE razorpayx_payout_provider_state SET provider_status='processed'").run();
 const env={...baseEnv("http://127.0.0.1:1")};
 const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error("books-only must not fetch");};
 try{const r=await w.runtime.reconcileRecordedRazorpayXPayout(w.db,env,"RPX-LOCAL-1");assert.equal(r.status,"release_review_required");}
 finally{globalThis.fetch=original;}
});

const source=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
test("source contract: Path B sync is wired beside books-only reconcile without webhook forge or payout create",()=>{
 const runtime=source("lib/razorpayx-payout-runtime.ts"),route=source("app/api/razorpayx-test-reconcile/route.ts");
 assert.match(runtime,/export async function reconcileRazorpayXProviderStatusFromApi/);
 assert.match(runtime,/fetchRazorpayXSandboxPayout/);
 assert.match(runtime,/cannot create a payout/);
 assert.match(runtime,/Same non-regressing ranks as processRazorpayXWebhook/);
 assert.match(runtime,/Provider payout id is not recorded; provider-status sync cannot create a payout/);
 assert.ok(!/reconcileRazorpayXProviderStatusFromApi[\s\S]*createRazorpayXSandboxPayout\(/.test(runtime.split("export async function reconcileRazorpayXProviderStatusFromApi")[1]||"missing"));
 assert.match(route,/sync_provider_status/);
 assert.match(route,/partner\.payout\.provider_status_sync/);
 assert.match(route,/liveMoney:false/);
 assert.match(route,/reconcileRecordedRazorpayXPayout/);
 assert.doesNotMatch(route,/verifyRazorpayRawBody|x-razorpay-signature/);
});
