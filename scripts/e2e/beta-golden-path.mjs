/** One ordinary connected API scenario, not chaos/flood testing and not a hosted provider test.
 * All business logic below is imported from the application. Only the provider boundary is a
 * loopback HTTP contract server. Callback HMAC, actual routes, payment intents and ledger SQL execute.
 * The database, identities, wallet seed and provider IDs are isolated fixtures and never exported.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setupJourney, sessionCookie } from '../../tests/helpers/grooming-journey-harness.mjs';
import { seedOwnedPet } from '../../tests/helpers/saved-pet-fixture.mjs';

if(process.env.PAWSPACE_PAYMENT_ENV!=='sandbox'||process.env.PAWSPACE_PAYMENT_LIVE_APPROVED!=='false'||process.env.FORBID_PRODUCTION!=='true')throw new Error('This isolated beta test requires explicit sandbox-only locks');
const webhookSecret='beta-contract-only-'+randomUUID();
const fixtureKey='rzp_test_beta_contract';
const fixtureSecret='beta-contract-no-provider-credentials';
let providerRequest=null;
const orderId='order_beta'+randomUUID().replaceAll('-','');
const gatewayPaymentId='pay_beta'+randomUUID().replaceAll('-','');
const server=createServer(async (request,response)=>{
  try {
    assert.equal(request.method,'POST');assert.equal(request.url,'/v1/orders');
    assert.equal(request.headers.authorization,'Basic '+Buffer.from(fixtureKey+':'+fixtureSecret).toString('base64'));
    let data='';for await(const chunk of request){data+=chunk;if(data.length>16_384)throw new Error('Unexpected order body size');}
    providerRequest=JSON.parse(data);
    assert.ok(Number.isSafeInteger(providerRequest.amount)&&providerRequest.amount>0);
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({id:orderId,entity:'order',...providerRequest,status:'created',amount_paid:0,amount_due:providerRequest.amount,attempts:0,created_at:Math.floor(Date.now()/1000)}));
  } catch(error){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{description:error.message}}));}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const endpoint='http://127.0.0.1:'+server.address().port;
const realFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!==endpoint)throw new Error('External network disabled in isolated beta contract: '+url.origin);
  return realFetch(input,init);
};
let ctx;
try {
  ctx=await setupJourney();
  const {db,sqlite}=ctx;
  Object.assign(globalThis.__GROOM_GOLDEN_ENV__,{
    NODE_ENV:'test',APP_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_LOCAL_PREVIEW:'off',PAWSPACE_DEPLOYMENT_ENV:'e2e',
    RAZORPAY_KEY_ID_SANDBOX:fixtureKey,RAZORPAY_KEY_SECRET_SANDBOX:fixtureSecret,RAZORPAY_WEBHOOK_SECRET_SANDBOX:webhookSecret,
    PAWSPACE_RAZORPAY_API_BASE_URL:endpoint,PAWSPACE_PAYMENT_CONTRACT_TEST:'true',
  });
  const customerId='BETA-CUS-'+randomUUID(),petId='BETA-PET-'+randomUUID(),groupId='BETA-GRP-'+randomUUID();
  await seedOwnedPet(db,customerId,petId,'Beta Bruno');
  const cookie=await sessionCookie(db,'customer',customerId,'customer:'+customerId);
  async function call(path,body){
    const module=await import('../../app'+path+'/route.ts');
    const response=await module.POST(new Request('https://uat.pawspace.in'+path,{method:'POST',headers:{cookie,'content-type':'application/json',origin:'https://uat.pawspace.in'},body:JSON.stringify(body)}));
    const data=await response.json();
    assert.ok(response.ok,path+' '+response.status+' '+JSON.stringify(data));return data;
  }
  const {resolveZoneByPincode}=await import('../../lib/service-zones.ts');
  const coverage=await resolveZoneByPincode(db,'560038');
  assert.ok(coverage,'The existing isolated grooming fixture must provide Bangalore coverage');
  // Same Bangalore fixture window and catalogue used by the repository's existing grooming harness.
  const start=new Date(Date.now()+3*86400000);start.setUTCHours(4,30,0,0);
  const end=new Date(start.getTime()+2*3600000);
  const scheduled=await call('/api/uat-scheduling',{
    action:'reserve',assignmentStrategy:'auto',clientRequestId:groupId,customerId,petIds:[petId],serviceCode:'grooming',cityId:'blr',zoneId:'blr-east',
    serviceAddress:'100 Feet Road, Indiranagar, Bengaluru',servicePincode:'560038',scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),
  });
  assert.ok(scheduled.data?.provider?.id,'Actual scheduler must select a provider');
  const lease=sqlite.prepare('SELECT lease_expires_at,created_at FROM scheduling_reservations WHERE group_id=? LIMIT 1').get(groupId);
  assert.ok(lease?.lease_expires_at,'Reservation must have a lease');
  assert.ok(lease.lease_expires_at-lease.created_at<=300000&&lease.lease_expires_at>Date.now(),'Reservation must use a five-minute or shorter session-bounded lease');
  const booked=await call('/api/canonical-bookings',{
    idempotencyKey:groupId,scheduleGroupId:groupId,customer:{id:customerId,name:'Beta Test Customer',primaryPhone:'9800000999'},
    pets:[{sourceId:petId,name:'Beta Bruno',species:'dog',breed:'Indie',vaccinationStatus:'vaccinated'}],
    cityId:'blr',zoneId:'blr-east',serviceCode:'grooming',packageCode:'dog-basic',packageName:'Bath & Basic',
    scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),provider:scheduled.data.provider,totalAmount:1899,amountDueNow:1899,
    payment:{method:'upi',mode:'prepaid',status:'created',detail:'isolated beta contract'},pricing:{discount:0},
  });
  const bookingId=String(booked.data?.bookingId||'');assert.ok(bookingId);
  const booking=sqlite.prepare('SELECT id,total_amount,service_code,status FROM canonical_bookings WHERE id=?').get(bookingId);
  assert.equal(booking?.service_code,'grooming');assert.equal(booking.total_amount,1899);
  const {creditWallet}=await import('../../lib/pawspace-wallet-governance.ts');
  await creditWallet(db,{customerId,amount:500,source:'goodwill',sourceId:'beta-isolated-seed',idempotencyKey:'seed:'+customerId,note:'Isolated fixture credit, not a live staff grant',actorId:'beta-fixture'});
  const wallet=await call('/api/pawspace-wallet',{customerId,bookingId,walletAmount:500});
  assert.equal(wallet.data.walletUsed,500);assert.equal(wallet.data.bonus,50);assert.equal(wallet.data.appliedValue,550);
  const order=await call('/api/payment-order',{bookingId,customerId});
  assert.equal(order.data.connected,true);assert.equal(order.data.environment,'sandbox');assert.equal(order.data.orderId,orderId);
  const appliedCreditPaise=Math.round(wallet.data.appliedValue*100),bookingGrossPaise=Math.round(booking.total_amount*100);
  const gatewayCashPaise=bookingGrossPaise-appliedCreditPaise;
  assert.equal(providerRequest.amount,gatewayCashPaise);assert.equal(order.data.amountPaise,gatewayCashPaise);
  assert.equal(providerRequest.notes.booking_id,bookingId);
  const payment=sqlite.prepare('SELECT id,status FROM booking_payments WHERE booking_id=?').get(bookingId);
  assert.equal(payment.status,'created','Opening a provider order must not fabricate capture');
  const webhook=await import('../../app/api/razorpay-webhook/route.ts');
  async function callback(event,eventId,payload){
    const raw=JSON.stringify({event,created_at:Math.floor(Date.now()/1000),payload});
    const signature=createHmac('sha256',webhookSecret).update(raw).digest('hex');
    const response=await webhook.POST(new Request('https://uat.pawspace.in/api/razorpay-webhook',{method:'POST',headers:{'content-type':'application/json','x-razorpay-signature':signature,'x-razorpay-event-id':eventId},body:raw}));
    const body=await response.json();assert.ok(response.ok,'Signed '+event+': '+response.status+' '+JSON.stringify(body));
    assert.equal(body.ok,true);return body;
  }
  const capturedEntity={id:gatewayPaymentId,entity:'payment',order_id:orderId,amount:gatewayCashPaise,currency:'INR',status:'captured',captured:true,notes:{booking_id:bookingId}};
  await callback('payment.captured','evt_beta_capture_'+randomUUID(),{payment:{entity:capturedEntity}});
  const persisted=sqlite.prepare('SELECT status FROM booking_payments WHERE booking_id=?').get(bookingId);
  assert.equal(persisted.status,'captured');
  const ledger=sqlite.prepare("SELECT account_code,direction,amount_paise FROM journal_entries WHERE booking_id=?").all(bookingId);
  const debits=ledger.filter(r=>r.direction==='DEBIT').reduce((n,r)=>n+r.amount_paise,0);
  const credits=ledger.filter(r=>r.direction==='CREDIT').reduce((n,r)=>n+r.amount_paise,0);
  assert.equal(ledger.length,2);assert.equal(debits,gatewayCashPaise);assert.equal(credits,gatewayCashPaise);
  const financeRows=sqlite.prepare("SELECT debit,credit FROM finance_journal_entries WHERE payment_id=? AND source_type='online_payment_captured'").all(payment.id);
  assert.equal(financeRows.length,2);
  assert.equal(financeRows.reduce((n,r)=>n+Math.round(r.debit*100),0),gatewayCashPaise);
  assert.equal(financeRows.reduce((n,r)=>n+Math.round(r.credit*100),0),gatewayCashPaise);
  // A normal positive partial-refund completion checks the fourth financial wire, without a refund
  // API call, customer cancellation, fault injection, replay storm, or live money.
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const refundId='rfnd_beta'+randomUUID().replaceAll('-','');
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,gateway_reference,created_at,updated_at) VALUES (?,?,?,300,'isolated approved refund fixture','processing','beta-fixture','beta-checker',?,?,?)").run('case-'+refundId,bookingId,payment.id,refundId,Date.now(),Date.now());
  await callback('refund.processed','evt_beta_refund_'+randomUUID(),{refund:{entity:{id:refundId,payment_id:gatewayPaymentId,amount:30000,currency:'INR',status:'processed'}},payment:{entity:capturedEntity}});
  const {ACCT}=await import('../../lib/finance-accounts.ts');
  const reversal=sqlite.prepare("SELECT account_code,debit,credit FROM finance_journal_entries WHERE source_type='refund_completed' AND reversal_reference=?").all(refundId);
  assert.equal(reversal.length,2);assert.equal(reversal.find(r=>r.account_code===ACCT.REFUNDS).debit,300);assert.equal(reversal.find(r=>r.account_code===ACCT.GATEWAY_CLEARING).credit,300);
  console.log('BETA_GOLDEN_RESULT='+JSON.stringify({mode:'isolated_api_contract',externalProviderContacted:false,browserJourneyExecuted:false,bookingPersisted:true,bookingGrossPaise,appliedCreditPaise,gatewayCashPaise,paymentCaptured:true,captureJournalBalanced:true,refundJournalBalanced:true}));
} finally {
  globalThis.fetch=realFetch;
  if(ctx)ctx.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
