import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeD1 } from './helpers/taxi-harness.mjs';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
installWorkersHooks('__PAID_REMEDIATION_DB__','__PAID_REMEDIATION_ENV__');
const { bookingPaymentBalances } = await import('../lib/booking-payment-balances.ts');
const { paymentStageAmount } = await import('../lib/payment-stage-amount.ts');
import { customerBookingManageHref } from '../lib/customer-activity.ts';
import { customerScopedHref } from '../lib/v2/route-scope.ts';
function world(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(`CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,status TEXT);
    CREATE TABLE stay_payment_schedules(booking_id TEXT,paid_now_amount REAL,balance_amount REAL,status TEXT);
    CREATE TABLE taxi_payment_schedules(booking_id TEXT,booking_fee_amount REAL,balance_amount REAL,status TEXT);
    CREATE TABLE payment_reconciliation_records(payment_id TEXT,booking_id TEXT,captured_amount REAL);
    CREATE TABLE pawspace_wallet_ledger(source_id TEXT,source_type TEXT,entry_type TEXT,applied_value REAL);
    CREATE TABLE paw_points_ledger(booking_id TEXT,entry_type TEXT,points REAL);
    CREATE TABLE review_reward_codes(redeemed_booking_id TEXT,status TEXT,applied_amount REAL,discount_amount REAL);`);
  const db = makeD1(sql);
  const add = (id, amount, due, status = 'created') => sql.prepare('INSERT INTO booking_payments VALUES (?,?,?,?,?,?)').run(`P-${id}`, id, amount, due, 'INR', status);
  return { sql, db, add };
}
test('Control Center uses checkout amounts for unpaid, captured, refunded and split bookings', async t => {
  const f = world(t);
  f.add('unpaid', 1241, 1241); f.add('paid', 1241, 1241, 'captured'); f.add('refund', 1241, 1241, 'refunded');
  f.add('split', 3500, 1750, 'captured'); f.add('taxi', 800, 400, 'captured'); f.add('after', 349, 0);
  f.sql.exec("INSERT INTO stay_payment_schedules VALUES ('split',1750,1750,'pending_balance');INSERT INTO taxi_payment_schedules VALUES ('taxi',400,400,'pending_balance');INSERT INTO payment_reconciliation_records VALUES ('P-split','split',1750),('P-taxi','taxi',400);");
  const result = await bookingPaymentBalances(f.db, ['unpaid','paid','refund','split','taxi','after']);
  for (const [id, due] of [['unpaid',1241],['paid',0],['refund',0],['split',1750],['taxi',400],['after',0]]) {
    assert.equal(result.get(id).dueNow, due, id); assert.deepEqual(result.get(id), await paymentStageAmount(f.db, id), id);
  }
});
test('credits, second captures and future requests are read fresh without double application', async t => {
  const f = world(t); f.add('split', 1000, 500, 'captured');
  f.sql.exec("INSERT INTO stay_payment_schedules VALUES ('split',500,500,'pending_balance');INSERT INTO payment_reconciliation_records VALUES ('P-split','split',400);INSERT INTO pawspace_wallet_ledger VALUES ('split','booking','redeem',100);INSERT INTO paw_points_ledger VALUES ('split','redeemed',-100);");
  assert.equal((await bookingPaymentBalances(f.db, ['split'])).get('split').dueNow,450);
  f.sql.exec("UPDATE payment_reconciliation_records SET captured_amount=850");
  assert.equal((await bookingPaymentBalances(f.db, ['split'])).get('split').dueNow,0);
  assert.deepEqual((await bookingPaymentBalances(f.db, ['split'])).get('split'), await paymentStageAmount(f.db,'split'));
});
test('optional missing ledgers do not hide database errors; batch queries are bounded', async t => {
  const f=world(t); for(let i=0;i<150;i++)f.add(`b${i}`,100,100,'captured');
  let count=0;const counted={...f.db,prepare(sql){count++;return f.db.prepare(sql);}};
  assert.equal((await bookingPaymentBalances(counted,Array.from({length:150},(_,i)=>`b${i}`))).size,150);
  assert.equal(count,3,'one schema read and one atomic financial SELECT per 80-record batch');
  f.sql.exec('DROP TABLE pawspace_wallet_ledger');
  assert.equal((await bookingPaymentBalances(f.db,['b0'])).get('b0').dueNow,0);
  f.sql.exec('ALTER TABLE payment_reconciliation_records RENAME COLUMN captured_amount TO wrong_column');
  await assert.rejects(()=>bookingPaymentBalances(f.db,['b0']),/captured_amount/);
});
test('Training activity recovery remains within V2 and binds the exact owned booking',()=>{
 const href=customerBookingManageHref({id:'B & 1',serviceCode:'dog_training',status:'payment_pending',scheduledStart:''});
 assert.equal(href,'/mobile-app/booking-confirmation?bookingId=B%20%26%201&payment=resume');
 assert.equal(customerScopedHref('/v2/activity',href),'/v2/booking-confirmation?bookingId=B%20%26%201&payment=resume');
});

test('a capture between schema discovery and financial read cannot produce a mixed instalment snapshot',async t=>{
 const f=world(t);f.add('atomic',1000,500,'captured');
 f.sql.exec("INSERT INTO stay_payment_schedules VALUES ('atomic',500,500,'pending_balance');INSERT INTO payment_reconciliation_records VALUES ('P-atomic','atomic',500)");
 let captured=false;
 f.db.onSql('FROM booking_payments p',()=>{captured=true;f.sql.exec("UPDATE stay_payment_schedules SET status='paid' WHERE booking_id='atomic';UPDATE payment_reconciliation_records SET captured_amount=1000 WHERE booking_id='atomic'");});
 const result=await paymentStageAmount(f.db,'atomic');
 assert.equal(captured,true);assert.equal(result.stage,'settled');assert.equal(result.dueNow,0);assert.equal(result.outstandingBalance,0);
});
