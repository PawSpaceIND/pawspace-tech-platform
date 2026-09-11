import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const relay=await import("../lib/razorpay-sandbox-webhook-relay.ts");
const SHA="a".repeat(40);
const ORIGIN="https://pawspace-checkout-736-34495251052-1.karthik-fce.workers.dev";
const base=()=>({PAWSPACE_DEPLOYMENT_ENV:"staging",PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_ORIGIN:ORIGIN,PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_SHA:SHA});

test("Razorpay sandbox relay is disabled by default",()=>assert.deepEqual(relay.resolveRazorpaySandboxRelay({PAWSPACE_DEPLOYMENT_ENV:"staging",PAWSPACE_PAYMENT_ENV:"sandbox"}),{enabled:false}));

test("Razorpay sandbox relay requires a paired exact target and locked staging mode",()=>{
 assert.throws(()=>relay.resolveRazorpaySandboxRelay({...base(),PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_SHA:""}),/configured together/);
 assert.throws(()=>relay.resolveRazorpaySandboxRelay({...base(),PAWSPACE_DEPLOYMENT_ENV:"production"}),/sandbox-locked staging/);
 assert.throws(()=>relay.resolveRazorpaySandboxRelay({...base(),PAWSPACE_PAYMENT_ENV:"live"}),/sandbox-locked staging/);
 assert.throws(()=>relay.resolveRazorpaySandboxRelay({...base(),PAWSPACE_PAYMENT_LIVE_APPROVED:"true"}),/sandbox-locked staging/);
 assert.throws(()=>relay.resolveRazorpaySandboxRelay({...base(),PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_SHA:"A".repeat(40)}),/exact lowercase/);
});

test("Razorpay sandbox relay refuses arbitrary, protected and decorated origins",()=>{
 for(const origin of ["https://pawspace-staging.karthik-fce.workers.dev","https://example.com","http://pawspace-checkout-736-34495251052-1.karthik-fce.workers.dev",`${ORIGIN}/api/razorpay-webhook`,`${ORIGIN}?x=1`,`https://user@example.com`])assert.throws(()=>relay.resolveRazorpaySandboxRelay({...base(),PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_ORIGIN:origin}),/exact isolated certified-checkout|invalid/);
});

test("verified sandbox relay preserves raw bytes and Razorpay identity headers without following redirects",async()=>{
 let seen;
 const raw='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_TEST"}}}}';
 const service={fetch:async(url,init)=>{seen={url:String(url),init};return new Response("ok",{status:200})}};
 const result=await relay.forwardVerifiedRazorpaySandboxWebhook({...base(),PAWSPACE_RAZORPAY_SANDBOX_RELAY_SERVICE:service},{rawBody:raw,signature:"abc123",eventId:"evt_test",contentType:"application/json; charset=utf-8"});
 assert.equal(result.enabled,true);assert.equal(result.delivered,true);assert.equal(result.status,200);assert.equal(result.targetSha,SHA);
 assert.equal(seen.url,`${ORIGIN}/api/razorpay-webhook`);assert.equal(seen.init.method,"POST");assert.equal(seen.init.body,raw);assert.equal(seen.init.redirect,"manual");
 const headers=new Headers(seen.init.headers);assert.equal(headers.get("x-razorpay-signature"),"abc123");assert.equal(headers.get("x-razorpay-event-id"),"evt_test");assert.equal(headers.get("x-pawspace-relay-candidate-sha"),SHA);assert.equal(headers.get("content-type"),"application/json; charset=utf-8");
});

test("configured relay refuses same-zone global fetch when its exact service binding is absent",async()=>{
 const result=await relay.forwardVerifiedRazorpaySandboxWebhook(base(),{rawBody:"{}",signature:"sig",eventId:"evt"});
 assert.deepEqual(result,{enabled:true,delivered:false,status:0,targetSha:SHA,reason:"relay_service_binding_missing"});
});

test("relay transport failure is observable but fail-open to the stable staging receiver",async()=>{
 const rejected=await relay.forwardVerifiedRazorpaySandboxWebhook(base(),{rawBody:"{}",signature:"sig",eventId:"evt",fetchImpl:async()=>new Response("no",{status:503})});
 assert.deepEqual(rejected,{enabled:true,delivered:false,status:503,targetSha:SHA});
 const failed=await relay.forwardVerifiedRazorpaySandboxWebhook(base(),{rawBody:"{}",signature:"sig",eventId:"evt",fetchImpl:async()=>{throw new TypeError("network down")}});
 assert.equal(failed.enabled,true);assert.equal(failed.delivered,false);assert.equal(failed.status,0);assert.equal(failed.targetSha,SHA);assert.equal(failed.reason,"TypeError");
});

test("webhook route shadow-relays only after Razorpay HMAC acceptance and before domain processing",()=>{
 const source=readFileSync(new URL("../app/api/razorpay-webhook/route.ts",import.meta.url),"utf8");
 const accepted=source.indexOf("accepted=await acceptRazorpayWebhook"),forward=source.indexOf("await forwardVerifiedRazorpaySandboxWebhook"),claim=source.indexOf("await claimInbox");
 assert.ok(accepted>=0&&forward>accepted&&claim>forward);assert.match(source,/if\(gate\.environment==="sandbox"\)/);assert.match(source,/rawBody:raw,signature,eventId/);
});

test("staging deploy validates exact relay target provenance and serializes relay vars only when supplied",()=>{
 const stage=readFileSync(new URL("../scripts/stage-config.mjs",import.meta.url),"utf8"),verify=readFileSync(new URL("../scripts/verify-razorpay-sandbox-relay-target.mjs",import.meta.url),"utf8"),workflow=readFileSync(new URL("../.github/workflows/deploy-staging.yml",import.meta.url),"utf8");
 for(const token of ["PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_ORIGIN","PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_SHA","PAWSPACE_RAZORPAY_SANDBOX_RELAY_SERVICE"])assert.match(stage,new RegExp(token));
 assert.match(stage,/pawspace-checkout-736-/);assert.doesNotMatch(stage,/pawspace-checkout-674-/);
 assert.match(verify,/PAWSPACE_DEPLOYMENT_ENV:"checkout-sandbox"/);assert.match(verify,/PAWSPACE_RELEASE_SHA:sha/);assert.match(verify,/RAZORPAY_WEBHOOK_SECRET_SANDBOX/);assert.match(verify,/workers\/message/);assert.match(verify,/pulls\/736/);assert.match(verify,/body\.merged!==true/);
 assert.match(workflow,/razorpay_relay_target_origin:/);assert.match(workflow,/razorpay_relay_target_sha:/);assert.match(workflow,/Verify optional Razorpay sandbox relay target/);assert.match(workflow,/verify-razorpay-sandbox-relay-target\.mjs/);
 assert.doesNotMatch(workflow,/pawspace-checkout-736-[0-9]+-[0-9]+\.karthik-fce\.workers\.dev/,'normal staging must not default to an ephemeral proof Worker');assert.doesNotMatch(workflow,/razorpay_relay_target_origin \|\|/,'relay origin must be explicit, never a hidden fallback');assert.doesNotMatch(workflow,/razorpay_relay_target_sha \|\|/,'relay SHA must be explicit, never a hidden fallback');
});
