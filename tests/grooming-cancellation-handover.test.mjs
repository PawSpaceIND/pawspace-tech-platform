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


test("cancellation refuses a work order already travelling even if canonical status is stale",async t=>{
 const f=await fixture(t);f.sqlite.prepare("UPDATE provider_work_orders SET status='on_the_way' WHERE booking_id=?").run(f.result.bookingId);const before=f.snapshot();const{groomingChangePreview}=await import("../lib/grooming-change-preview.ts");const booking=f.sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(f.result.bookingId),work=f.sqlite.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").get(f.result.bookingId);assert.equal((await groomingChangePreview(f.db,booking,work,before.payments[0])).cancellation.mode,"unavailable");const response=await f.call();assert.equal(response.status,409,JSON.stringify(response.body));assert.deepEqual(f.snapshot(),before);
});
test("customer cancellation closes the pending commission offer",async t=>{
 const f=await fixture(t),group=f.result.bookingPayload.scheduleGroupId;
 const{routeCall,sessionCookie}=await import("./helpers/grooming-journey-harness.mjs");
 const row=f.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").get(group),shortlist=JSON.parse(row.shortlist_json);shortlist.choices=shortlist.choices.filter(choice=>choice.provider.model==="commission");assert.ok(shortlist.choices.length);f.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?").run(JSON.stringify(shortlist),group);
 const recovery=await routeCall("../../app/api/provider-assignment-recovery/route.ts","POST","/api/provider-assignment-recovery",{bookingId:f.result.bookingId,providerId:f.result.provider.id,action:"unavailable",reason:"Commission cancellation test"});assert.equal(recovery.status,200,JSON.stringify(recovery.body));assert.equal(recovery.body.data.status,"awaiting_acceptance");
 const before=f.snapshot();f.sqlite.exec("CREATE TEMP TRIGGER reject_handover_audit BEFORE INSERT ON security_audit_events BEGIN SELECT RAISE(ABORT,'Injected handover audit failure'); END;");const failed=await f.call();assert.equal(failed.status,500);assert.deepEqual(f.snapshot(),before);assert.equal(f.sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id=?").get(group).status,"pending");f.sqlite.exec("DROP TRIGGER reject_handover_audit");
 const result=await f.call();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id=?").get(group).status,"cancelled");
 const providerId=recovery.body.data.replacement.id,cookie=await sessionCookie(f.db,"provider",providerId,`provider:${providerId}`);const accepted=await routeCall("../../app/api/provider-assignment-recovery/route.ts","POST","/api/provider-assignment-recovery",{bookingId:f.result.bookingId,providerId,action:"accept"},cookie);assert.equal(accepted.status,409,JSON.stringify(accepted.body));assert.equal(f.snapshot().booking.status,"cancelled");
});
