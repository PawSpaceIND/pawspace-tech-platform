import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { betaD1, betaBooking } from './helpers/beta-d1.mjs';
installWorkersHooks('__BETA_SCOPED_DB__');

test('beta reservation lease expires after five minutes and the existing cleanup releases it', async () => {
  const ctx=betaD1(); try {
    const { reservationLeaseForRequest, cleanupExpiredReservationLeases, SCHEDULING_RESERVATION_LEASE_MS }=await import('../lib/scheduling-reservation-leases.ts');
    assert.equal(SCHEDULING_RESERVATION_LEASE_MS,300000);
    ctx.sqlite.exec(`CREATE TABLE scheduling_reservations
      (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,service_code TEXT,care_mode TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER);
      CREATE TABLE scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,status TEXT,actor_id TEXT,reason TEXT,updated_at INTEGER);`);
    const now=Date.now();
    const lease=await reservationLeaseForRequest(ctx.db,new Request('https://uat.pawspace.in'), 'beta-customer',now);
    assert.equal(lease.leaseExpiresAt,now+300000);
    ctx.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,scheduled_start,scheduled_end,status,created_at,lease_expires_at) VALUES ('r','g','p','grooming','2027-01-01T04:00:00Z','2027-01-01T06:00:00Z','assigned',?,?)").run(now,lease.leaseExpiresAt);
    ctx.sqlite.prepare("INSERT INTO scheduling_assignment_decisions VALUES ('g','assigned',NULL,NULL,?)").run(now);
    const result=await cleanupExpiredReservationLeases(ctx.db,lease.leaseExpiresAt);
    assert.equal(result.reservations,1);
    assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id='r'").get().status,'cancelled');
    // Source configuration checks, not a claim that an external scheduled deployment ran.
    assert.match(readFileSync(new URL('../vite.config.ts',import.meta.url),'utf8'),/crons\s*:\s*\[\s*['"]\*\/5 \* \* \* \*['"]/);
    assert.match(readFileSync(new URL('../worker/index.ts',import.meta.url),'utf8'),/cleanupExpiredReservationLeases\(env\.DB,controller\.scheduledTime\)/);
  } finally {ctx.close();}
});

test('beta processed refund posts a balanced gateway reversal once using the refund identity', async () => {
  const ctx=betaD1(); try {
    const {postVerifiedBookingRefund}=await import('../lib/booking-refund-ledger.ts');
    const {ACCT}=await import('../lib/finance-accounts.ts');
    const id=betaBooking(ctx.sqlite,{status:'partially_refunded'});
    ctx.sqlite.exec(`CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT,gateway_reference TEXT,amount REAL,status TEXT,updated_at INTEGER);
      CREATE TABLE payment_gateway_events (provider TEXT,event_id TEXT,event_type TEXT,environment TEXT,processing_status TEXT,signature_verified INTEGER,booking_id TEXT,payment_id TEXT,amount_subunits INTEGER,currency TEXT,gateway_refund_id TEXT,gateway_payment_id TEXT);`);
    ctx.sqlite.prepare("INSERT INTO booking_refund_cases VALUES ('refundcase',?,'rfnd_beta',500,'processed',?)").run(id,Date.now());
    ctx.sqlite.prepare("INSERT INTO payment_gateway_events VALUES ('razorpay','evt_refund','refund.processed','sandbox','processed',1,?,?,50000,'INR','rfnd_beta','pay_gateway_beta')").run(id,'pay-'+id);
    const event={provider:'razorpay',environment:'sandbox',eventId:'evt_refund',eventType:'refund.processed',bookingId:id,gatewayRefundId:'rfnd_beta',gatewayPaymentId:'pay_gateway_beta',amountSubunits:50000,currency:'INR',signatureVerified:true,payloadHash:'fixture'};
    assert.equal((await postVerifiedBookingRefund(ctx.db,event)).posted,true);
    assert.equal((await postVerifiedBookingRefund(ctx.db,event)).duplicatePrevented,true);
    const rows=ctx.sqlite.prepare("SELECT account_code,debit,credit FROM finance_journal_entries WHERE source_type='refund_completed'").all();
    assert.equal(rows.length,2);
    assert.equal(rows.find(r=>r.account_code===ACCT.REFUNDS).debit,500);
    assert.equal(rows.find(r=>r.account_code===ACCT.GATEWAY_CLEARING).credit,500);
    assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n,1);
  } finally {ctx.close();}
});

test('beta CX retains the failure warning and adds the pending staff notice in list and detail', () => {
  // Explicitly a UI source contract. Runtime conversation rendering is not certified by this check.
  const source=readFileSync(new URL('../app/team/customer-experience/page.tsx',import.meta.url),'utf8');
  assert.equal(source.split('Communication Pending · staff follow-up required').length-1,2);
  assert.ok(source.includes('text(comm.label)')); assert.ok(source.includes('text(communicationState.label)'));
});
