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


async function preview(f){const{groomingChangePreview}=await import("../lib/grooming-change-preview.ts");return groomingChangePreview(f.db,f.sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(f.result.bookingId),f.sqlite.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").get(f.result.bookingId),f.snapshot().payments[0]);}
test("unchanged accepted policy preview allows cancellation",async t=>{const f=await fixture(t),a=await preview(f),b=await preview(f);assert.match(a.consentRevision,/^[a-f0-9]{64}$/);assert.equal(a.consentRevision,b.consentRevision);f.input.expectedConsentRevision=a.consentRevision;const r=await f.call();assert.equal(r.status,200,JSON.stringify(r.body));});
test("a changed refund basis refuses old consent without changing the booking",async t=>{const f=await fixture(t);f.input.expectedConsentRevision=(await preview(f)).consentRevision;f.sqlite.prepare("UPDATE booking_payments SET amount=amount-100 WHERE booking_id=?").run(f.result.bookingId);const before=f.snapshot(),r=await f.call();assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.code,"booking_change_terms_changed");assert.deepEqual(f.snapshot(),before);});
test("partner progress refuses old consent before opening a review case",async t=>{const f=await fixture(t);f.input.expectedConsentRevision=(await preview(f)).consentRevision;f.sqlite.prepare("UPDATE canonical_bookings SET status='in_service' WHERE id=?").run(f.result.bookingId);f.sqlite.prepare("UPDATE provider_work_orders SET status='in_service' WHERE booking_id=?").run(f.result.bookingId);const before=f.snapshot(),r=await f.call();assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.code,"booking_change_terms_changed");assert.equal(r.body.caseId,undefined);assert.deepEqual(f.snapshot(),before);});
