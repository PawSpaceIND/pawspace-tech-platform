import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney,routeCall,sessionCookie} from "./helpers/grooming-journey-harness.mjs";
import {fixtureChecklist} from "./helpers/partner-checklist-fixture.mjs";
test("grooming API refuses missing before checklist without changing job state",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);
 const start=new Date(Date.now()+9*86400000);start.setUTCHours(5,30,0,0);
 const job=await runCompletedJourney(ctx,{customerId:"PHASE3-CUSTOMER",customerName:"Phase Three",phone:"+919900000707",petSourceId:"PHASE3-PET",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"PHASE3-GROUP",start:start.toISOString(),stopAfterCapture:true});
 const cookie=await sessionCookie(ctx.db,"provider",job.provider.id,`provider:${job.provider.id}`);
 const step=(action,checklist)=>routeCall("../../app/api/grooming-lifecycle/route.ts","POST","/api/grooming-lifecycle",{bookingId:job.bookingId,action,checklist},cookie);
 for(const action of ["accept","on_the_way","arrived"]){const result=await step(action);assert.equal(result.status,200,JSON.stringify(result.body));}
 const {POST}=await import("../app/api/grooming-lifecycle/route.ts");
 const response=await POST(new Request("http://localhost/api/grooming-lifecycle",{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({bookingId:job.bookingId,action:"start_service",checklist:[]})}));
 const blocked={status:response.status,body:await response.json()};assert.equal(blocked.status,409);assert.equal(blocked.body.code,"before_checklist_required");assert.equal(ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(job.bookingId).status,"arrived");
 const started=await step("start_service",fixtureChecklist("start_service"));assert.equal(started.status,200,JSON.stringify(started.body));
 const complete=await step("complete",[]);assert.equal(complete.status,409);assert.equal(complete.body.code,"after_checklist_required");
 // Checkmarks alone cannot bypass the independent media evidence gate.
 const noPhotos=await step("complete",fixtureChecklist("complete"));assert.equal(noPhotos.status,409);assert.match(noPhotos.body.error,/photo/i);
});
