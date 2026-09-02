import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAYMENT_PRODUCTION_HARDENING_DB__", "__PAYMENT_PRODUCTION_HARDENING_ENV__");
const {parsePaymentEnvironment,sandboxCapabilitiesUnlocked}=await import("../lib/payment-environment.ts");
const {createPaymentOrderPaise,paymentEnvironment}=await import("../lib/razorpay-client.ts");
const {paymentMode,resolvePaymentWebhookGate}=await import("../lib/payment-webhook-gate.ts");

function makeD1(sqlite){
 const statement=(sql,args=[])=>({
  bind:(...bound)=>statement(sql,bound),
  first:async()=>sqlite.prepare(sql).get(...args)??null,
  run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes||0)}};},
  all:async()=>({results:sqlite.prepare(sql).all(...args)}),
 });
 let depth=0;
 return{prepare:(sql)=>statement(sql),batch:async(items)=>{const outer=depth===0;if(outer)sqlite.exec("BEGIN IMMEDIATE");depth++;try{const out=[];for(const item of items)out.push(await item.run());if(outer)sqlite.exec("COMMIT");return out;}catch(error){if(outer)sqlite.exec("ROLLBACK");throw error;}finally{depth--;}}};
}

function installFinanceSchema(sqlite){sqlite.exec(`
CREATE TABLE payment_intents (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,payment_id TEXT NOT NULL,provider TEXT NOT NULL,environment TEXT NOT NULL,idempotency_key TEXT NOT NULL,amount_paise INTEGER NOT NULL,currency TEXT NOT NULL,state TEXT NOT NULL,order_request_state TEXT NOT NULL,gateway_order_id TEXT,gross_service_value_paise INTEGER NOT NULL DEFAULT 0,platform_fee_paise INTEGER NOT NULL DEFAULT 0,partner_earning_paise INTEGER NOT NULL DEFAULT 0,tds_paise INTEGER NOT NULL DEFAULT 0,gst_paise INTEGER NOT NULL DEFAULT 0,commission_rate_bps INTEGER NOT NULL DEFAULT 0,commission_rate_version TEXT,tax_rule_version TEXT,commercial_snapshot_json TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(customer_id,booking_id,idempotency_key));
CREATE TABLE financial_outbox (id TEXT PRIMARY KEY,aggregate_type TEXT NOT NULL,aggregate_id TEXT NOT NULL,event_type TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,request_json TEXT,response_json TEXT,last_error TEXT,lease_owner TEXT,lease_expires_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE gateway_object_identities (provider TEXT NOT NULL,object_type TEXT NOT NULL,external_id TEXT NOT NULL,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(provider,object_type,external_id));
`);}

async function loadFinancialModules(){
 const financial=await import("../lib/financial-lifecycle.ts");
 const worker=await import("../lib/razorpay-order-outbox-worker.ts");
 return{financial,worker};
}

test("payment environment parser preserves the safe unset rollback but rejects every non-supported declaration",()=>{
 assert.equal(parsePaymentEnvironment({}),"sandbox");
 assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:" sandbox "}),"sandbox");
 assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:"LIVE"}),"live");
 for(const value of ["production","uat","test","livee","sandboxed"]){assert.throws(()=>parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:value}),/must be "sandbox" or "live"/);}
 assert.equal(paymentEnvironment({}),"sandbox");
 assert.equal(paymentMode({}),"sandbox");
 assert.equal(sandboxCapabilitiesUnlocked({}),false);
 assert.equal(sandboxCapabilitiesUnlocked({PAWSPACE_PAYMENT_ENV:" SANDBOX "}),true);
});

test("malformed payment environment fails the webhook gate closed",()=>{
 const gate=resolvePaymentWebhookGate({PAWSPACE_PAYMENT_ENV:"production",RAZORPAY_WEBHOOK_SECRET_LIVE:"secret",PAWSPACE_PAYMENT_LIVE_APPROVED:"true"});
 assert.equal(gate.ok,false);assert.equal(gate.status,503);assert.match(gate.reason,/sandbox.*live/);
});

