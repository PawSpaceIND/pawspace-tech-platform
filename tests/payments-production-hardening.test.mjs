import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import path from"node:path";
import{parsePaymentEnvironment,PaymentEnvironmentConfigurationError}from"../lib/payment-environment.ts";
import{resolvePaymentWebhookGate}from"../lib/payment-webhook-gate.ts";

const root=process.cwd();const read=(file)=>fs.readFileSync(path.join(root,file),"utf8");

test("payment environment parser accepts only exact sandbox or live declarations",()=>{
 assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:"sandbox"}),"sandbox");
 assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:"live"}),"live");
 for(const value of[undefined,"","Sandbox"," SANDBOX ","production","uat","lvie"]){assert.throws(()=>parsePaymentEnvironment(value===undefined?{}:{PAWSPACE_PAYMENT_ENV:value}),PaymentEnvironmentConfigurationError);}
});

test("webhook gate fails closed when the payment environment is absent or malformed",()=>{
 for(const env of[{}, {PAWSPACE_PAYMENT_ENV:"lvie",RAZORPAY_WEBHOOK_SECRET_SANDBOX:"should-not-unlock"}]){const gate=resolvePaymentWebhookGate(env);assert.equal(gate.ok,false);assert.equal(gate.status,503);assert.match(gate.reason,/PAWSPACE_PAYMENT_ENV must be exactly/);}
 assert.equal(resolvePaymentWebhookGate({PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_WEBHOOK_SECRET_SANDBOX:"sandbox-secret"}).ok,true);
});

test("live Razorpay order creation is gated before the outbound /v1/orders request",()=>{
 const source=read("lib/razorpay-client.ts"),fn=source.slice(source.indexOf("export async function createPaymentOrderPaise"),source.indexOf("/** Compatibility boundary"));
 assert.match(fn,/providerPaymentEnvironment\(env\)/);
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
