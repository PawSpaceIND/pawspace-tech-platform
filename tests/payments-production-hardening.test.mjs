import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import path from"node:path";
import{parsePaymentEnvironment,PaymentEnvironmentConfigurationError,sandboxCapabilitiesUnlocked}from"../lib/payment-environment.ts";

const root=process.cwd();const read=(file)=>fs.readFileSync(path.join(root,file),"utf8");

test("payment environment parser accepts only exact sandbox or live declarations",()=>{
 assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:"sandbox"}),"sandbox");
 assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:"live"}),"live");
 for(const value of[undefined,"","Sandbox"," SANDBOX ","production","uat","lvie"]){assert.throws(()=>parsePaymentEnvironment(value===undefined?{}:{PAWSPACE_PAYMENT_ENV:value}),PaymentEnvironmentConfigurationError);}
 assert.equal(sandboxCapabilitiesUnlocked({PAWSPACE_PAYMENT_ENV:"sandbox"}),true);
 assert.equal(sandboxCapabilitiesUnlocked({PAWSPACE_PAYMENT_ENV:" SANDBOX "}),false);
 assert.equal(sandboxCapabilitiesUnlocked({}),false);
});

test("webhook gate uses the canonical strict parser and fails closed before selecting a secret",()=>{
 const gate=read("lib/payment-webhook-gate.ts");
 assert.match(gate,/import\{parsePaymentEnvironment,type PaymentEnvironment\}from"\.\/payment-environment"/);
 assert.match(gate,/try\{mode=parsePaymentEnvironment\(env\);\}catch\(error\)\{return\{ok:false,status:503/);
 assert.match(gate,/env\?\.PAWSPACE_PAYMENT_LIVE_APPROVED === "true"/);
 assert.doesNotMatch(gate,/toLowerCase\(\) === "live" \? "live" : "sandbox"/);
});

test("all Razorpay provider adapters use the canonical parser and live orders are gated before /v1/orders",()=>{
 const client=read("lib/razorpay-client.ts"),sandbox=read("lib/razorpay-sandbox-client.ts"),fn=client.slice(client.indexOf("export async function createPaymentOrderPaise"),client.indexOf("/** Compatibility boundary"));
 assert.match(client,/return parsePaymentEnvironment\(env\)/);
 assert.doesNotMatch(client,/function providerPaymentEnvironment/);
 assert.match(sandbox,/parsePaymentEnvironment\(env\)!=="sandbox"/);
 assert.match(fn,/environment === "live" && env\?\.PAWSPACE_PAYMENT_LIVE_APPROVED !== "true"/);
 const gate=fn.indexOf("PAWSPACE_PAYMENT_LIVE_APPROVED"),request=fn.indexOf('providerRequest(env, environment, "/v1/orders"');
 assert.ok(gate>=0&&request>gate,"live approval must be checked before providerRequest reaches /v1/orders");
});

test("scheduled worker drains due financial order outbox through the canonical executor",()=>{
 const sweep=read("lib/razorpay-order-outbox-sweep.ts"),worker=read("worker/index.ts");
 assert.match(sweep,/executeRazorpayOrderOutbox/);
 assert.match(sweep,/event_type='CREATE_RAZORPAY_ORDER'/);
 assert.match(sweep,/status IN \('PENDING','RETRY'\)/);
 assert.match(sweep,/parsePaymentEnvironment\(env\)/);
 assert.match(worker,/runRazorpayOrderOutboxSweep/);
 assert.match(worker,/razorpayOrderOutbox/);
});
