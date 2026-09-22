import test from "node:test";
import assert from "node:assert/strict";
import{setupJourney,runCompletedJourney,routeCall,sessionCookie}from"./helpers/grooming-journey-harness.mjs";
async function fixture(t){
 const ctx=await setupJourney();t.after(ctx.close);const start=new Date(Date.now()+3*86400000);start.setUTCHours(3,30,0,0);
 const result=await runCompletedJourney(ctx,{customerId:"PREVIEW-CUSTOMER",customerName:"Preview parent",phone:"+919900000616",petSourceId:"PREVIEW-PET",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"PREVIEW-GROUP",start:start.toISOString(),stopAfterCapture:true});
 const path=`/api/grooming-booking-change?bookingId=${encodeURIComponent(result.bookingId)}`;
 const read=(cookie=result.customerCookie)=>routeCall("../../app/api/grooming-booking-change/route.ts","GET",path,null,cookie);
 return{...ctx,result,path,read};
}
test("owned preview overrides legacy fees and captured payment without business mutations",async t=>{
 const f=await fixture(t);const row=f.sqlite.prepare("SELECT pricing_json FROM canonical_bookings WHERE id=?").get(f.result.bookingId),pricing=JSON.parse(row.pricing_json);
 pricing.commercialPolicy.enforcementMode="enforce";pricing.commercialPolicy.rescheduleFeeType="flat";pricing.commercialPolicy.rescheduleFeeValue=75;
 f.sqlite.prepare("UPDATE canonical_bookings SET pricing_json=? WHERE id=?").run(JSON.stringify(pricing),f.result.bookingId);
 f.sqlite.prepare("UPDATE grooming_commercial_policies SET reschedule_fee_type='flat',reschedule_fee_value=999").run();
 const tables=['canonical_bookings','provider_work_orders','booking_payments','scheduling_reservations','booking_lifecycle_events'];const snapshot=()=>tables.map(table=>f.sqlite.prepare(`SELECT * FROM ${table}`).all());const before=snapshot();
 const preview=await f.read();assert.equal(preview.status,200,JSON.stringify(preview.body));const data=preview.body.data;
 assert.equal(data.reschedule.feeAmount,0);assert.equal(data.durationMinutes,120);assert.equal(data.cancellation.mode,"cancel");assert.equal(data.cancellation.refundAmount,1899);assert.deepEqual(snapshot(),before);
});
test("unpaid bookings do not show an invented refund",async t=>{const f=await fixture(t);f.sqlite.prepare("UPDATE booking_payments SET status='pending' WHERE booking_id=?").run(f.result.bookingId);const p=await f.read();assert.equal(p.status,200);assert.equal(p.body.data.cancellation.refundAmount,0);});
test("started care previews review without opening a cancellation case",async t=>{
 const f=await fixture(t);f.sqlite.prepare("UPDATE canonical_bookings SET status='in_service' WHERE id=?").run(f.result.bookingId);f.sqlite.prepare("UPDATE provider_work_orders SET status='in_service' WHERE booking_id=?").run(f.result.bookingId);
 const before=f.sqlite.prepare("SELECT count(*) n FROM booking_lifecycle_events").get().n;const p=await f.read();assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.body.data.reschedule.allowed,false);assert.equal(p.body.data.cancellation.mode,"review");assert.equal(p.body.data.cancellation.refundAmount,null);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM booking_lifecycle_events").get().n,before);
});
test("another customer cannot read this booking's policy or payment basis",async t=>{const f=await fixture(t),other=await sessionCookie(f.db,"customer","OTHER-PREVIEW-CUSTOMER","customer:other-preview");const p=await f.read(other);assert.equal(p.status,403);assert.equal(p.body.data,undefined);});
test("preview gateway admits customer scope and refuses a provider scope",async t=>{
 const f=await fixture(t),{authorizePlatformSessionRequest}=await import("../lib/session-api-gateway.ts");
 const allowed=await authorizePlatformSessionRequest(new Request(`https://uat.pawspace.in${f.path}`,{headers:{cookie:f.result.customerCookie}}),f.db);assert.equal(allowed.permission,"scheduling.book");
 const provider=await sessionCookie(f.db,"provider","groom_arun","provider:preview-test");const denied=await authorizePlatformSessionRequest(new Request(`https://uat.pawspace.in${f.path}`,{headers:{cookie:provider}}),f.db);assert.equal(denied.status,403);
});
test("preview requires a booking ID and rejects unknown bookings",async t=>{const f=await fixture(t);for(const [path,status] of [["/api/grooming-booking-change",400],["/api/grooming-booking-change?bookingId=MISSING",404]]){const p=await routeCall("../../app/api/grooming-booking-change/route.ts","GET",path,null,f.result.customerCookie);assert.equal(p.status,status);}});

