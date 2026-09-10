import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney,sessionCookie} from "./helpers/grooming-journey-harness.mjs";
async function recover(body,cookie){const {POST}=await import("../app/api/provider-assignment-recovery/route.ts");const response=await POST(new Request("https://uat.pawspace.in/api/provider-assignment-recovery",{method:"POST",headers:{"content-type":"application/json",...(cookie?{cookie}:{"oai-authenticated-user-email":"closure-admin@pawspace.test"})},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};}
function config(){const start=new Date(Date.now()+9*86400000);start.setUTCHours(5,30,0,0);return {customerId:"OPS-BOUNDARY-CUSTOMER",customerName:"Recovery test parent",phone:"+919900000707",petSourceId:"OPS-BOUNDARY-PET",petName:"Test dog",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"OPS-BOUNDARY-GROUP",start:start.toISOString(),stopAfterCapture:true};}
const tables=["canonical_bookings","provider_work_orders","booking_payments","scheduling_reservations","scheduling_assignment_decisions","provider_assignment_offers","booking_lifecycle_events","booking_customer_notifications","security_audit_events","provider_recovery_cases","provider_performance_events"];
function snapshot(sqlite){return Object.fromEntries(tables.map(table=>[table,sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)?sqlite.prepare(`SELECT * FROM ${table}`).all():[]]));}


for(const mode of ["replacement","escalation","accept"])for(const table of ["booking_lifecycle_events","security_audit_events",...(mode==="accept"?[]:["booking_customer_notifications"])])test(`${mode}: ${table} failure rolls back recovery and a retry commits once`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input={...config(),preferredProviderId:mode==="accept"?"groom_kiran":"groom_arun"},job=await runCompletedJourney(ctx,input);
 if(mode==="escalation")ctx.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json='{}' WHERE group_id=?").run(input.groupId);
 const before=snapshot(ctx.sqlite),prepare=ctx.db.prepare;let injected=false,count=0;
 ctx.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith(`INSERT INTO ${table}`))return statement;return {...statement,bind:(...args)=>{const bound=statement.bind(...args);return {...bound,run:async()=>{count++;if(table!=="booking_customer_notifications"||count===2){injected=true;throw new Error("Controlled recovery fanout failure");}return bound.run();}};}};};
 const body={bookingId:job.bookingId,providerId:job.provider.id,action:mode==="accept"?"accept":"unavailable",reason:"Controlled transactional fanout"};const failed=await recover(body);assert.ok(injected);assert.equal(failed.status,500);assert.deepEqual(snapshot(ctx.sqlite),before);
 ctx.db.prepare=prepare;const retried=await recover(body);assert.equal(retried.status,mode==="escalation"?202:200,JSON.stringify(retried.body));
 const events=ctx.sqlite.prepare("SELECT id FROM booking_lifecycle_events WHERE booking_id=? AND event_type LIKE 'provider_%'").all(job.bookingId);assert.equal(events.length,1);
 if(mode!=="accept"){const notices=ctx.sqlite.prepare("SELECT event_id FROM booking_customer_notifications WHERE booking_id=?").all(job.bookingId);assert.equal(notices.length,2);assert.ok(notices.every(n=>n.event_id===events[0].id));}
});
test("failed bridge can be retried by staff without another recovery or duplicate notification",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=config(),job=await runCompletedJourney(ctx,input);const engine=await import("../lib/communication-engine.ts");await engine.setCommunicationPreference(ctx.db,{customerId:input.customerId,serviceUpdates:true,marketing:false,source:"test"});const prepare=ctx.db.prepare;let injected=false;
 ctx.db.prepare=sql=>{if(sql.includes("LEFT JOIN lifecycle_communication_links")){injected=true;throw new Error("Controlled bridge read failure");}return prepare(sql);};
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Controlled bridge retry"});assert.equal(result.status,200);assert.ok(injected);assert.ok(result.body.data.communications.failed>0);ctx.db.prepare=prepare;
 const before=snapshot(ctx.sqlite);const retried=await recover({bookingId:job.bookingId,action:"retry_notifications"});assert.equal(retried.status,200,JSON.stringify(retried.body));assert.equal(retried.body.data.communications.failed,0);assert.equal(retried.body.data.communications.enqueued,1);
 const again=await recover({bookingId:job.bookingId,action:"retry_notifications"});assert.equal(again.status,200);assert.equal(again.body.data.communications.enqueued,0);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE booking_id=?").get(job.bookingId).n,1);
 const after=snapshot(ctx.sqlite);delete before.security_audit_events;delete after.security_audit_events;assert.deepEqual(after,before);
 const customer=await sessionCookie(ctx.db,"customer",input.customerId,`customer:${input.customerId}`);const denied=await recover({bookingId:job.bookingId,action:"retry_notifications"},customer);assert.equal(denied.status,403);
});
