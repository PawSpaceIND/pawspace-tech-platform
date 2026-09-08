import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney} from "./helpers/grooming-journey-harness.mjs";
async function recover(body){const {POST}=await import("../app/api/provider-assignment-recovery/route.ts");const response=await POST(new Request("https://uat.pawspace.in/api/provider-assignment-recovery",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-email":"closure-admin@pawspace.test"},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};}
function config(){const start=new Date(Date.now()+9*86400000);start.setUTCHours(5,30,0,0);return {customerId:"OPS-BOUNDARY-CUSTOMER",customerName:"Recovery test parent",phone:"+919900000707",petSourceId:"OPS-BOUNDARY-PET",petName:"Test dog",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"OPS-BOUNDARY-GROUP",start:start.toISOString(),stopAfterCapture:true};}
const tables=["canonical_bookings","provider_work_orders","booking_payments","scheduling_reservations","scheduling_assignment_decisions","provider_assignment_offers","booking_lifecycle_events"];
function snapshot(sqlite){return Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table}`).all()]));}

for(const action of ["accept","decline","timeout","unavailable","no_show"])test(`completed Grooming job refuses ${action} without rewriting its history`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const job=await runCompletedJourney(ctx,{...config(),stopAfterCapture:false});const before=snapshot(ctx.sqlite);
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action,reason:"Controlled completed-job test"});assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,"RECOVERY_STATE_CONFLICT");assert.deepEqual(snapshot(ctx.sqlite),before);
});
for(const state of ["cancelled","in_progress"])test(`Grooming recovery does not overwrite ${state} work`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const job=await runCompletedJourney(ctx,config());ctx.sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id=?").run(state,job.bookingId);ctx.sqlite.prepare("UPDATE provider_work_orders SET status=? WHERE booking_id=?").run(state,job.bookingId);const before=snapshot(ctx.sqlite);
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Controlled state boundary"});assert.equal(result.status,409);assert.deepEqual(snapshot(ctx.sqlite),before);
});
test("completion during replacement selection rolls back every stale recovery write",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const job=await runCompletedJourney(ctx,config());let before;
 ctx.db.beforeBatch=async statements=>{if(!statements.some(s=>s._sql.includes("UPDATE canonical_bookings SET provider_id=")))return;ctx.db.beforeBatch=null;ctx.sqlite.prepare("UPDATE canonical_bookings SET status='completed',updated_at=updated_at+1 WHERE id=?").run(job.bookingId);ctx.sqlite.prepare("UPDATE provider_work_orders SET status='completed',updated_at=updated_at+1 WHERE booking_id=?").run(job.bookingId);before=snapshot(ctx.sqlite);};
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Controlled completion race"});assert.ok(before,"concurrent completion must occur inside mutation window");assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,"RECOVERY_STATE_CONFLICT");assert.deepEqual(snapshot(ctx.sqlite),before);
});
test("unknown recovery action cannot change a booked job",async t=>{const ctx=await setupJourney();t.after(ctx.close);const job=await runCompletedJourney(ctx,config());const before=snapshot(ctx.sqlite);const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"invented",reason:"Invalid action"});assert.equal(result.status,400);assert.deepEqual(snapshot(ctx.sqlite),before);});
for(const action of ["accept","unavailable"])test(`concurrent cancellation prevents ${action} from accepting or escalating stale work`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const job=await runCompletedJourney(ctx,{...config(),preferredProviderId:"groom_kiran"});
 if(action==="unavailable")ctx.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json='{}' WHERE group_id=?").run(config().groupId);
 let before;ctx.db.beforeBatch=async statements=>{if(!statements.some(s=>s._sql.includes("UPDATE provider_work_orders SET status=")))return;ctx.db.beforeBatch=null;ctx.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled',updated_at=updated_at+1 WHERE id=?").run(job.bookingId);ctx.sqlite.prepare("UPDATE provider_work_orders SET status='cancelled',updated_at=updated_at+1 WHERE booking_id=?").run(job.bookingId);before=snapshot(ctx.sqlite);};
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action,reason:"Controlled cancellation race"});assert.ok(before,"cancellation must occur inside mutation window");assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,"RECOVERY_STATE_CONFLICT");assert.deepEqual(snapshot(ctx.sqlite),before);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_recovery_cases").get().n,0);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events").get().n,0);
});
