import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney,routeCall} from "./helpers/grooming-journey-harness.mjs";

async function fixture(t){
 const ctx=await setupJourney();t.after(ctx.close);
 const start=new Date(Date.now()+3*86400000);start.setUTCHours(3,30,0,0);
 const config={customerId:"CUST-RESCHEDULE-ATOMIC",customerName:"Mira",phone:"+919900000515",petSourceId:"PET-RESCHEDULE",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"GROOM-RESCHEDULE-ATOMIC",start:start.toISOString(),stopAfterCapture:true};
 const result=await runCompletedJourney(ctx,config);
 const target=new Date(start);target.setUTCHours(7,30,0,0);
 const input={bookingId:result.bookingId,customerId:config.customerId,action:"reschedule",reason:"Customer needs a later time",scheduledStart:target.toISOString(),scheduledEnd:new Date(target.getTime()+7200000).toISOString()};
 const call=()=>routeCall("../../app/api/grooming-booking-change/route.ts","POST","/api/grooming-booking-change",input,result.customerCookie);
 const snapshot=()=>({booking:ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end,status FROM canonical_bookings WHERE id=?").get(result.bookingId),work:ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end,status FROM provider_work_orders WHERE booking_id=?").get(result.bookingId),reservations:ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end,status FROM scheduling_reservations WHERE group_id=? ORDER BY id").all(config.groupId),events:ctx.sqlite.prepare("SELECT count(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_rescheduled'").get(result.bookingId).n,audits:ctx.sqlite.prepare("SELECT count(*) n FROM security_audit_events WHERE resource_id=? AND action='grooming.reschedule'").get(result.bookingId).n});
 return {...ctx,result,input,call,snapshot};
}
for(const [table,event] of [["provider_work_orders","UPDATE"],["scheduling_assignment_decisions","UPDATE"],["booking_lifecycle_events","INSERT"],["security_audit_events","INSERT"]]){
 test(`reschedule rolls back capacity, booking and work when ${table} fails`,async t=>{
  const f=await fixture(t),before=f.snapshot();
  f.sqlite.exec(`CREATE TEMP TRIGGER reject_change BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'Injected reschedule write failure'); END;`);
  const response=await f.call();assert.equal(response.status,500,JSON.stringify(response.body));
  assert.deepEqual(f.snapshot(),before,"failed request must not split the persisted schedule or claim a successful change");
 });
}
test("a successful reschedule persists capacity, booking, work and evidence together",async t=>{
 const f=await fixture(t),before=f.snapshot(),response=await f.call();assert.equal(response.status,200,JSON.stringify(response.body));const after=f.snapshot();
 assert.equal(after.booking.scheduled_start,f.input.scheduledStart);assert.equal(after.work.scheduled_start,f.input.scheduledStart);assert.ok(after.reservations.every(row=>row.scheduled_start===f.input.scheduledStart));assert.equal(after.events,before.events+1);assert.equal(after.audits,before.audits+1);
});
test("a provider starting service before the reschedule commit is not reset to assigned",async t=>{
 const f=await fixture(t),before=f.snapshot();let injected=false;
 f.db.beforeBatch=items=>{if(injected||!items.some(item=>item._sql.includes("UPDATE canonical_bookings SET scheduled_start")))return;injected=true;
  f.sqlite.prepare("UPDATE canonical_bookings SET status='in_service' WHERE id=?").run(f.result.bookingId);
  f.sqlite.prepare("UPDATE provider_work_orders SET status='in_service' WHERE booking_id=?").run(f.result.bookingId);
 };
 const response=await f.call();assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(injected,true);const after=f.snapshot();
 assert.equal(after.booking.status,"in_service");assert.equal(after.work.status,"in_service");assert.equal(after.booking.scheduled_start,before.booking.scheduled_start);assert.deepEqual(after.reservations,before.reservations);assert.equal(after.events,before.events);assert.equal(after.audits,before.audits);
});

test("a competing reservation before commit leaves the old booking schedule intact",async t=>{
 const f=await fixture(t),before=f.snapshot();let injected=false;
 f.db.beforeBatch=items=>{if(injected||!items.some(item=>item._sql.includes("UPDATE canonical_bookings SET scheduled_start")))return;injected=true;
  f.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('CONCURRENT-SLOT','OTHER-GROUP','groom_arun','grooming','blr','blr-east','OTHER-CUSTOMER','[]',?,?,1,1,NULL,'assigned','{}',?)").run(f.input.scheduledStart,f.input.scheduledEnd,Date.now());
 };
 const response=await f.call();assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(injected,true);assert.deepEqual(f.snapshot(),before);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM scheduling_reservations WHERE id='CONCURRENT-SLOT'").get().n,1);
});
test("an already started Grooming service cannot be reset by a customer reschedule",async t=>{
 const f=await fixture(t);f.sqlite.prepare("UPDATE provider_work_orders SET status='on_the_way' WHERE booking_id=?").run(f.result.bookingId);const before=f.snapshot();
 const response=await f.call();assert.equal(response.status,409,JSON.stringify(response.body));assert.deepEqual(f.snapshot(),before);
});
