import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";
installWorkersHooks("__CUSTOMER_CHECKOUT_GATEWAY_DB__", "__CUSTOMER_CHECKOUT_GATEWAY_ENV__");

// CUST-L-D04 / CUST-L-D11: POST /api/customer-checkout called customerCheckoutEnvironment(runtime) —
// the Razorpay sandbox-key configuration gate — unconditionally, before even looking at body.action.
// {action:"status"} is a pure read of PawSpace's own canonical_bookings/booking_payments record; it
// opens no gateway order and needs no Razorpay key. Gating it behind the SAME check as {action:"start"}
// meant a missing/placeholder Razorpay key 503'd every booking-status read too, which is what emptied
// /v2/booking (View booking & payment, reached from /v2/activity) and the /v2/training?bookingId=
// recovery screen down to the gateway error alone. The booking record must render from PawSpace's own
// data regardless of gateway configuration; only actually starting a payment needs the gateway.

const ORIGIN = "https://checkout-gateway.pawspace.test";
const UNCONFIGURED_ENV = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" }; // no Razorpay keys at all

function world(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,service_code TEXT DEFAULT 'dog_training',package_code TEXT DEFAULT 'training-programme',package_name TEXT DEFAULT 'Training programme',provider_id TEXT DEFAULT 'TRN1',scheduled_start TEXT DEFAULT '2026-09-20T03:30:00.000Z',scheduled_end TEXT DEFAULT '2026-09-20T05:30:00.000Z',total_amount REAL DEFAULT 3499,currency TEXT DEFAULT 'INR',updated_at INTEGER DEFAULT 1);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,status TEXT,amount REAL,amount_due_now REAL,currency TEXT,mode TEXT DEFAULT 'prepaid');
    CREATE TABLE provider_work_orders(id TEXT PRIMARY KEY,booking_id TEXT,provider_name TEXT,provider_model TEXT,status TEXT);
    INSERT INTO canonical_bookings(id,customer_id,status) VALUES('BK-GW-1','CUST-GW-1','payment_pending');
    INSERT INTO booking_payments(id,booking_id,customer_id,status,amount,amount_due_now,currency) VALUES('PAY-GW-1','BK-GW-1','CUST-GW-1','created',3499,3499,'INR');
    INSERT INTO provider_work_orders VALUES('WO-GW-1','BK-GW-1','Priya Trainer','full_time','assigned');`);
  const db = d1(sqlite);
  enterWorkersDbScope(db);
  globalThis.__CUSTOMER_CHECKOUT_GATEWAY_DB__ = db;
  globalThis.__CUSTOMER_CHECKOUT_GATEWAY_ENV__ = { ...UNCONFIGURED_ENV };
  return { sqlite, db };
}

async function cookie(db, subjectId = "CUST-GW-1") {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${subjectId}`,
    subjectType: "customer", subjectId, actorId: "checkout-gateway-independence-test", reason: "regression fixture",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: binding.id, identitySource: "customer_otp", principalType: "identity_subject",
    principalKey: `customer:${subjectId}`, subjectType: "customer", subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

function request(body, session) {
  return new Request(`${ORIGIN}/api/customer-checkout`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: session },
    body: JSON.stringify(body),
  });
}

test("status reads the owned booking record even with no Razorpay sandbox key configured", async (t) => {
  const { db } = world(t);
  const session = await cookie(db);
  const { POST } = await import("../app/api/customer-checkout/route.ts");
  const response = await POST(request({ action: "status", bookingId: "BK-GW-1" }, session));
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const body = JSON.parse(raw);
  assert.equal(body.data.confirmation.bookingId, "BK-GW-1");
  assert.equal(body.data.confirmation.serviceCode, "dog_training");
  assert.equal(body.data.confirmation.bookingStatus, "payment_pending");
  assert.equal(body.data.confirmation.providerName, "Priya Trainer");
  assert.equal(body.data.confirmation.totalAmount, 3499);
});

test("start still refuses with the honest gateway-configuration message when Razorpay is unconfigured", async (t) => {
  const { db } = world(t);
  const session = await cookie(db);
  const { POST } = await import("../app/api/customer-checkout/route.ts");
  const response = await POST(request({ action: "start", bookingId: "BK-GW-1" }, session));
  const raw = await response.text();
  assert.equal(response.status, 503, raw);
  assert.match(JSON.parse(raw).error, /Razorpay test checkout is not configured/);
});

