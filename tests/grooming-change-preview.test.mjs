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
test("owned preview uses frozen fees and captured payment without business mutations",async t=>{
 const f=await fixture(t);const row=f.sqlite.prepare("SELECT pricing_json FROM canonical_bookings WHERE id=?").get(f.result.bookingId),pricing=JSON.parse(row.pricing_json);
 pricing.commercialPolicy.enforcementMode="enforce";pricing.commercialPolicy.rescheduleFeeType="flat";pricing.commercialPolicy.rescheduleFeeValue=75;
 f.sqlite.prepare("UPDATE canonical_bookings SET pricing_json=? WHERE id=?").run(JSON.stringify(pricing),f.result.bookingId);
 f.sqlite.prepare("UPDATE grooming_commercial_policies SET reschedule_fee_type='flat',reschedule_fee_value=999").run();
 const tables=['canonical_bookings','provider_work_orders','booking_payments','scheduling_reservations','booking_lifecycle_events'];const snapshot=()=>tables.map(table=>f.sqlite.prepare(`SELECT * FROM ${table}`).all());const before=snapshot();
 const preview=await f.read();assert.equal(preview.status,200,JSON.stringify(preview.body));const data=preview.body.data;
 assert.equal(data.reschedule.feeAmount,75);assert.equal(data.durationMinutes,120);assert.equal(data.cancellation.mode,"cancel");assert.equal(data.cancellation.refundAmount,1899);assert.deepEqual(snapshot(),before);
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
