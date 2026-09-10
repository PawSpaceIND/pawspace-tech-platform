import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
installWorkersHooks('__BETA_LOCK_DB__');
const {parsePaymentEnvironment} = await import('../lib/payment-environment.ts');
const {createRazorpaySubscription} = await import('../lib/razorpay-subscriptions.ts');
const {verifyRazorpayPlan} = await import('../lib/razorpay-plan-verification.ts');
const {resolvePaymentWebhookGate} = await import('../lib/payment-webhook-gate.ts');
const {createPaymentOrderPaise} = await import('../lib/razorpay-client.ts');
const credentials = {RAZORPAY_KEY_ID:'rzp_live_fake',RAZORPAY_KEY_SECRET:'fake',RAZORPAY_KEY_ID_SANDBOX:'rzp_test_fake',RAZORPAY_KEY_SECRET_SANDBOX:'fake',RAZORPAY_WEBHOOK_SECRET_LIVE:'fake',PAWSPACE_PAYMENT_PILOT_BOOKING_IDS:'B1,B2,B3,B4,B5'};
const subscription = {planId:'plan_test',totalCount:1,billingSubscriptionId:'S',customerId:'C',sourceBookingId:'B1'};
test('beta lock rejects every live/invalid environment and approval combination without a network call', async () => {
 const original = globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('network must not be reached');};
 try {
  for(const mode of ['live','LIVE','production',' sandbox','sandbox ',undefined,null,'']) for(const approval of ['true','TRUE',true,'false',false,undefined]) {
   const env={...credentials,PAWSPACE_PAYMENT_ENV:mode,PAWSPACE_PAYMENT_LIVE_APPROVED:approval,FORBID_PRODUCTION:'true'};
   assert.throws(()=>parsePaymentEnvironment(env));
   assert.equal(resolvePaymentWebhookGate(env).ok,false);
   assert.equal((await createPaymentOrderPaise(env,{bookingId:'B1',paymentId:'P',amountPaise:100,currency:'INR'})).connected,false);
   await assert.rejects(createRazorpaySubscription(env,subscription));
   await assert.rejects(verifyRazorpayPlan(env,{providerPlanId:'plan_test',amountPaise:100,currency:'INR',period:'monthly',interval:1}));
  }
  assert.equal(calls,0);
 } finally {globalThis.fetch=original;}
});
test('subscription live approval requires exactly the string true',async()=>{
 for(const approval of ['TRUE',true,' true ',false,undefined]) {
  const env={...credentials,PAWSPACE_PAYMENT_ENV:'live',PAWSPACE_PAYMENT_LIVE_APPROVED:approval};
  await assert.rejects(createRazorpaySubscription(env,subscription),/not approved/);
 }
});
test('explicit sandbox remains usable with the beta lock',()=>{
 assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:'sandbox',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'}),'sandbox');
 assert.equal(resolvePaymentWebhookGate({PAWSPACE_PAYMENT_ENV:'sandbox',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',RAZORPAY_WEBHOOK_SECRET_SANDBOX:'test-only'}).environment,'sandbox');
});

test('a live key accidentally stored in the sandbox binding cannot reach the provider',async()=>{
 const env={...credentials,PAWSPACE_PAYMENT_ENV:'sandbox',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',RAZORPAY_KEY_ID_SANDBOX:'rzp_live_misbound'};
 assert.throws(()=>parsePaymentEnvironment(env),/forbidden in sandbox/);
 assert.equal((await createPaymentOrderPaise(env,{bookingId:'B1',paymentId:'P',amountPaise:100,currency:'INR'})).connected,false);
 await assert.rejects(createRazorpaySubscription(env,subscription),/forbidden in sandbox/);
 await assert.rejects(verifyRazorpayPlan(env,{providerPlanId:'plan_test',amountPaise:100,currency:'INR',period:'monthly',interval:1}),/forbidden in sandbox/);
});
