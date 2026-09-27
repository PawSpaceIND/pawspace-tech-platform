import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorld,seedBooking} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingBooking}=await import('../lib/training-programme.ts');
const {refreshTrainingFinanceReadModel}=await import('../lib/training-finance.ts');
const {trainingReconciliationSnapshot}=await import('../lib/training-reconciliation-snapshot.ts');

test('200 training programmes keep all invoices and funding with bounded read batches',async()=>{
 const w=freshWorld();
 for(let i=0;i<200;i++){
  const id=`BATCH-${i}`;seedBooking(w,{id,group:`GROUP-${i}`,sessions:1,total:1000,dueNow:i%2?1000:500});
  await materializeTrainingBooking(w.db,{bookingId:id,actorId:'local-test'});
 }
 const queries=[],invoiceBatches=[];
 const db={...w.db,prepare(sql){queries.push(sql);return w.db.prepare(sql);},batch(statements){if(statements.some(s=>s.sql.startsWith('INSERT INTO training_finance_invoices')))invoiceBatches.push(statements.length);return w.db.batch(statements);}};
 const result=await refreshTrainingFinanceReadModel(db);
 assert.equal(result.programmeCount,200);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_finance_invoices').get().n,200);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_finance_invoices WHERE payment_status='PARTIALLY_PAID'").get().n,100);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_finance_invoices WHERE payment_status='FULLY_PAID'").get().n,100);
 assert.deepEqual(invoiceBatches,[50,50,50,50]);
 assert.equal(queries.filter(q=>q==='SELECT * FROM training_tax_policies').length,1);
 assert.equal(queries.filter(q=>q.startsWith("SELECT * FROM training_sessions WHERE status='completed'")).length,1);
 assert.equal(queries.filter(q=>q.includes('ROUND(cashPaid+creditPaid,2) amountPaid')).length,1);
 assert.equal(queries.filter(q=>q.startsWith('SELECT * FROM training_sessions WHERE programme_id=')).length,0);
 const programmes=w.sqlite.prepare('SELECT p.*,b.schedule_group_id FROM training_programmes p JOIN canonical_bookings b ON b.id=p.booking_id').all();
 queries.length=0;
 const snapshot=await trainingReconciliationSnapshot(db,programmes);
 assert.equal(queries.length,5);
 assert.equal(snapshot.sessions.size,200);assert.equal(snapshot.reservations.size,200);assert.equal(snapshot.quotes.size,200);
 assert.equal(snapshot.sessions.get(programmes[0].id).length,1);
 assert.equal(snapshot.quotes.get(programmes[0].booking_id).quote_total,1000);
 assert.equal(snapshot.earnings.size,0);
});