// ---------------------------------------------------------------------------------------------------
// Owner decision 2026-09-22: a customer MAY cancel a reservation they have not paid for. Until now an
// unpaid booking was the one thing they could not cancel - provider_work_orders.status='payment_pending'
// was missing from the allowed list, so the preview resolved "unavailable", grooming-cancel-form.tsx
// rendered nothing, and only support could release the slot.
//
// These cases drive the real preview and the real POST, then read the database back: the slot must
// actually be freed and no money may move, because there was none to move.
// ---------------------------------------------------------------------------------------------------

test("a customer can cancel an unpaid grooming reservation, and the slot is released", async t => {
  const f = await fixture(t);
  // Put the booking back into the state a customer reaches by booking and not paying.
  f.sqlite.prepare("UPDATE provider_work_orders SET status='payment_pending' WHERE booking_id=?").run(f.result.bookingId);
  f.sqlite.prepare("UPDATE canonical_bookings SET status='payment_pending' WHERE id=?").run(f.result.bookingId);
  f.sqlite.prepare("UPDATE booking_payments SET status='created' WHERE booking_id=?").run(f.result.bookingId);

  const preview = await f.read();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.cancellation.mode, "cancel", "an unpaid booking must offer cancellation");

  const cancelled = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change",
    { bookingId: f.result.bookingId, customerId: "PREVIEW-CUSTOMER", action: "cancel", reason: "Plans changed before paying", consentRevision: preview.body.data.consentRevision },
    f.result.customerCookie);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  assert.equal(f.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(f.result.bookingId).status, "cancelled");
  assert.equal(f.sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(f.result.bookingId).status, "cancelled");
  const held = f.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=(SELECT schedule_group_id FROM canonical_bookings WHERE id=?) AND status NOT IN ('cancelled','completed')").get(f.result.bookingId).n;
  assert.equal(held, 0, "the slot must be released, not left holding the provider");
});

test("cancelling an unpaid grooming reservation moves no money and opens no refund case", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE provider_work_orders SET status='payment_pending' WHERE booking_id=?").run(f.result.bookingId);
  f.sqlite.prepare("UPDATE canonical_bookings SET status='payment_pending' WHERE id=?").run(f.result.bookingId);
  f.sqlite.prepare("UPDATE booking_payments SET status='created' WHERE booking_id=?").run(f.result.bookingId);

  const preview = await f.read();
  assert.equal(preview.body.data.cancellation.refundAmount ?? 0, 0, "an uncaptured payment can refund nothing");

  // The refund-case table is created lazily, only when a case is actually opened - so "still absent"
  // is a stronger result than "count unchanged". Count either way.
  const refundCases = () => {
    const exists = f.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='booking_refund_cases'").get().n;
    return exists ? f.sqlite.prepare("SELECT COUNT(*) n FROM booking_refund_cases").get().n : 0;
  };
  const before = refundCases();
  const cancelled = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change",
    { bookingId: f.result.bookingId, customerId: "PREVIEW-CUSTOMER", action: "cancel", reason: "Plans changed before paying", consentRevision: preview.body.data.consentRevision },
    f.result.customerCookie);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  assert.equal(refundCases(), before, "no refund case may be opened for money never taken");
  const payment = f.sqlite.prepare("SELECT status,amount FROM booking_payments WHERE booking_id=?").get(f.result.bookingId);
  assert.notEqual(payment.status, "captured", "cancelling must never capture");
  assert.notEqual(payment.status, "refund_pending", "there is nothing to refund");
});

test("a booking whose provider has already started is still refused, so the new state is not a blanket pass", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE provider_work_orders SET status='on_the_way' WHERE booking_id=?").run(f.result.bookingId);
  const preview = await f.read();
  assert.notEqual(preview.body.data.cancellation.mode, "cancel", "an in-progress job must not become customer-cancellable");
});
