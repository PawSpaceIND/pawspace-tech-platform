import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { makeD1 } from './helpers/taxi-harness.mjs';
installWorkersHooks('__PARTNER_BALANCE_DB__', '__PARTNER_BALANCE_ENV__');
const {upsertIdentityBinding}=await import('../lib/identity-binding.ts');
const {issuePlatformSession,PLATFORM_SESSION_COOKIE}=await import('../lib/platform-session.ts');
const {GET}=await import('../app/api/partner-grooming-jobs/route.ts');
async function world(t){
 const sqlite=new DatabaseSync(':memory:'),db=makeD1(sqlite);t.after(()=>sqlite.close());
 globalThis.__PARTNER_BALANCE_DB__=db;globalThis.__PARTNER_BALANCE_ENV__={PAWSPACE_DEPLOYMENT_ENV:'e2e'};
 const identity={identitySource:'partner_otp',principalType:'identity_subject',principalKey:'provider:QA-PROVIDER',subjectType:'provider',subjectId:'QA-PROVIDER'};
 const binding=await upsertIdentityBinding(db,{...identity,verificationState:'verified',actorId:'test',reason:'Synthetic provider balance regression'});
 const session=await issuePlatformSession(db,{...identity,bindingId:binding.id});
 const req=id=>new Request('https://non-atlas.pawspace.test/api/partner-grooming-jobs?providerId='+id,{headers:{cookie:PLATFORM_SESSION_COOKIE+'='+encodeURIComponent(session.token)}});
 const initial=await GET(req('QA-PROVIDER'));assert.equal(initial.status,200,await initial.text());
 sqlite.exec("INSERT INTO canonical_customers VALUES ('C','blr','Synthetic Customer','9000000801',NULL,NULL,'uat','{}',1,1)");
 sqlite.exec("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('B','idem','C','[]','[]','blr','blr-east','grooming','dog-bath','Essential Bath','G','QA-PROVIDER','2099-01-01T09:00:00Z','2099-01-01T11:00:00Z','confirmed',1000,'test',1,1)");
 sqlite.exec("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,created_at,updated_at) VALUES ('W','B','G','QA-PROVIDER','QA Provider','full_time','grooming','2099-01-01T09:00:00Z','2099-01-01T11:00:00Z',1,1)");
 sqlite.exec("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,idempotency_key,created_at,updated_at) VALUES ('P','B','C',1000,1000,'INR','online','prepaid','created','pay-idem',1,1)");
 return {sqlite,db,req,read:async()=>{const r=await GET(req('QA-PROVIDER'));const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.jobs[0];}};
}
for(const [status,due] of [['created',1000],['captured',0],['refunded',0],['partially_refunded',0]])test(`provider current due is ${due} for ${status}, original instalment unchanged`,async t=>{
 const w=await world(t);w.sqlite.prepare("UPDATE booking_payments SET status=? WHERE id='P'").run(status);
 const job=await w.read();assert.equal(job.payment.amountDueNow,due);assert.equal(job.payment.amount,1000);
 assert.equal(w.sqlite.prepare("SELECT amount_due_now FROM booking_payments WHERE id='P'").get().amount_due_now,1000);
 assert.equal(job.customer.maskedPhone.includes('9000000801'),false);
});
test('provider pay-after zero online due never erases the service total',async t=>{
 const w=await world(t);w.sqlite.exec("UPDATE booking_payments SET mode='pay_after_service',amount_due_now=0");const job=await w.read();assert.equal(job.payment.amountDueNow,0);assert.equal(job.payment.amount,1000);
});
test('captured deposit leaves its outstanding balance visible and a later capture clears it',async t=>{
 const w=await world(t);w.sqlite.exec("CREATE TABLE stay_payment_schedules(booking_id TEXT PRIMARY KEY,paid_now_amount REAL,balance_amount REAL,status TEXT); INSERT INTO stay_payment_schedules VALUES ('B',500,500,'deposit_paid'); CREATE TABLE payment_reconciliation_records(payment_id TEXT PRIMARY KEY,captured_amount REAL); INSERT INTO payment_reconciliation_records VALUES ('P',500); UPDATE booking_payments SET amount_due_now=500,status='captured',mode='split_50_50'");
 assert.equal((await w.read()).payment.amountDueNow,500);w.sqlite.exec("UPDATE payment_reconciliation_records SET captured_amount=1000");assert.equal((await w.read()).payment.amountDueNow,0);
});
test('a provider cannot read another provider balances',async t=>{const w=await world(t);assert.equal((await GET(w.req('OTHER-PROVIDER'))).status,403);});

test('payment mode and method are from the same snapshot as current due',async t=>{
 const w=await world(t);w.sqlite.exec("UPDATE booking_payments SET status='captured'");
 const prepare=w.db.prepare.bind(w.db);let changed=false;
 w.db.prepare=sql=>{
  if(!changed&&sql.includes("name IN (")&&sql.includes('sqlite_master')){
   changed=true;
   w.sqlite.exec("UPDATE booking_payments SET status='created',mode='pay_after_service',method='cash',amount_due_now=0");
  }
  return prepare(sql);
 };
 const job=await w.read();assert.equal(changed,true);
 assert.deepEqual(job.payment,{method:'cash',mode:'pay_after_service',status:'created',amount:1000,amountDueNow:0});
});
