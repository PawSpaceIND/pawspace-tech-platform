import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {projectTrainerSession,sanitizeTrainingEventDetail} from "../lib/training-provider-projection.ts";

test("trainer projection strips raw contact, staff and unbounded report data",()=>{
  const raw={
    id:"S1",programme_id:"P1",booking_id:"B1",sequence_no:1,provider_id:"TR1",scheduled_start:"2026-09-10T10:00:00+05:30",scheduled_end:"2026-09-10T11:00:00+05:30",status:"in_session",
    customer_id:"C1",customer_name:"S***",customer_phone:"9876543210",customer_email:"owner@example.com",internal_note:"private staff note",plan_code:"basic",plan_name:"Basic",total_sessions:6,completed_sessions:1,no_show_sessions:0,cancelled_sessions:0,programme_status:"in_progress",
    petIds:["PET1"],requirements:["Use hand signals","Call 9876543210","Meet at 42 MG Road","owner@example.com"],
    attendance:{mode:"parent",safeAreaConfirmed:true,parentOrCaretakerConfirmed:true,customerPhone:"9876543210",internalNote:"private staff note"},
    homework:{text:"Practice sit and stay twice daily",customerEmail:"owner@example.com"},
    progress:{sit:8,recall:7,comment:"call 9876543210",staffNote:4},
    evidenceRefs:["media://asset/SAFE1","https://example.com/signed?x=1","owner@example.com"],
    events:[{event_type:"complete",actor_id:"staff@pawspace.in",detail_json:JSON.stringify({from:"in_session",to:"completed",distanceMeters:42,reason:"call owner@example.com",customerPhone:"9876543210",programme:{status:"completed",customerEmail:"owner@example.com"},evidenceRefs:["media://asset/SAFE1","owner@example.com"]}),created_at:123}],
  };
  const out=projectTrainerSession(raw),serialized=JSON.stringify(out);
  for(const secret of ["9876543210","owner@example.com","staff@pawspace.in","private staff note","customer_phone","customer_email"]){
    assert.equal(serialized.includes(secret),false,secret);
  }
  assert.deepEqual(out.requirements,["Use hand signals"]);
  assert.deepEqual(out.attendance,{mode:"parent",safeAreaConfirmed:true,parentOrCaretakerConfirmed:true});
  assert.deepEqual(out.homework,{text:"Practice sit and stay twice daily"});
  assert.deepEqual(out.progress,{sit:8,recall:7});
  assert.deepEqual(out.evidenceRefs,["media://asset/SAFE1"]);
  assert.equal(out.events[0].actorId,"provider_or_system");
  assert.equal(out.events[0].detail.distanceMeters,42);
  assert.deepEqual(out.events[0].detail.programme,{status:"completed"});
  assert.deepEqual(out.events[0].detail.evidenceRefs,["media://asset/SAFE1"]);
});

test("training event detail keeps bounded operational facts but removes contact-shaped values",()=>{
  assert.deepEqual(sanitizeTrainingEventDetail({status:"completed",caseId:"CASE-1",reason:"customer asked for owner@example.com",internalNote:"secret",durationMinutes:15}),{status:"completed",caseId:"CASE-1",durationMinutes:15});
});

test("provider GET masks the customer name before applying the explicit projection",()=>{
  const source=readFileSync(new URL("../app/api/training-sessions/route.ts",import.meta.url),"utf8");
  assert.match(source,/projectTrainerSession/);
  assert.match(source,/projectTrainerSession\(\{\.\.\.item,customer_name:maskName\(/);
});


test("formatted phone numbers and contact-shaped nested keys never leave the trainer projection",()=>{
 const out=projectTrainerSession({requirements:["Practice recall","+91 98765 43210"],homework:{text:"Use 98765-43210"},progress:{"9876543210":4,sit:8},events:[{event_type:"complete",detail_json:JSON.stringify({programme:{"owner@example.com":true,reference:9876543210,status:"completed"}})}]});
 assert.deepEqual(out.requirements,["Practice recall"]);assert.deepEqual(out.homework,{});assert.deepEqual(out.progress,{sit:8});assert.deepEqual(out.events[0].detail.programme,{status:"completed"});
});

test("secure Training evidence references do not expose query strings or nested paths",()=>{
 assert.deepEqual(projectTrainerSession({evidenceRefs:["media://asset/SAFE1","media://asset/SAFE1?token=private","media://asset/SAFE1/nested"]}).evidenceRefs,["media://asset/SAFE1"]);
});
