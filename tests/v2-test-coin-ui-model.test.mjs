import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
// Resolver hooks before the TEST coin modules: they import extension-less siblings, which plain
// strip-types (the CI mode for tests/*.test.mjs) cannot resolve on its own.
installWorkersHooks('__TEST_COIN_UI_MODEL_DB__', '__TEST_COIN_UI_MODEL_ENV__');
const { testCoinPolicy } = await import('../lib/v2/test-coin-policy.ts');
const { testCoinEstimate } = await import('../lib/v2/test-coin-estimate.ts');
const { testCoinWalletSummary } = await import('../lib/v2/test-coin-wallet-summary.ts');
const { testCoinHistoryPage } = await import('../lib/v2/test-coin-history-page.ts');
const policy = testCoinPolicy({PAWSPACE_TEST_COINS:'on',FORBID_PRODUCTION:'true',APP_ENV:'test'});
const quote = {policy,eligibleAmount:1234.56,actualPayable:100,currency:'INR',spendableCoins:80,grantBalanceAdjustment:0,requestedCoins:80,grants:[{source_kind:'booking',source_id:'prior',remaining:80,expires_at:2000}]};
for (const service of ['grooming','boarding','sitting','walking','training','taxi','vet_consult','food','relocation','funeral']) {
 test(`${service}: governed earning quote, subsequent reuse and actual payable stay separate`, () => {
  const p=testCoinEstimate({...quote,source:service,bookingId:'next'},1000);
  assert.equal(p.estimatedCoins,123);assert.equal(p.earningConfigured,false);
  assert.equal(p.simulatedDiscount,80);assert.equal(p.simulatedPayable,20);assert.equal(p.actualPayable,100);
 });
}
test('disabled, expired, self-booking, invalid and unknown quotes fail closed',()=>{
 assert.equal(testCoinEstimate({...quote,policy:{...policy,enabled:false}},1000).estimatedCoins,null);
 assert.equal(testCoinEstimate(quote,2000).maximumCoins,0);
 assert.equal(testCoinEstimate({...quote,source:'booking',bookingId:'prior'},1000).availableCoins,0);
 assert.equal(testCoinEstimate({...quote,requestedCoins:81},1000).requestEligible,false);
 assert.equal(testCoinEstimate({...quote,requestedCoins:1.5},1000).requestEligible,false);
 assert.equal(testCoinEstimate({...quote,eligibleAmount:null,actualPayable:null},1000).estimatedCoins,null);
 assert.equal(testCoinEstimate({...quote,blocked:true},1000).maximumCoins,0);
 assert.equal(testCoinEstimate({...quote,spendableCoins:0},1000).availableCoins,0);
});
function dbFixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE v2_test_coin_ledger(id TEXT,customer_id TEXT,source_kind TEXT,source_id TEXT,entry_type TEXT,coins INTEGER,preview_discount REAL,policy_json TEXT,created_at INTEGER)');
 return {sqlite,prepare(sql){return {bind(...args){return {async first(){return sqlite.prepare(sql).get(...args)},async all(){return {results:sqlite.prepare(sql).all(...args)}}}}}}};
}
test('wallet lifetime uses full owner ledger, restores simulated savings and paginates tied dates',async()=>{
 const db=dbFixture();const insert=db.sqlite.prepare('INSERT INTO v2_test_coin_ledger VALUES(?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<105;i++)insert.run(`earn-${String(i).padStart(3,'0')}`,'alice','booking',`booking-${i}`,'earned',10,0,'{}',1000);
 insert.run('redeem','alice','food','next','redeemed',-20,20,'{}',1100);
 insert.run('restore','alice','food','next','redemption_restore',20,0,'{}',1200);
 insert.run('reverse','alice','booking','booking-0','earn_reversal',-10,0,'{}',1300);
 insert.run('other','bob','taxi','other','earned',999,0,'{}',2000);
 const totals=await testCoinWalletSummary(db,'alice');assert.equal(totals.lifetimeCoinsEarned,1050);assert.equal(totals.lifetimeActualRupeesSaved,0);assert.equal(totals.lifetimeNetSimulatedSavings,0);assert.equal(totals.lifetimeEarningsReversed,10);
 const first=await testCoinHistoryPage(db,'alice');const second=await testCoinHistoryPage(db,'alice',first.nextHistoryCursor);
 assert.equal(first.history.length,100);assert.equal(second.history.length,8);assert.equal(new Set([...first.history,...second.history].map(e=>e.id)).size,108);
 assert.equal((await testCoinHistoryPage(db,'alice','other')).history.length,0);
 db.sqlite.close();
});

test('expiry preserves debt hidden in a positive snapshot balance and excludes only source grants',()=>{
 const grants=[{source_kind:'booking',source_id:'old',remaining:70,expires_at:1500},{source_kind:'booking',source_id:'own',remaining:20,expires_at:3000},{source_kind:'booking',source_id:'other',remaining:30,expires_at:3000}];
 const input={...quote,grants,spendableCoins:100,grantBalanceAdjustment:-20,requestedCoins:30};
 assert.equal(testCoinEstimate(input,1000).availableCoins,100);
 assert.equal(testCoinEstimate(input,2000).availableCoins,30);
 assert.equal(testCoinEstimate({...input,source:'booking',bookingId:'own'},2000).availableCoins,30);
 assert.equal(testCoinEstimate({...input,grantBalanceAdjustment:Number.NaN},2000).availableCoins,0);
 assert.equal(testCoinEstimate({...input,grants:[{...grants[0],remaining:0},...grants.slice(1)]},1000).nextExpiry,3000);
});
