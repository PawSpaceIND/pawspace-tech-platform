import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { d1 } from './helpers/execution-harness.mjs';
installWorkersHooks('__SUBSCRIPTION_BOOT_DB__');
const { runSubscriptionScheduledMaintenance } = await import('../lib/subscription-scheduled.ts');
const env = {PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',FORBID_PRODUCTION:'true'};

test('subscription cron can be the first request on a fresh database and safely repeat', async(t) => {
  const sqlite = new DatabaseSync(':memory:'); t.after(()=>sqlite.close()); const db=d1(sqlite);
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('no provider request is needed on empty deployment');});
  for(let attempt=0;attempt<2;attempt++){
    const result=await runSubscriptionScheduledMaintenance(db,env,{asOf:Date.now()});
    assert.equal(result.errors,0);
    assert.equal(result.planChanges.processed,0);
    assert.equal(result.dunning.processed,0);
  }
  assert.ok(sqlite.prepare('PRAGMA table_info(subscription_billing_plans)').all().some(row=>row.name==='city_id'));
});

test('schema failure stops the subscription sweep and remains visible to the scheduler',async()=>{
  let billingCalls=0;
  const db={prepare(){return {};},async batch(){throw new Error('injected database unavailable');}};
  await assert.rejects(runSubscriptionScheduledMaintenance(db,env,{asOf:Date.now(),billingSweep:async()=>{billingCalls++;return {};}}),/injected database unavailable/);
  assert.equal(billingCalls,0);
});