test("live Razorpay order creation requires the exact approval literal before any network request",async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({id:"order_live_ok"}),{status:200,headers:{"content-type":"application/json"}});};
 try{
  const base={PAWSPACE_PAYMENT_ENV:"live",RAZORPAY_KEY_ID:"rzp_live_test",RAZORPAY_KEY_SECRET:"secret"};
  for(const approval of [undefined,"TRUE"," true ",true,1]){calls=0;const result=await createPaymentOrderPaise({...base,PAWSPACE_PAYMENT_LIVE_APPROVED:approval},{bookingId:"BK-1",paymentId:"PAY-1",amountPaise:10000,currency:"INR"});assert.equal(result.connected,false);assert.equal(calls,0);assert.match(result.reason,/PAWSPACE_PAYMENT_LIVE_APPROVED/);}
  calls=0;const accepted=await createPaymentOrderPaise({...base,PAWSPACE_PAYMENT_LIVE_APPROVED:"true"},{bookingId:"BK-1",paymentId:"PAY-1",amountPaise:10000,currency:"INR"});assert.equal(accepted.connected,true);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});

test("scheduled financial outbox sweep drains a due order exactly once through the existing atomic claim",async()=>{
 const sqlite=new DatabaseSync(":memory:");installFinanceSchema(sqlite);const db=makeD1(sqlite);const {financial,worker}=await loadFinancialModules();
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({id:"order_scheduled_1"}),{status:200,headers:{"content-type":"application/json"}});};
 try{
  await financial.claimPaymentIntent(db,{bookingId:"BK-SWEEP",customerId:"CUS-SWEEP",paymentId:"PAY-SWEEP",idempotencyKey:"idem-sweep",amountPaise:50000,currency:"INR",environment:"sandbox"});
  const first=await worker.runRazorpayOrderOutboxSweep(db,{PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_worker",RAZORPAY_KEY_SECRET_SANDBOX:"secret"},{asOf:Date.now(),limit:10});
  assert.equal(first.succeeded,1,JSON.stringify(first));assert.equal(calls,1);
  assert.equal(sqlite.prepare("SELECT status FROM financial_outbox").get().status,"SUCCEEDED");
  assert.equal(sqlite.prepare("SELECT gateway_order_id FROM payment_intents").get().gateway_order_id,"order_scheduled_1");
  const second=await worker.runRazorpayOrderOutboxSweep(db,{PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_worker",RAZORPAY_KEY_SECRET_SANDBOX:"secret"},{asOf:Date.now(),limit:10});
  assert.equal(second.succeeded,0);assert.equal(calls,1,"a completed outbox item is not dispatched twice");
 }finally{globalThis.fetch=original;sqlite.close();}
});

test("scheduled financial sweep converts an expired processing lease to reconciliation-required without recontacting Razorpay",async()=>{
 const sqlite=new DatabaseSync(":memory:");installFinanceSchema(sqlite);const db=makeD1(sqlite);const {financial,worker}=await loadFinancialModules();
 await financial.claimPaymentIntent(db,{bookingId:"BK-STALE",customerId:"CUS-STALE",paymentId:"PAY-STALE",idempotencyKey:"idem-stale",amountPaise:10000,currency:"INR",environment:"sandbox"});
 sqlite.prepare("UPDATE financial_outbox SET status='PROCESSING',lease_owner='dead-worker',lease_expires_at=?").run(Date.now()-1000);
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("must not fetch");};
 try{const result=await worker.runRazorpayOrderOutboxSweep(db,{PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_worker",RAZORPAY_KEY_SECRET_SANDBOX:"secret"},{asOf:Date.now(),limit:10});assert.equal(result.reconciliationRequired,1,JSON.stringify(result));assert.equal(calls,0);assert.equal(sqlite.prepare("SELECT status FROM financial_outbox").get().status,"RECONCILIATION_REQUIRED");}finally{globalThis.fetch=original;sqlite.close();}
});