for(const [name,status,mode,total,due,expected] of [
 ['completed unpaid pay-after','created','pay_after_service',1146.65,0,'nothing_due'],
 ['zero total is not capture','created','prepaid',0,0,'nothing_due'],
 ['refund is not current capture','refunded','prepaid',3499,0,'nothing_due'],
 ['unpaid deposit remains pending','created','split',3499,1749.5,'awaiting_confirmation'],
 ['Finance captured pay-after','captured','pay_after_service',1146.65,0,'captured']
])test(name,async t=>{
 const {db,sqlite}=world(t);sqlite.prepare("UPDATE canonical_bookings SET status='completed',total_amount=?").run(total);
 sqlite.prepare('UPDATE booking_payments SET status=?,mode=?,amount=?,amount_due_now=?').run(status,mode,total,due);
 const session=await cookie(db);const {POST}=await import('../app/api/customer-checkout/route.ts');const response=await POST(request({action:'status',bookingId:'BK-GW-1'},session));const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.data.status,expected);assert.equal(body.data.confirmation.paymentStatus,status);
 if(mode==='pay_after_service')assert.equal(body.data.confirmation.ready,true,'booking eligibility unchanged');
});

test('nothing due status never capture-latches or redirects and can reread later capture',async()=>{
 const {CustomerCheckoutController}=await import('../lib/customer-checkout-client.ts');let calls=0;let status='nothing_due';const states=[];
 const c=new CustomerCheckoutController('BK-GW-1',s=>states.push(s),{fetch:async()=>{calls++;return new Response(JSON.stringify({data:{bookingId:'BK-GW-1',environment:'sandbox',status}}))},open:async()=>{throw new Error('No gateway allowed')}});
 await c.resume();assert.equal(states.at(-1).phase,'nothing_due');assert.equal(await c.probeStatus(),'nothing_due');assert.equal(calls,2);
 status='captured';await c.resume();assert.equal(calls,3);assert.equal(states.at(-1).phase,'captured');await c.resume();assert.equal(calls,3,'only actual capture latches');
});
test('start nothing due does not latch future collection or open gateway',async()=>{
 const {CustomerCheckoutController}=await import('../lib/customer-checkout-client.ts');let calls=0;const states=[];
 const c=new CustomerCheckoutController('BK-GW-1',s=>states.push(s),{fetch:async()=>{calls++;return new Response(JSON.stringify({data:{bookingId:'BK-GW-1',environment:'sandbox',status:'nothing_due',connected:false}}))},open:async()=>{throw new Error('No gateway allowed')}});
 await c.start();assert.equal(states.at(-1).phase,'nothing_due');await c.resume();assert.equal(calls,2);assert.ok(states.every(s=>s.phase!=='captured'));
});

test('trusted prepaid capture is retained, created payment cannot adopt unrelated capture',async t=>{
 const {db,sqlite}=world(t);sqlite.exec(`CREATE TABLE payment_gateway_events(id TEXT,booking_id TEXT,payment_id TEXT,gateway_order_id TEXT,gateway_payment_id TEXT,signature_verified INTEGER,detail_json TEXT,processing_status TEXT,event_type TEXT,received_at INTEGER,provider TEXT,environment TEXT);
 INSERT INTO payment_gateway_events VALUES('EV','BK-GW-1','PAY-GW-1','order_trusted','pay_trusted',1,'{}','processed','payment.captured',1,'razorpay','sandbox');
 UPDATE canonical_bookings SET status='confirmed';UPDATE booking_payments SET status='captured';`);
 const session=await cookie(db);const {POST}=await import('../app/api/customer-checkout/route.ts');let body=await(await POST(request({action:'status',bookingId:'BK-GW-1'},session))).json();assert.equal(body.data.status,'captured');assert.equal(body.data.confirmation.transactionId,'pay_trusted');assert.equal(body.data.confirmation.ready,true);
 sqlite.exec("UPDATE booking_payments SET status='created',amount_due_now=0");body=await(await POST(request({action:'status',bookingId:'BK-GW-1'},session))).json();assert.equal(body.data.status,'nothing_due');assert.equal(body.data.confirmation.ready,false);
});
test('applied wallet credit makes nothing due but does not manufacture capture',async t=>{
 const {db,sqlite}=world(t);sqlite.exec(`CREATE TABLE pawspace_wallet_ledger(source_id TEXT,entry_type TEXT,source_type TEXT,applied_value REAL);INSERT INTO pawspace_wallet_ledger VALUES('BK-GW-1','redeem','booking',3499);`);
 const session=await cookie(db);const {POST}=await import('../app/api/customer-checkout/route.ts');const body=await(await POST(request({action:'status',bookingId:'BK-GW-1'},session))).json();assert.equal(body.data.status,'nothing_due');assert.equal(body.data.confirmation.amountDueNow,0);assert.equal(body.data.confirmation.paymentStatus,'created');
});
