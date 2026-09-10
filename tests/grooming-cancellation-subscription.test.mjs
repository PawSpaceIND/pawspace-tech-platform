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


async function subscribed(t){const f=await fixture(t),now=Date.now();
 f.sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES ('SUB-CANCEL',?,'plan','grooming',6,3,0,'active',?,?,'OTHER-SOURCE','v1',?,?)").run(f.input.customerId,now,now+864000000,now,now);
 f.sqlite.prepare("INSERT INTO booking_subscription_usage (id,booking_id,customer_id,plan_code,sessions_reserved,sessions_consumed,status,created_at,updated_at) VALUES ('USE-CANCEL',?,?,'SUB-CANCEL',2,0,'reserved',?,?)").run(f.result.bookingId,f.input.customerId,now,now);return f;}
const usage=f=>f.sqlite.prepare("SELECT * FROM booking_subscription_usage WHERE id='USE-CANCEL'").get();
const sub=f=>f.sqlite.prepare("SELECT * FROM customer_grooming_subscriptions WHERE id='SUB-CANCEL'").get();
test("cancellation refuses changed subscription reservations before committing",async t=>{
 const f=await subscribed(t),before=f.snapshot();let injected=false;
 f.db.beforeBatch=items=>{if(injected||!items.some(item=>item._sql.includes("UPDATE canonical_bookings SET status='cancelled'")))return;injected=true;f.sqlite.exec("UPDATE booking_subscription_usage SET sessions_reserved=1 WHERE id='USE-CANCEL'; UPDATE customer_grooming_subscriptions SET sessions_reserved=2 WHERE id='SUB-CANCEL';");};
 const r=await f.call();assert.equal(injected,true);assert.equal(r.status,409,JSON.stringify(r.body));assert.deepEqual(f.snapshot(),before);assert.equal(usage(f).sessions_reserved,1);assert.equal(sub(f).sessions_reserved,2);
});
test("a missing linked subscription cannot report successful credit release",async t=>{const f=await subscribed(t);f.sqlite.exec("DELETE FROM customer_grooming_subscriptions WHERE id='SUB-CANCEL'");const before=f.snapshot(),u=usage(f),r=await f.call();assert.equal(r.status,409,JSON.stringify(r.body));assert.deepEqual(f.snapshot(),before);assert.deepEqual(usage(f),u);});
test("cancellation releases only this booking's credits and preserves other bookings",async t=>{const f=await subscribed(t),r=await f.call();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(usage(f).sessions_reserved,0);assert.equal(usage(f).status,"reversed");assert.equal(sub(f).sessions_reserved,1);assert.equal(sub(f).status,"active");assert.equal(r.body.data.subscriptionSessionsReleased,2);});
