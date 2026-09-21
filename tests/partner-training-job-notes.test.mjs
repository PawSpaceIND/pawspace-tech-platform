import test from "node:test";
import assert from "node:assert/strict";
import {freshWorld,seedBooking,TRAINER,routeCall,sessionCookie} from "./helpers/training-lifecycle-harness.mjs";
const React=await import("react");const {renderToStaticMarkup}=await import("react-dom/server");
const {default:JobNotes}=await import("../app/partner-app/job-notes.tsx");
const {materializeTrainingBooking}=await import("../lib/training-programme.ts");
const {ensureProviderCapacityTables}=await import("../lib/provider-capacity-governance.ts");
const jobs=await import("../app/api/partner-jobs/route.ts");
test("a real Training assessment job provides the shared notes contract and renders without the browser crash",async()=>{
 const world=freshWorld();await ensureProviderCapacityTables(world.db);
 world.sqlite.prepare("INSERT INTO provider_capacity_profiles(id,city_id,name,provider_model,services_json,zones_json,effective_from,status,live,updated_by,updated_at) VALUES (?,'blr','QA Trainer','full_time','[\"dog_training\"]','[\"blr-east\"]','2026-01-01','active',1,'qa',1)").run(TRAINER);
 seedBooking(world,{id:"ASSESS",group:"ASSESS-G",packageCode:"trainer-meet-greet",packageName:"Trainer Meet & Greet",sessions:1,total:500,dueNow:500});await materializeTrainingBooking(world.db,{bookingId:"ASSESS",actorId:"qa"});
 const cookie=await sessionCookie(world.db,"provider",TRAINER),response=await routeCall(jobs.GET,"GET",'/api/partner-jobs?providerId='+TRAINER,{cookie});
 assert.equal(response.status,200,JSON.stringify(response.body));const job=response.body.jobs[0];assert.equal(job.trainingSessionId.length>0,true);assert.deepEqual(job.safetyRequirements,[]);assert.deepEqual(job.addOns,[]);
 assert.doesNotThrow(()=>renderToStaticMarkup(React.createElement(JobNotes,job)));
});
test("older Training projections missing optional Grooming notes render safely while real notes remain visible",()=>{
 assert.equal(renderToStaticMarkup(React.createElement(JobNotes,{})),"");
 const html=renderToStaticMarkup(React.createElement(JobNotes,{safetyRequirements:["gentle_handling"],addOns:["nail_trim"]}));assert.match(html,/gentle handling/);assert.match(html,/nail trim/);
});
const {selectPartnerWorkOrder}=await import("../lib/partner-job-selection.ts");
test("Training sessions sharing a booking remain independently selectable across refreshes",()=>{
 const jobs=[{bookingId:"B",workOrderId:"S1",status:"completed"},{bookingId:"B",workOrderId:"S2",status:"scheduled"},{bookingId:"B",workOrderId:"S3",status:"locked"}];
 assert.equal(selectPartnerWorkOrder(jobs,"","B"),"S2");assert.equal(selectPartnerWorkOrder(jobs,"S3","B"),"S3");assert.equal(selectPartnerWorkOrder([],"S3","B"),"");
});
