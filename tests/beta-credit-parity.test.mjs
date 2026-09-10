import assert from 'node:assert/strict';
import test from 'node:test';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { betaD1, betaBooking } from './helpers/beta-d1.mjs';
installWorkersHooks('__BETA_CREDIT_DB__');
const { paymentStageAmount } = await import('../lib/payment-stage-amount.ts');
const { ensurePawspaceWalletTables, creditWallet, redeemWalletForBooking } = await import('../lib/pawspace-wallet-governance.ts');
const { grantGoodwillPoints, redeemPoints } = await import('../lib/paw-points-governance.ts');

async function appliedWallet(ctx, bookingId, value) {
  // Existing credited-ledger fixture, including historical redemption records. No mocked calculator.
  await ensurePawspaceWalletTables(ctx.db);
  ctx.sqlite.prepare(`INSERT INTO pawspace_wallet_ledger
    (id,customer_id,entry_type,amount,bonus_amount,applied_value,source_type,source_id,idempotency_key,note,balance_after,actor_id,created_at)
    VALUES (?,'beta-customer','redeem',?,0,?,'booking',?,?,'historical test fixture',0,'beta-fixture',?)`)
    .run('wal-'+bookingId,-value,value,bookingId,'redeem-'+bookingId,Date.now());
}

test('beta credit parity: a recorded INR 500 applied credit reduces due-now by exactly 500', async () => {
  const ctx = betaD1(); try {
    const id = betaBooking(ctx.sqlite);
    await appliedWallet(ctx,id,500);
    const stage = await paymentStageAmount(ctx.db,id);
    assert.equal(stage.dueNow,1399); assert.equal(stage.appliedCredits,500);
    assert.equal(Math.round((1899-stage.dueNow)*100),50000);
    assert.equal(ctx.sqlite.prepare('SELECT amount FROM booking_payments').get().amount,1899);
  } finally { ctx.close(); }
});

test('beta Wallet half-paise tie reduces hosted cash due by exactly INR 500', async () => {
  const ctx=betaD1(); try {
    const id=betaBooking(ctx.sqlite,{amount:1349,due:1349});
    await creditWallet(ctx.db,{customerId:'beta-customer',amount:454.55,source:'goodwill',idempotencyKey:'beta-exact-500-wallet',note:'Half-paise tie regression',actorId:'beta-fixture'});
    const redemption=await redeemWalletForBooking(ctx.db,{customerId:'beta-customer',bookingId:id,walletAmount:454.55,actorId:'beta-customer'});
    assert.deepEqual({walletUsed:redemption.walletUsed,bonus:redemption.bonus,appliedValue:redemption.appliedValue},{walletUsed:454.55,bonus:45.45,appliedValue:500});
    const stage=await paymentStageAmount(ctx.db,id);
    assert.equal(stage.dueNow,849);
    assert.equal(stage.appliedCredits,500);
  } finally { ctx.close(); }
});

test('beta wallet parity preserves the existing 10-percent bonus and its balanced ledger', async () => {
  const ctx=betaD1(); try {
    const id=betaBooking(ctx.sqlite);
    await creditWallet(ctx.db,{customerId:'beta-customer',amount:500,source:'goodwill',idempotencyKey:'beta-seed-wallet',note:'Synthetic isolated test balance',actorId:'beta-fixture'});
    const redemption=await redeemWalletForBooking(ctx.db,{customerId:'beta-customer',bookingId:id,walletAmount:500,actorId:'beta-customer'});
    assert.equal(redemption.walletUsed,500); assert.equal(redemption.bonus,50); assert.equal(redemption.appliedValue,550);
    assert.equal((await paymentStageAmount(ctx.db,id)).dueNow,1349);
    const rows=ctx.sqlite.prepare("SELECT debit,credit FROM finance_journal_entries WHERE source_type='wallet_redeem'").all();
    assert.equal(rows.length,3);
    assert.equal(rows.reduce((n,r)=>n+Math.round(r.debit*100),0),55000);
    assert.equal(rows.reduce((n,r)=>n+Math.round(r.credit*100),0),55000);
  } finally { ctx.close(); }
});

test('beta PawPoints parity subtracts the actual redemption and preserves the unspent odd point', async () => {
  const ctx=betaD1(); try {
    const id=betaBooking(ctx.sqlite);
    await grantGoodwillPoints(ctx.db,{customerId:'beta-customer',points:101,reason:'Synthetic beta parity fixture',actorId:'beta-fixture',idempotencyKey:'beta-points'});
    const redemption=await redeemPoints(ctx.db,{customerId:'beta-customer',points:101,bookingId:id,actorId:'beta-customer'});
    assert.equal(redemption.pointsRedeemed,100); assert.equal(redemption.balance,1);
    const stage=await paymentStageAmount(ctx.db,id);
    assert.equal(stage.appliedCredits,50); assert.equal(stage.dueNow,1849);
  } finally { ctx.close(); }
});

test('beta split parity spends credits once, not again on the balance', async () => {
  const ctx=betaD1(); try {
    const id=betaBooking(ctx.sqlite,{amount:10000,due:5000});
    ctx.sqlite.prepare("INSERT INTO stay_payment_schedules VALUES (?,5000,5000,'pending_balance')").run(id);
    await appliedWallet(ctx,id,500);
    assert.equal((await paymentStageAmount(ctx.db,id)).dueNow,4500);
    ctx.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run(id);
    ctx.sqlite.prepare('INSERT INTO payment_reconciliation_records VALUES (?,4500)').run('pay-'+id);
    const balance=await paymentStageAmount(ctx.db,id);
    assert.equal(balance.stage,'outstanding_balance'); assert.equal(balance.dueNow,5000);
    assert.equal(4500+balance.dueNow+500,10000);
  } finally { ctx.close(); }
});

test('beta split parity applies a later credit to remaining cash rather than the already captured instalment', async () => {
  const ctx=betaD1(); try {
    const id=betaBooking(ctx.sqlite,{amount:10000,due:5000,status:'captured'});
    ctx.sqlite.prepare("INSERT INTO stay_payment_schedules VALUES (?,5000,5000,'pending_balance')").run(id);
    ctx.sqlite.prepare('INSERT INTO payment_reconciliation_records VALUES (?,5000)').run('pay-'+id);
    await appliedWallet(ctx,id,500);
    assert.equal((await paymentStageAmount(ctx.db,id)).dueNow,4500);
  } finally { ctx.close(); }
});
