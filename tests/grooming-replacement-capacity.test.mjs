import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney} from "./helpers/grooming-journey-harness.mjs";
async function recover(body){const {POST}=await import("../app/api/provider-assignment-recovery/route.ts");const response=await POST(new Request("https://uat.pawspace.in/api/provider-assignment-recovery",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-email":"closure-admin@pawspace.test"},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};}
function config(){const start=new Date(Date.now()+9*86400000);start.setUTCHours(5,30,0,0);return {customerId:"OPS-BOUNDARY-CUSTOMER",customerName:"Recovery test parent",phone:"+919900000707",petSourceId:"OPS-BOUNDARY-PET",petName:"Test dog",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"OPS-BOUNDARY-GROUP",start:start.toISOString(),stopAfterCapture:true};}
const tables=["canonical_bookings","provider_work_orders","booking_payments","scheduling_reservations","scheduling_assignment_decisions","provider_assignment_offers","booking_lifecycle_events"];
function snapshot(sqlite){return Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table}`).all()]));}


function insertConflict(ctx,kind){
 const original=ctx.sqlite.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(config().groupId);
 const starts=kind==="daily"?[0,60,120,180].map(m=>new Date(new Date(original.scheduled_start).setUTCHours(0,m,0,0)).toISOString()):[new Date(new Date(original.scheduled_start).getTime()+(kind==="buffer"?-50:1)*60000).toISOString()];
 for(const [i,start] of starts.entries()){const row={...original,id:`CONCURRENT-${i}`,group_id:`CONCURRENT-GROUP-${i}`,provider_id:"groom_sanjay",scheduled_start:start,scheduled_end:new Date(new Date(start).getTime()+(kind==="overlap"?120:30)*60000).toISOString()};const columns=Object.keys(row);ctx.sqlite.prepare(`INSERT INTO scheduling_reservations (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));}
}
for(const kind of ["overlap","buffer","daily","leave","inactive","roster","model"])test(`replacement refuses concurrent ${kind} conflict and preserves original assignment`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=config(),job=await runCompletedJourney(ctx,input);let before;
 ctx.db.beforeBatch=async statements=>{if(!statements.some(s=>s._sql.includes("UPDATE scheduling_reservations SET provider_id=")))return;ctx.db.beforeBatch=null;
 if(["overlap","buffer","daily"].includes(kind))insertConflict(ctx,kind);
 if(kind==="model")ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET provider_model='commission' WHERE id='groom_sanjay'").run();
 if(kind==="inactive")ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET live=0 WHERE id='groom_sanjay'").run();
 if(kind==="leave")ctx.sqlite.prepare("INSERT INTO provider_unavailability(id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES ('LATE-LEAVE','groom_sanjay',?,?,'Controlled leave','active','test',?,?)").run(input.start,new Date(new Date(input.start).getTime()+7200000).toISOString(),Date.now(),Date.now());
 if(kind==="roster")ctx.sqlite.prepare("UPDATE scheduling_availability SET windows_json='[]',source='operations' WHERE provider_id='groom_sanjay'").run();
 before=snapshot(ctx.sqlite);};
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Controlled capacity race"});assert.ok(before,"conflict must arrive inside the mutation window");assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,"RECOVERY_CAPACITY_CONFLICT");assert.deepEqual(snapshot(ctx.sqlite),before);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_recovery_cases").get().n,0);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events").get().n,0);
});
for(const failOffer of [false,true])test(`commission replacement ${failOffer?"rolls back when offer creation fails":"commits its offer with the assignment"}`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=config(),job=await runCompletedJourney(ctx,input);
 const stored=ctx.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").get(input.groupId);const shortlist=JSON.parse(stored.shortlist_json);shortlist.choices=shortlist.choices.filter(choice=>choice.provider.model==="commission");assert.ok(shortlist.choices.length>0);ctx.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?").run(JSON.stringify(shortlist),input.groupId);
 const before=snapshot(ctx.sqlite);let injected=false;
 if(failOffer){const prepare=ctx.db.prepare;ctx.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith("INSERT INTO provider_assignment_offers"))return statement;return {...statement,bind:(...args)=>{const bound=statement.bind(...args);return {...bound,run:async()=>{injected=true;throw new Error("Controlled replacement offer failure");}};}};};}
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Controlled commission recovery"});
 if(failOffer){assert.ok(injected);assert.equal(result.status,500);assert.deepEqual(snapshot(ctx.sqlite),before);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_recovery_cases").get().n,0);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events").get().n,0);}
 else{assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.status,"awaiting_acceptance");const offer=ctx.sqlite.prepare("SELECT * FROM provider_assignment_offers WHERE group_id=?").get(input.groupId);assert.equal(offer.provider_id,result.body.data.replacement.id);assert.equal(offer.booking_id,job.bookingId);assert.equal(offer.status,"pending");assert.equal(offer.expires_at,result.body.data.nextOffer.expiresAt);}
});

test("commission-to-full-time change cannot commit an obsolete acceptance offer",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=config(),job=await runCompletedJourney(ctx,input);const stored=ctx.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").get(input.groupId);const shortlist=JSON.parse(stored.shortlist_json);shortlist.choices=shortlist.choices.filter(choice=>choice.provider.model==="commission");assert.ok(shortlist.choices.length);const candidate=shortlist.choices[0].provider.id;ctx.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?").run(JSON.stringify(shortlist),input.groupId);let before;
 ctx.db.beforeBatch=async statements=>{if(!statements.some(s=>s._sql.includes("UPDATE scheduling_reservations SET provider_id=")))return;ctx.db.beforeBatch=null;ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET provider_model='full_time' WHERE id=?").run(candidate);before=snapshot(ctx.sqlite);};
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Controlled model race"});assert.ok(before);assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,"RECOVERY_CAPACITY_CONFLICT");assert.deepEqual(snapshot(ctx.sqlite),before);
});
