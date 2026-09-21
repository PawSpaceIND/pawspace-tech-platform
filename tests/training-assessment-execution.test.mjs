import test from "node:test";
import assert from "node:assert/strict";
import {freshWorld,seedBooking,completeSession,sessionCookie,routeCall,TRAINER} from "./helpers/training-lifecycle-harness.mjs";
const {materializeTrainingBooking}=await import("../lib/training-programme.ts");
const {listTrainerSessions,mutateTrainingSession}=await import("../lib/training-session-lifecycle.ts");
const route=await import("../app/api/training-programmes/route.ts");
function seed(world,extra={}){seedBooking(world,{id:"MEET",group:"GM",packageCode:"trainer-meet-greet",packageName:"Trainer Meet & Greet",sessions:1,total:500,dueNow:500,...extra});}
test("assessment preparation creates one provider-visible session, replays once, and completion emits no programme certificate",async()=>{
 const world=freshWorld();seed(world);
 const owner=await sessionCookie(world.db,"customer","cus_t1");
 const response=await routeCall(route.POST,"POST","/api/training-programmes",{cookie:owner,body:{bookingId:"MEET"}});
 assert.equal(response.status,201,JSON.stringify(response.body));
 const prepared=await materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa"});assert.equal(prepared.duplicatePrevented,true);
 const jobs=await listTrainerSessions(world.db,TRAINER);assert.equal(jobs.length,1);assert.equal(jobs[0].plan_code,"trainer-meet-greet");
 const done=await completeSession(world,jobs[0],"assessment");assert.equal(done.status,"completed");assert.equal(done.closure.assessmentCompleted,true);assert.equal(done.closure.certificateNumber,null);
 assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_completion_certificates").get().n,0);
 assert.equal(world.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='MEET'").get().status,"completed");
 assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_session_consumptions").get().n,1);
 const replay=await mutateTrainingSession(world.db,{sessionId:jobs[0].id,action:"complete",actorId:"qa",idempotencyKey:"assessment-complete"});assert.equal(replay.duplicatePrevented,true);
 assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_customer_notifications WHERE template_code='training_assessment_completed'").get().n,2);
});
test("unpaid assessment is visible but cannot be accepted; payment remains server-owned",async()=>{
 const world=freshWorld();seed(world,{dueNow:0,status:"payment_pending"});
 const {sessions}=await materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa"});
 await assert.rejects(mutateTrainingSession(world.db,{sessionId:sessions[0].id,action:"accept",actorId:"qa",idempotencyKey:"unpaid"}),e=>e instanceof Response&&e.status===409);
 assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions").get().status,"scheduled");
});
test("assessment refuses multiple reservations, cancelled bookings and foreign customer preparation",async()=>{
 const world=freshWorld();seed(world,{sessions:2});await assert.rejects(materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa"}),e=>e instanceof Response&&e.status===409);
 world.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled'").run();await assert.rejects(materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa"}),e=>e instanceof Response&&e.status===409);
 const stranger=await sessionCookie(world.db,"customer","cus_other");const response=await routeCall(route.POST,"POST","/api/training-programmes",{cookie:stranger,body:{bookingId:"MEET"}});assert.equal(response.status,403);
 assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_sessions").get().n,0);
});

test("concurrent assessment retries return the same execution record without duplicate sessions",async()=>{
 const world=freshWorld();seed(world);
 const results=await Promise.all([materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa1"}),materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa2"})]);
 assert.equal(new Set(results.map(r=>r.programme.id)).size,1);assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_sessions").get().n,1);
});
test("a mid-batch session failure rolls back execution rows and retry recovers the same reserved booking",async()=>{
 const world=freshWorld();seed(world);const batch=world.db.batch.bind(world.db);let inject=true;
 world.db.batch=async statements=>{
  if(inject&&statements.some(s=>s.sql.startsWith("INSERT INTO training_sessions"))){inject=false;const first=statements[0];return batch([first,world.db.prepare("INSERT INTO deliberately_missing_qa_table VALUES (1)")]);}
  return batch(statements);
 };
 await assert.rejects(materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa"}),/deliberately_missing_qa_table/);
 assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_programmes").get().n,0);assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_sessions").get().n,0);
 assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n,1);assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE status='assigned'").get().n,1);
 const recovered=await materializeTrainingBooking(world.db,{bookingId:"MEET",actorId:"qa"});assert.equal(recovered.sessions.length,1);assert.equal(recovered.programme.booking_id,"MEET");
});
