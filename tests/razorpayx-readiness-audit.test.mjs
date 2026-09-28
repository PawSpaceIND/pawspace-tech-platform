import test from "node:test";
import assert from "node:assert/strict";
import {createHmac,createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {employeeAuditD1} from "./helpers/employee-audit-d1.mjs";
installWorkersHooks("__RPX_READINESS_AUDIT_DB__", "__RPX_READINESS_AUDIT_ENV__");
const runtime=await import("../lib/razorpayx-payout-runtime.ts");
const salary=await import("../lib/employee-payroll-payout.ts");
const env={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_RAZORPAYX_ENV:"sandbox",PAWSPACE_RAZORPAYX_LIVE_APPROVED:"false",RAZORPAYX_KEY_ID_SANDBOX:"rzp_test_OFFLINE",RAZORPAYX_KEY_SECRET_SANDBOX:"offline-only",RAZORPAYX_ACCOUNT_NUMBER_SANDBOX:"offline-account",RAZORPAYX_WEBHOOK_SECRET_SANDBOX:"offline-webhook"};
async function world(t){
 const w=employeeAuditD1(t); w.db.exec=async sql=>{w.sqlite.exec(sql);return{count:0,duration:0};}; await runtime.ensureRazorpayXPayoutRuntime(w.db);
 const snapshot=JSON.stringify({providerId:"PROVIDER-AUDIT",verificationStatus:"verified",razorpayxContactId:"cont_AUDIT",razorpayxFundAccountId:"fa_AUDIT",verifiedForPayoutAt:1});
 w.sqlite.prepare("INSERT INTO payout_beneficiary_preauthorizations (scope_type,scope_id,provider_id,snapshot_json,snapshot_sha256,razorpayx_contact_id,razorpayx_fund_account_id,verified_at,expires_at) VALUES ('booking','BOOK-AUDIT','PROVIDER-AUDIT',?,?,'cont_AUDIT','fa_AUDIT',1,900001)").run(snapshot,createHash("sha256").update(snapshot).digest("hex"));
 w.sqlite.exec(`INSERT INTO provider_order_payouts (id,booking_id,provider_id,amount,currency,rail,environment,status,due_at,razorpayx_contact_id,razorpayx_fund_account_id,idempotency_key,created_by,created_at,updated_at) VALUES ('RPX-AUDIT','BOOK-AUDIT','PROVIDER-AUDIT',500,'INR','razorpayx','sandbox','provider_processing_sandbox',1,'cont_AUDIT','fa_AUDIT','audit-key','offline-finance',1,1);
 INSERT INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,created_at,updated_at) VALUES ('RPX-AUDIT','commission','BOOK-AUDIT','PROVIDER-AUDIT',50000,'INR','fa_AUDIT','audit-key','pout_AUDIT','processing',1,1);`);
 t.mock.method(globalThis,"fetch",()=>{throw new Error("OFFLINE AUDIT: external requests forbidden");});
 return w;
}
function event(changes={},eventId="audit-event"){
 const payout={id:"pout_AUDIT",amount:50000,currency:"INR",fund_account_id:"fa_AUDIT",reference_id:"RPX-AUDIT",status:"processed",...changes};
 const rawBody=JSON.stringify({event:"payout.processed",payload:{payout:{entity:payout}}});
 return{rawBody,eventId,signature:createHmac("sha256",env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX).update(rawBody).digest("hex")};
}
const status=w=>w.sqlite.prepare("SELECT status FROM provider_order_payouts WHERE id='RPX-AUDIT'").get().status;
const remoteStatus=w=>w.sqlite.prepare("SELECT provider_status FROM razorpayx_payout_provider_state WHERE local_payout_id='RPX-AUDIT'").get().provider_status;
for(const change of [{fund_account_id:"fa_OTHER"},{reference_id:"RPX-OTHER"},{status:"queued"}])test(`RX-AUDIT rejects a signed but mismatched payout: ${JSON.stringify(change)}`,async t=>{
 const w=await world(t);
 await assert.rejects(()=>runtime.processRazorpayXWebhook(w.db,env,event(change)));
 assert.equal(status(w),"provider_processing_sandbox"); assert.equal(remoteStatus(w),"processing");
});
test("RX-AUDIT a TEST webhook never settles a live local record",async t=>{
 const w=await world(t);w.sqlite.exec("UPDATE provider_order_payouts SET environment='live'");
 await assert.rejects(()=>runtime.processRazorpayXWebhook(w.db,env,event()));
 assert.equal(status(w),"provider_processing_sandbox");
});
test("RX-AUDIT an interrupted RECEIVED event resumes instead of being acknowledged as done",async t=>{
 const w=await world(t),input=event();
 w.sqlite.prepare("INSERT INTO razorpayx_webhook_events (event_id,event_type,provider_payout_id,payload_sha256,processing_status,received_at) VALUES (?,'payout.processed','pout_AUDIT',?,'RECEIVED',1)").run(input.eventId,createHash("sha256").update(input.rawBody).digest("hex"));
 const result=await runtime.processRazorpayXWebhook(w.db,env,input);
 assert.equal(result.providerStatus,"processed"); assert.equal(status(w),"payout_processed_sandbox");
 assert.equal(w.sqlite.prepare("SELECT processing_status FROM razorpayx_webhook_events").get().processing_status,"PROCESSED");
});
test("RX-AUDIT interrupted finance effects roll back and the original signed event is retryable",async t=>{
 const w=await world(t),input=event();
 w.sqlite.exec("CREATE TRIGGER audit_failure BEFORE UPDATE ON provider_order_payouts BEGIN SELECT RAISE(ABORT,'offline injected finance failure'); END");
 await assert.rejects(()=>runtime.processRazorpayXWebhook(w.db,env,input),/offline injected finance failure/);
 assert.equal(remoteStatus(w),"processing","provider and finance state must commit together");
 w.sqlite.exec("DROP TRIGGER audit_failure");await runtime.processRazorpayXWebhook(w.db,env,input);
 assert.equal(status(w),"payout_processed_sandbox");
});
test("RX-AUDIT salary auto-dispatch is connected to the worker but remains opt-in",async()=>{
 const source=readFileSync(new URL("../worker/index.ts",import.meta.url),"utf8");
 assert.ok(/import\s*\{\s*runEmployeeSalarySandboxSweep\s*\}\s*from\s*["']\.\.\/lib\/employee-payroll-payout["']/.test(source),"worker must import existing opt-in salary sweep");
 assert.match(source,/runEmployeeSalarySandboxSweep\(env\.DB,\s*env/);
 const disabled=await salary.runEmployeeSalarySandboxSweep({prepare(){assert.fail("disabled sweep touched data");}},{});
 assert.equal(disabled.enabled,false);assert.equal(disabled.liveSalaryEnabled,false);
});
test("RX-AUDIT concurrent identical signed receipts commit one result",async t=>{
 const w=await world(t),input=event();
 const results=await Promise.all(Array.from({length:8},()=>runtime.processRazorpayXWebhook(w.db,env,input)));
 assert.equal(results.filter(r=>r.duplicatePrevented===false).length,1);
 assert.equal(status(w),"payout_processed_sandbox");
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM razorpayx_webhook_events WHERE processing_status='PROCESSED'").get().n,1);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM razorpayx_receipt_assertions").get().n,0);
});
function lifecycle(name,id){const input=event({},id),body=JSON.parse(input.rawBody);body.event=name;body.payload.payout.entity.status=name==="payout.initiated"?"processing":name.slice(7);const rawBody=JSON.stringify(body);return{...input,rawBody,signature:createHmac("sha256",env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX).update(rawBody).digest("hex")};}
test("RX-AUDIT concurrent out-of-order receipts cannot undo processed or reversed state",async t=>{
 const w=await world(t);
 await Promise.all([lifecycle("payout.processed","processed"),lifecycle("payout.queued","queued")].map(e=>runtime.processRazorpayXWebhook(w.db,env,e)));
 assert.equal(status(w),"payout_processed_sandbox");
 await Promise.all([lifecycle("payout.reversed","reversed"),lifecycle("payout.initiated","late")].map(e=>runtime.processRazorpayXWebhook(w.db,env,e)));
 assert.equal(status(w),"payout_reversed_sandbox");assert.equal(remoteStatus(w),"reversed");
});
test("RX-AUDIT source environment is rechecked inside the receipt transaction",async t=>{
 const w=await world(t),batch=w.db.batch;let flipped=false;
 w.db.batch=async statements=>{if(!flipped&&statements.some(s=>s.sql.includes("INSERT INTO razorpayx_receipt_assertions"))){flipped=true;w.sqlite.exec("UPDATE provider_order_payouts SET environment='live'");}return batch(statements);};
 await assert.rejects(()=>runtime.processRazorpayXWebhook(w.db,env,event()),e=>e instanceof Response&&e.status===409);
 assert.equal(flipped,true);assert.equal(status(w),"provider_processing_sandbox");assert.equal(remoteStatus(w),"processing");
});
test("RX-AUDIT changed content cannot reuse an already processed event ID",async t=>{
 const w=await world(t);await runtime.processRazorpayXWebhook(w.db,env,event());
 await assert.rejects(()=>runtime.processRazorpayXWebhook(w.db,env,event({utr:"DIFFERENT"})),e=>e instanceof Response&&e.status===409);
 assert.equal(status(w),"payout_processed_sandbox");
});
test("RX-AUDIT callback before create-response persistence binds only the existing approved source",async t=>{
 const w=await world(t);w.sqlite.exec("DELETE FROM razorpayx_payout_provider_state; UPDATE provider_order_payouts SET status='provider_dispatching_sandbox'");
 const result=await runtime.processRazorpayXWebhook(w.db,env,event());
 assert.equal(result.matched,true);assert.equal(status(w),"payout_processed_sandbox");
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_order_payouts").get().n,1);
});
test("RX-AUDIT source-reference fallback cannot bind a live payout",async t=>{
 const w=await world(t);w.sqlite.exec("DELETE FROM razorpayx_payout_provider_state; UPDATE provider_order_payouts SET environment='live'");
 await assert.rejects(()=>runtime.processRazorpayXWebhook(w.db,env,event()),e=>e instanceof Response&&e.status===409);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM razorpayx_payout_provider_state").get().n,0);
});
test("RX-AUDIT unmatched receipt is retried when its canonical source arrives",async t=>{
 const w=await world(t);w.sqlite.exec("DELETE FROM razorpayx_payout_provider_state; ALTER TABLE provider_order_payouts RENAME TO audit_saved_payouts");
 const first=await runtime.processRazorpayXWebhook(w.db,env,event());assert.equal(first.matched,false);
 const columns=w.sqlite.prepare("PRAGMA table_info(provider_order_payouts)").all().map(r=>r.name).join(',');
 w.sqlite.exec(`INSERT INTO provider_order_payouts (${columns}) SELECT ${columns} FROM audit_saved_payouts`);
 const result=await runtime.processRazorpayXWebhook(w.db,env,event());
 assert.equal(result.providerStatus,"processed");assert.equal(status(w),"payout_processed_sandbox");
});
for(const changes of [{id:"pout_WRONG"},{amount:49999},{amount:"50000"},{currency:"USD"},{fund_account_id:undefined}])test(`RX-AUDIT receipt identity refuses ${JSON.stringify(changes)}`,async t=>{
 const w=await world(t);await assert.rejects(()=>runtime.processRazorpayXWebhook(w.db,env,event(changes)),e=>e instanceof Response&&e.status===409);
 assert.equal(status(w),"provider_processing_sandbox");
});
for(const responseFails of [false,true])test(`RX-AUDIT a late creation response cannot overwrite a completed webhook (${responseFails?'lost response':'processing response'})`,async t=>{
 const w=await world(t);w.sqlite.exec("DELETE FROM razorpayx_payout_provider_state; UPDATE provider_order_payouts SET status='queued_sandbox'");
 let calls=0;
 t.mock.method(globalThis,"fetch",async()=>{
  calls++;await runtime.processRazorpayXWebhook(w.db,env,event());
  if(responseFails)throw new Error("offline injected lost response");
  return Response.json({...JSON.parse(event().rawBody).payload.payout.entity,status:"processing"});
 });
 const sent=await runtime.dispatchRazorpayXSandboxPayout(w.db,env,{payoutId:"RPX-AUDIT"});
 assert.equal(calls,1);assert.equal(status(w),"payout_processed_sandbox");assert.equal(remoteStatus(w),"processed");
 assert.equal(sent.connected,true);assert.equal(sent.providerStatus,"processed");
});

for(const brokenBooks of [false,true])test(`RX-REVIEW accepted payout reports accounting review without resending (${brokenBooks?'read failure':'missing release'})`,async t=>{
 const w=await world(t);w.sqlite.exec("DELETE FROM razorpayx_payout_provider_state; UPDATE provider_order_payouts SET status='queued_sandbox'");
 let calls=0;const errors=[];t.mock.method(console,"error",(...args)=>errors.push(args));
 t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json(JSON.parse(event().rawBody).payload.payout.entity);});
 const prepare=w.db.prepare.bind(w.db);
 if(brokenBooks)t.mock.method(w.db,"prepare",sql=>{if(sql.startsWith("SELECT * FROM razorpayx_payout_accounting"))throw new Error("private-accounting-diagnostic-fa_SECRET");return prepare(sql);});
 const first=await runtime.dispatchRazorpayXSandboxPayout(w.db,env,{payoutId:"RPX-AUDIT"});
 assert.equal(first.connected,true,"accepted transfer must not be reported as a failed send");
 assert.equal(first.reconciliationRequired,true,"accounting failure must be explicit to API and Finance");
 assert.match(first.accounting.status,/review_required|reconciliation_required/);
 assert.equal(status(w),"payout_processed_sandbox");assert.equal(first.providerPayoutId,"pout_AUDIT");
 const again=await runtime.dispatchRazorpayXSandboxPayout(w.db,env,{payoutId:"RPX-AUDIT"});
 assert.equal(again.duplicatePrevented,true);assert.equal(again.reconciliationRequired,true);assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify({first,again,errors}),/private-accounting-diagnostic|fa_SECRET/);
 if(brokenBooks)assert.ok(errors.length>0,"accounting error must surface as a sanitized operational diagnostic");
});
