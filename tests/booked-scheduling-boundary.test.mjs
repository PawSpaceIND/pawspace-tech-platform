import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney,routeCall,sessionCookie} from "./helpers/grooming-journey-harness.mjs";
import {seedOwnedPet} from "./helpers/saved-pet-fixture.mjs";

async function post(body,cookie){
  const {POST}=await import("../app/api/uat-scheduling/route.ts");
  const response=await POST(new Request("https://uat.pawspace.in/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json",...(cookie?{cookie}:{"oai-authenticated-user-email":"closure-admin@pawspace.test"})},body:JSON.stringify(body)}));
  return {status:response.status,body:await response.json()};
}
function config(){const start=new Date(Date.now()+9*86400000);start.setUTCHours(5,30,0,0);return {customerId:"OPS-BOUNDARY-CUSTOMER",customerName:"Recovery test parent",phone:"+919900000707",petSourceId:"OPS-BOUNDARY-PET",petName:"Test dog",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"OPS-BOUNDARY-GROUP",start:start.toISOString(),stopAfterCapture:true};}
const tables=["canonical_bookings","provider_work_orders","booking_payments","scheduling_reservations","scheduling_assignment_decisions","provider_assignment_offers","booking_lifecycle_events"];
function snapshot(sqlite){return Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table}`).all()]));}
for(const action of ["cancel","reassign","assign","manual"])test(`generic ${action} cannot split a confirmed booking from its work and capacity`,async t=>{
  const ctx=await setupJourney();t.after(ctx.close);const input=config();await runCompletedJourney(ctx,input);const before=snapshot(ctx.sqlite);
  const rejected=await post({action,groupId:input.groupId,providerId:"groom_sanjay",reason:"Controlled operations boundary test"});
  assert.equal(rejected.status,409,JSON.stringify(rejected.body));assert.equal(rejected.body.code,"BOOKING_RECOVERY_REQUIRED");
  assert.deepEqual(snapshot(ctx.sqlite),before);
});

test("the existing Grooming recovery route keeps booking, work and capacity on one replacement",async t=>{
  const ctx=await setupJourney();t.after(ctx.close);const input=config();const job=await runCompletedJourney(ctx,input);
  const payments=ctx.sqlite.prepare("SELECT * FROM booking_payments").all();
  const recovered=await routeCall("../../app/api/provider-assignment-recovery/route.ts","POST","/api/provider-assignment-recovery",{bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Provider reported unavailability in controlled UAT"});
  assert.equal(recovered.status,200,JSON.stringify(recovered.body));
  const next=recovered.body.data.replacement.id;assert.notEqual(next,job.provider.id);
  assert.equal(ctx.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").get(job.bookingId).provider_id,next);
  assert.equal(ctx.sqlite.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=?").get(job.bookingId).provider_id,next);
  assert.deepEqual(ctx.sqlite.prepare("SELECT DISTINCT provider_id FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").all(input.groupId).map(row=>row.provider_id),[next]);
  assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM booking_payments").all(),payments);
});

for(const action of ["cancel","reassign","assign","manual"])test(`confirmation inside generic ${action} leaves the new booking and original capacity intact`,async t=>{
  const ctx=await setupJourney();t.after(ctx.close);const input=config();await seedOwnedPet(ctx.db,input.customerId,input.petSourceId,input.petName);
  const cookie=await sessionCookie(ctx.db,"customer",input.customerId,`customer:${input.customerId}`),end=new Date(new Date(input.start).getTime()+7200000).toISOString();
  const reserved=await post({clientRequestId:input.groupId,customerId:input.customerId,petIds:[input.petSourceId],serviceCode:"grooming",serviceAddress:"42 Test Road, Indiranagar, Bengaluru",servicePincode:"560038",scheduledStart:input.start,scheduledEnd:end,preferredProviderId:input.preferredProviderId},cookie);
  assert.equal(reserved.status,200,JSON.stringify(reserved.body));let confirmed,before;
  ctx.db.beforeBatch=async statements=>{
    if(!statements.some(statement=>statement._sql.includes("UPDATE scheduling_reservations SET status='cancelled'")))return;
    ctx.db.beforeBatch=null;
    confirmed=await routeCall("../../app/api/canonical-bookings/route.ts","POST","/api/canonical-bookings",{idempotencyKey:input.groupId,scheduleGroupId:input.groupId,customer:{id:input.customerId,name:input.customerName,primaryPhone:input.phone},pets:[{sourceId:input.petSourceId,name:input.petName,species:"dog"}],cityId:"blr",zoneId:"blr-east",serviceCode:"grooming",packageCode:"dog-basic",packageName:"Bath & Basic",scheduledStart:input.start,scheduledEnd:end,provider:reserved.body.data.provider,totalAmount:1899,amountDueNow:1899,payment:{method:"upi",mode:"prepaid",status:"created",detail:"Controlled race test"},pricing:{discount:0}},cookie);
    assert.equal(confirmed.status,201,JSON.stringify(confirmed.body));before=snapshot(ctx.sqlite);
  };
  const rejected=await post({action,groupId:input.groupId,providerId:reserved.body.data.provider.id,reason:"Controlled simultaneous confirmation test"});
  assert.ok(confirmed,"confirmation must commit inside the mutation window");assert.equal(rejected.status,409,JSON.stringify(rejected.body));assert.equal(rejected.body.code,"BOOKING_RECOVERY_REQUIRED");assert.deepEqual(snapshot(ctx.sqlite),before);
});

 test("staff day board identifies confirmed rows requiring service recovery",async t=>{
  const ctx=await setupJourney();t.after(ctx.close);const input=config();const job=await runCompletedJourney(ctx,input);
  const result=await routeCall("../../app/api/uat-scheduling/route.ts","GET",`/api/uat-scheduling?date=${input.start.slice(0,10)}`);
  assert.equal(result.status,200,JSON.stringify(result.body));
  const rows=result.body.data.providers.flatMap(provider=>provider.reservations).filter(row=>row.groupId===input.groupId);
  assert.ok(rows.length>0);assert.ok(rows.every(row=>row.bookingId===job.bookingId));
});
