import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorld,seedBooking,TRAINER,CUSTOMER,sessionCookie,routeCall} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingBooking}=await import('../lib/training-programme.ts');
const {mutateTrainingSession}=await import('../lib/training-session-lifecycle.ts');
const {trainingBookingPaymentState}=await import('../lib/training-payment-eligibility.ts');
const {trainingQuotePaymentState}=await import('../lib/training-commercial-governance.ts');
const {ensurePaymentReconciliationTables}=await import('../lib/grooming-payment-reconciliation.ts');
const {commitRazorpayCaptureAtomic,executeRazorpayCapturePostCommit}=await import('../lib/razorpay-capture-atomic.ts');
const {ensureTrainingFinanceTables,listTrainerEarnings,refreshTrainingFinanceReadModel}=await import('../lib/training-finance.ts');
const {ensureProviderCapacityTables}=await import('../lib/provider-capacity-governance.ts');
const jobs=await import('../app/api/partner-jobs/route.ts');
const trainingSessions=await import('../app/api/training-sessions/route.ts');
async function world(options={}){
 const w=freshWorld(options.env);seedBooking(w,{id:'FUND',group:'FUND-G',sessions:2,total:1000,dueNow:500,...options});
 const p=await materializeTrainingBooking(w.db,{bookingId:'FUND',actorId:'qa'});
 const quoteId=w.sqlite.prepare("SELECT quote_id FROM training_booking_quote_links WHERE booking_id='FUND'").get().quote_id;
 w.sqlite.prepare("DELETE FROM training_quote_payment_attestations").run();w.sqlite.prepare("UPDATE booking_payments SET status='created'").run();
 return {...w,...p,quoteId};
}
const read=w=>trainingBookingPaymentState(w.db,'FUND');
const accept=w=>mutateTrainingSession(w.db,{sessionId:w.sessions[0].id,action:'accept',actorId:'qa',idempotencyKey:'accept-funding'});
async function capture(w,amount){await ensurePaymentReconciliationTables(w.db);return commitRazorpayCaptureAtomic(w.db,{authority:'provider_api',eventId:'qa-local-capture',environment:'sandbox',bookingId:'FUND',paymentId:'PAY-FUND',gatewayOrderId:'order_qa_funding',gatewayPaymentId:'pay_qa_funding',amountPaise:amount*100,currency:'INR',payloadHash:'isolated-local-fixture'});}
async function providerRead(w){await ensureProviderCapacityTables(w.db);w.sqlite.prepare("INSERT OR IGNORE INTO provider_capacity_profiles(id,city_id,name,provider_model,services_json,zones_json,effective_from,status,live,updated_by,updated_at) VALUES (?,'blr','QA Trainer','full_time','[\"dog_training\"]','[\"blr-east\"]','2020-01-01','active',1,'qa',1)").run(TRAINER);const r=await routeCall(jobs.GET,'GET','/api/partner-jobs?providerId='+TRAINER,{cookie:await sessionCookie(w.db,'provider',TRAINER)});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.jobs;}
function credits(w,{wallet=0,points=0,reward=0,owner=CUSTOMER}={}){
 w.sqlite.exec("CREATE TABLE IF NOT EXISTS pawspace_wallet_ledger (customer_id TEXT,entry_type TEXT,source_type TEXT,source_id TEXT,applied_value REAL); CREATE TABLE IF NOT EXISTS paw_points_ledger (customer_id TEXT,entry_type TEXT,booking_id TEXT,points INTEGER); CREATE TABLE IF NOT EXISTS review_reward_codes (customer_id TEXT,status TEXT,redeemed_booking_id TEXT,applied_amount REAL,discount_amount REAL)");
 w.sqlite.prepare("INSERT INTO pawspace_wallet_ledger VALUES (?,'redeem','booking','FUND',?)").run(owner,wallet);
 w.sqlite.prepare("INSERT INTO paw_points_ledger VALUES (?,'redeemed','FUND',?)").run(owner,-points);
 w.sqlite.prepare("INSERT INTO review_reward_codes VALUES (?,'redeemed','FUND',?,?)").run(owner,reward,reward);
}
test('real canonical capture agrees across commercial status, provider jobs, lifecycle and finance without an attestation',async()=>{
 const w=await world({sessions:1,total:500,dueNow:500,packageCode:'trainer-meet-greet'});await capture(w,500);
 const payment=await trainingQuotePaymentState(w.db,w.quoteId);assert.equal(payment.status,'FULLY_PAID');assert.equal(payment.amountPaid,500);assert.equal(payment.remainingAmount,0);
 const job=(await providerRead(w))[0];assert.equal(job.payment.status,'captured');assert.equal(job.payment.amountDueNow,0);assert.equal((await accept(w)).status,'accepted');
 await ensureTrainingFinanceTables(w.db);w.sqlite.prepare("UPDATE training_sessions SET status='completed',completed_at=?").run(Date.now());
 w.sqlite.prepare("INSERT INTO training_compensation_rules(id,city_id,rate_value,effective_from,updated_by,reason,updated_at) VALUES ('QA-RATE','blr',125,'2020-01-01','qa','Isolated fixture rate',1)").run();
 assert.equal((await listTrainerEarnings(w.db,TRAINER)).earnings[0].status,'earned');await refreshTrainingFinanceReadModel(w.db);
 assert.equal(w.sqlite.prepare("SELECT payment_status FROM training_finance_invoices WHERE booking_id='FUND'").get().payment_status,'FULLY_PAID');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_quote_payment_attestations').get().n,0);
});
test('canonical captured deposit is partial despite booking_payments captured flag',async()=>{const w=await world();await capture(w,500);assert.equal((await read(w)).status,'PARTIALLY_PAID');assert.equal((await read(w)).remainingAmount,500);assert.equal((await providerRead(w))[0].payment.status,'partially_paid');assert.equal((await accept(w)).status,'accepted');});
for(const [name,data,expected] of [['wallet',{wallet:1000},1000],['PawPoints',{points:2000},1000],['reward',{reward:1000},1000],['mixed instruments',{wallet:400,points:400,reward:400},1000]])test(name+' ledger coverage is recognised without fabricated cash capture',async()=>{const w=await world();credits(w,data);const state=await read(w);assert.equal(state.status,'FULLY_PAID');assert.equal(state.creditPaid,expected);assert.equal(state.cashPaid,0);assert.equal((await accept(w)).status,'accepted');});
test('cash plus credits covers the package without counting credits as cash',async()=>{const w=await world({dueNow:1000});credits(w,{wallet:300,points:200,reward:100});await capture(w,500);const p=await read(w);assert.equal(p.cashPaid,500);assert.equal(p.creditPaid,500);assert.equal(p.amountPaid,1000);assert.equal(p.status,'FULLY_PAID');assert.equal((await providerRead(w))[0].payment.amountDueNow,0);});
test('foreign customer credit rows never fund this booking',async()=>{const w=await world();credits(w,{wallet:1000,points:2000,reward:1000,owner:'foreign'});assert.equal((await read(w)).amountPaid,0);await assert.rejects(accept(w),e=>e instanceof Response&&e.status===409);});
test('refunded cash reduces finance coverage and cannot fall back to an old paid attestation',async()=>{
 const w=await world();await capture(w,500);w.sqlite.prepare("INSERT INTO training_quote_payment_attestations(quote_id,status,amount,currency,environment,reference,bound_payment_key,created_at,updated_at) VALUES (?,'FULLY_PAID',1000,'INR','sandbox','old','old',1,1)").run(w.quoteId);
 w.sqlite.prepare("UPDATE payment_reconciliation_records SET refunded_amount=500,gateway_status='refunded'").run();w.sqlite.prepare("UPDATE booking_payments SET status='refunded'").run();
 assert.equal((await read(w)).amountPaid,0);assert.equal((await trainingQuotePaymentState(w.db,w.quoteId)).status,'UNPAID');assert.equal((await providerRead(w))[0].payment.status,'refunded');await assert.rejects(accept(w),e=>e instanceof Response&&e.status===409);
});
for(const [name,sql] of [['wrong environment',"UPDATE payment_reconciliation_records SET environment='live'"],['currency mismatch',"UPDATE payment_reconciliation_records SET currency='USD'"],['variance',"UPDATE payment_reconciliation_records SET variance_amount=1"],['failed gateway',"UPDATE payment_reconciliation_records SET gateway_status='failed'"],['refund exceeds capture',"UPDATE payment_reconciliation_records SET refunded_amount=501"],['damaged canonical quote',"UPDATE training_commercial_quotes SET total_amount=999"]])test(name+' cannot become paid or authorise service even with credits',async()=>{const w=await world();await capture(w,500);credits(w,{wallet:1000});w.sqlite.exec(sql);assert.equal((await read(w)).amountPaid,0);await assert.rejects(accept(w),e=>e instanceof Response&&e.status===409);});
test('credit reversal between preflight and atomic claim rolls back acceptance and events',async()=>{const w=await world();credits(w,{wallet:1000});const batch=w.db.batch.bind(w.db);let reversed=false;w.db.batch=async statements=>{if(!reversed&&statements.some(s=>s.sql.startsWith("UPDATE training_sessions SET status='accepted'"))){reversed=true;w.sqlite.prepare('DELETE FROM pawspace_wallet_ledger').run();}return batch(statements);};await assert.rejects(accept(w),e=>e instanceof Response&&e.status===409);assert.equal(reversed,true);assert.equal(w.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(w.sessions[0].id).status,'scheduled');assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_session_events').get().n,0);});
test('real wallet redemption plus real capture module funds Training once across all readers',async()=>{
 const w=await world({dueNow:1000});
 const {creditWallet,redeemWalletForBooking}=await import('../lib/pawspace-wallet-governance.ts');
 await creditWallet(w.db,{customerId:CUSTOMER,amount:500,source:'goodwill',sourceId:'qa-fixture',idempotencyKey:'qa-wallet-fund',actorId:'qa',note:'Isolated local funding fixture'});
 await redeemWalletForBooking(w.db,{customerId:CUSTOMER,bookingId:'FUND',walletAmount:500,actorId:'qa'});
 await capture(w,450);const state=await read(w);assert.equal(state.creditPaid,550);assert.equal(state.cashPaid,450);assert.equal(state.amountPaid,1000);assert.equal(state.status,'FULLY_PAID');assert.equal((await providerRead(w))[0].payment.amountDueNow,0);assert.equal((await accept(w)).status,'accepted');
});
test('restored PawPoints no longer count as funding',async()=>{const w=await world();credits(w,{points:2000});w.sqlite.prepare("INSERT INTO paw_points_ledger VALUES (?,'cancellation_restore','FUND',2000)").run(CUSTOMER);assert.equal((await read(w)).creditPaid,0);await assert.rejects(accept(w),e=>e instanceof Response&&e.status===409);});
/*
 * Staging E2E 36243387701: the partner app showed "No assigned jobs" for a trainer whose split booking had its
 * deposit captured. That booking is listed (the home was only still loading); what /api/partner-jobs must NOT
 * list is an unpaid one, whose Accept the lifecycle refuses with 409 training_payment_required. Same rule as
 * lib/partner-job-feed.ts and lib/provider-workspace.ts (06d044c), which never reached this route.
 */
test('a split Training booking reaches the trainer only once its deposit is captured, and the trainer can then accept it',async()=>{
 const w=await world({status:'payment_pending'});
 w.sqlite.prepare("UPDATE training_commercial_quotes SET payment_mode='split' WHERE id=?").run(w.quoteId);w.sqlite.prepare("UPDATE booking_payments SET mode='split' WHERE booking_id='FUND'").run();
 assert.deepEqual(await providerRead(w),[],'an unpaid (payment_pending) Training booking is not offered to the trainer');
 // A fresh provider session per call: providerRead issues one too, and a new session supersedes the last.
 const post=async key=>routeCall(trainingSessions.POST,'POST','/api/training-sessions',{cookie:await sessionCookie(w.db,'provider',TRAINER),body:{sessionId:w.sessions[0].id,action:'accept',idempotencyKey:key}});
 const refused=await post('split-accept-unpaid');assert.equal(refused.status,409,'this is why it is not offered');
 const committed=await capture(w,500);const effects=await executeRazorpayCapturePostCommit(w.db,{outboxId:committed.effectsOutboxId,workerId:'qa-split-deposit'});assert.equal(effects.completed,true,JSON.stringify(effects));
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='FUND'").get().status,'confirmed','the captured deposit confirms the split booking');
 const listed=await providerRead(w);
 assert.deepEqual(listed.map(job=>[job.trainingSessionId,job.status,job.payment.status,job.payment.mode,job.payment.amountDueNow]),[[w.sessions[0].id,'scheduled','partially_paid','split',0],[w.sessions[1].id,'locked','partially_paid','split',0]]);
 const accepted=await post('split-accept-deposit');assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.data.status,'accepted');
});
