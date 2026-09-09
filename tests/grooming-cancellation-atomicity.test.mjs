import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney} from "./helpers/grooming-journey-harness.mjs";

async function fixture(t){
 const ctx=await setupJourney();t.after(ctx.close);
 const start=new Date(Date.now()+3*86400000);start.setUTCHours(3,30,0,0);
 const config={customerId:"CUST-RESCHEDULE-ATOMIC",customerName:"Mira",phone:"+919900000515",petSourceId:"PET-RESCHEDULE",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"GROOM-RESCHEDULE-ATOMIC",start:start.toISOString(),stopAfterCapture:true};
 const result=await runCompletedJourney(ctx,config);
 const target=new Date(start);target.setUTCHours(7,30,0,0);
 const input={bookingId:result.bookingId,customerId:config.customerId,action:"reschedule",reason:"Customer needs a later time",scheduledStart:target.toISOString(),scheduledEnd:new Date(target.getTime()+7200000).toISOString()};
 input.action="cancel";
 const call=async()=>{const{POST}=await import("../app/api/grooming-booking-change/route.ts");const response=await POST(new Request("https://uat.pawspace.in/api/grooming-booking-change",{method:"POST",headers:{cookie:result.customerCookie,"content-type":"application/json"},body:JSON.stringify(input)}));return{status:response.status,body:await response.json()};};
 const snapshot=()=>({payments:ctx.sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id=?").all(result.bookingId),booking:ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end,status FROM canonical_bookings WHERE id=?").get(result.bookingId),work:ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end,status FROM provider_work_orders WHERE booking_id=?").get(result.bookingId),reservations:ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end,status FROM scheduling_reservations WHERE group_id=? ORDER BY id").all(config.groupId),events:ctx.sqlite.prepare("SELECT count(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_cancelled'").get(result.bookingId).n,audits:ctx.sqlite.prepare("SELECT count(*) n FROM security_audit_events WHERE resource_id=? AND action='grooming.cancel'").get(result.bookingId).n});
 return {...ctx,result,input,call,snapshot};
}

for(const table of ["booking_lifecycle_events","security_audit_events"]){
 test(`cancellation rolls back booking and payment when ${table} fails`,async t=>{
 const f=await fixture(t),before=f.snapshot();
 f.sqlite.exec(`CREATE TEMP TRIGGER reject_cancel BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Injected cancellation evidence failure'); END;`);
 const response=await f.call();assert.equal(response.status,500,JSON.stringify(response.body));assert.deepEqual(f.snapshot(),before);
 });
}
test("partner starting care before cancellation commit preserves active service",async t=>{
 const f=await fixture(t),before=f.snapshot();let injected=false;
 f.db.beforeBatch=items=>{if(injected||!items.some(item=>item._sql.includes("UPDATE canonical_bookings SET status='cancelled'")))return;injected=true;
 f.sqlite.prepare("UPDATE canonical_bookings SET status='in_service' WHERE id=?").run(f.result.bookingId);
 f.sqlite.prepare("UPDATE provider_work_orders SET status='in_service' WHERE booking_id=?").run(f.result.bookingId);
 };
 const response=await f.call();assert.equal(injected,true);assert.equal(response.status,409,JSON.stringify(response.body));const after=f.snapshot();assert.equal(after.booking.status,"in_service");assert.equal(after.work.status,"in_service");assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.reservations,before.reservations);
});

test("a changed captured payment refuses stale refund evaluation",async t=>{
 const f=await fixture(t),before=f.snapshot();let injected=false;
 f.db.beforeBatch=items=>{if(injected||!items.some(item=>item._sql.includes("UPDATE canonical_bookings SET status='cancelled'")))return;injected=true;f.sqlite.prepare("UPDATE booking_payments SET amount=amount+100 WHERE booking_id=?").run(f.result.bookingId);};
 const response=await f.call();assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(injected,true);assert.deepEqual(f.snapshot().booking,before.booking);assert.deepEqual(f.snapshot().reservations,before.reservations);assert.equal(f.snapshot().payments[0].amount,before.payments[0].amount+100);
});
test("successful cancellation persists one refund case and repeated cancellation cannot duplicate it",async t=>{
 const f=await fixture(t),response=await f.call();assert.equal(response.status,200,JSON.stringify(response.body));const after=f.snapshot();assert.equal(after.booking.status,"cancelled");assert.equal(after.work.status,"cancelled");assert.equal(after.events,1);assert.equal(after.audits,1);assert.equal(after.payments[0].status,"refund_pending");
 const cases=()=>f.sqlite.prepare("SELECT * FROM booking_refund_cases WHERE booking_id=?").all(f.result.bookingId);const first=cases();assert.equal(first.length,1);assert.equal(first[0].amount,1899);
 const repeated=await f.call();assert.equal(repeated.status,409,JSON.stringify(repeated.body));assert.deepEqual(f.snapshot(),after);assert.deepEqual(cases(),first);
});
