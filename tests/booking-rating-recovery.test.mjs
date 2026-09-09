import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney,sessionCookie} from "./helpers/grooming-journey-harness.mjs";
async function fixture(t){
 const ctx=await setupJourney();t.after(ctx.close);const start=new Date(Date.now()+3*86400000);start.setUTCHours(3,30,0,0);
 const result=await runCompletedJourney(ctx,{customerId:"PREVIEW-CUSTOMER",customerName:"Preview parent",phone:"+919900000616",petSourceId:"PREVIEW-PET",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"PREVIEW-GROUP",start:start.toISOString()});
 const cookie=await sessionCookie(ctx.db,"customer","PREVIEW-CUSTOMER","customer:PREVIEW-CUSTOMER");
 const {ensureBookingRatingTables}=await import("../lib/booking-rating.ts");await ensureBookingRatingTables(ctx.db);
 const call=async()=>{const {POST}=await import("../app/api/booking-rating/route.ts");const response=await POST(new Request("https://uat.pawspace.in/api/booking-rating",{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({bookingId:result.bookingId,stars:4,comment:"Care was good"})}));return{status:response.status,body:await response.json()};};
 const snapshot=()=>({ratings:ctx.sqlite.prepare("SELECT * FROM booking_ratings WHERE booking_id=?").all(result.bookingId),score:ctx.sqlite.prepare("SELECT rating,quality_score FROM provider_capacity_profiles WHERE id='groom_arun'").get(),audits:ctx.sqlite.prepare("SELECT count(*) n FROM security_audit_events WHERE action='booking.rating.submit'").get().n});
 return{...ctx,result,call,snapshot};
}
for(const [name,trigger]of[
 ["provider score","CREATE TEMP TRIGGER reject_rating BEFORE UPDATE OF rating ON provider_capacity_profiles BEGIN SELECT RAISE(ABORT,'Injected rating score failure'); END;"],
 ["security audit","CREATE TEMP TRIGGER reject_rating BEFORE INSERT ON security_audit_events WHEN NEW.action='booking.rating.submit' BEGIN SELECT RAISE(ABORT,'Injected rating audit failure'); END;"]
])test(`rating rolls back when ${name} fails and retry records one review`,async t=>{const f=await fixture(t),before=f.snapshot();f.sqlite.exec(trigger);const failed=await f.call();assert.equal(failed.status,500);assert.deepEqual(f.snapshot(),before);f.sqlite.exec("DROP TRIGGER reject_rating");const retry=await f.call();assert.equal(retry.status,201,JSON.stringify(retry.body));const after=f.snapshot();assert.equal(after.ratings.length,1);assert.equal(after.score.rating,4);assert.equal(after.audits,before.audits+1);});
