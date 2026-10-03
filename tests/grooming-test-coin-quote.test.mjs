import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
// Resolver hooks before the quote helper: it reaches ../coupon-reapply-guard and the TEST coin
// policy through extension-less imports, which the CI strip-types mode cannot resolve alone.
installWorkersHooks('__GROOMING_TEST_COIN_QUOTE_DB__', '__GROOMING_TEST_COIN_QUOTE_ENV__');
const { groomingTestCoinQuote } = await import('../lib/v2/grooming-test-coin-quote.ts');
const { testCoinEstimate } = await import('../lib/v2/test-coin-estimate.ts');
const { testCoinPolicy } = await import('../lib/v2/test-coin-policy.ts');
const basket={basketTotal:1200.25,quoteReady:true,couponChecking:false,coupon:{discount:100.10,code:'CHECKED',quoteId:'server-quote'},paymentMode:'prepaid'};
test('Grooming post-offer eligible order amount and prepaid due reuse existing paise logic',()=>{
 assert.deepEqual(groomingTestCoinQuote(basket),{eligibleAmount:1100.15,actualPayable:1100.15});
 const p=testCoinEstimate({...groomingTestCoinQuote(basket),policy:testCoinPolicy({PAWSPACE_TEST_COINS:'on',FORBID_PRODUCTION:'true',APP_ENV:'test'}),spendableCoins:80,grantBalanceAdjustment:0,requestedCoins:80,currency:'INR',grants:[{source_kind:'booking',source_id:'prior',remaining:80,expires_at:2000}]},1000);
 assert.equal(p.estimatedCoins,110);assert.equal(p.simulatedDiscount,80);assert.equal(p.actualPayable,1100.15);assert.equal(p.earningConfigured,false);
});
test('Grooming pay-after-service keeps governed zero due; no coupon uses full checked basket',()=>{
 assert.deepEqual(groomingTestCoinQuote({...basket,paymentMode:'pay_after_service'}),{eligibleAmount:1100.15,actualPayable:0});
 assert.deepEqual(groomingTestCoinQuote({...basket,coupon:{code:'',quoteId:'',discount:0}}),{eligibleAmount:1200.25,actualPayable:1200.25});
});
test('missing/stale quote, unapproved coupon and invalid paise do not invent earnings',()=>{
 for(const input of [{quoteReady:false},{couponChecking:true},{basketTotal:null},{basketTotal:1.001},{coupon:{code:'CHECKED',quoteId:'',discount:0}},{coupon:{code:'',quoteId:'',discount:5}},{coupon:{code:'CHECKED',quoteId:'server-quote',discount:1300}}])assert.deepEqual(groomingTestCoinQuote({...basket,...input}),{eligibleAmount:null,actualPayable:null});
});
