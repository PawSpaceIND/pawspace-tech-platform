import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__OPS_CLOSURE_DB__", "__OPS_CLOSURE_ENV__");

function makeD1(sqlite){
  function statement(sql,args=[]){return{
    bind:(...bound)=>statement(sql,bound),
    first:async()=>sqlite.prepare(sql).get(...args)??null,
    run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},
    all:async()=>({results:sqlite.prepare(sql).all(...args)}),
  }}
  return{prepare:(sql)=>statement(sql),batch:async(stmts)=>{const out=[];for(const stmt of stmts)out.push(await stmt.run());return out;},exec:async(sql)=>{sqlite.exec(sql);return{count:0,duration:0};}};
}

const { createUnifiedCase, updateUnifiedCase, syncNativeCases } = await import("../lib/unified-case-center.ts");
const { syncCaseSopRequirements, updateCaseSopRequirement, listCaseSopRequirements } = await import("../lib/case-sop-governance.ts");
const { submitCustomerComplaint } = await import("../lib/customer-support-case.ts");
const { buildManagerDashboard } = await import("../lib/manager-dashboard.ts");

function world(){const sqlite=new DatabaseSync(":memory:");const db=makeD1(sqlite);globalThis.__OPS_CLOSURE_DB__=db;globalThis.__OPS_CLOSURE_ENV__={DB:db};return{sqlite,db}}

test("customer complaint retry identity creates one canonical case",async()=>{
  const {sqlite,db}=world();
  const input={customerId:"CUS-1",title:"Groomer was late",description:"The groomer arrived more than one hour late.",requestId:"REQ-RETRY-1"};
  const first=await submitCustomerComplaint(db,input);
  const retry=await submitCustomerComplaint(db,input);
  assert.equal(first.duplicatePrevented,false);
  assert.equal(retry.duplicatePrevented,true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM unified_cases").get().n,1);
  assert.equal(first.case.id,retry.case.id);
});

test("required SOP actions block case resolution until completed or explicitly waived",async()=>{
  const {sqlite,db}=world();
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,service_code TEXT,provider_id TEXT); CREATE TABLE lms_modules (id TEXT PRIMARY KEY,title TEXT,service_code TEXT,summary TEXT,content_json TEXT,quiz_json TEXT,pass_pct INTEGER,required INTEGER,version INTEGER,status TEXT,updated_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','grooming','PRV-1')").run();
  sqlite.prepare("INSERT INTO lms_modules VALUES ('LMS-1','Grooming safety SOP','grooming','s','[]','[]',80,1,3,'published','ops',1,1)").run();
  const created=await createUnifiedCase(db,{idempotencyKey:"case-sop-1",caseType:"customer_complaint",severity:"high",title:"Pet nick",description:"Minor nick reported during grooming",bookingId:"BK-1",providerId:"PRV-1",sourceType:"manual",sourceId:"SRC-1",ownerTeam:"customer_support",actorId:"ops"});
  await syncCaseSopRequirements(db,{caseId:created.case.id,actorId:"ops"});
  const requirements=await listCaseSopRequirements(db,created.case.id);
  assert.equal(requirements.length,1);
  assert.equal(requirements[0].status,"pending");
  await assert.rejects(()=>updateUnifiedCase(db,{caseId:created.case.id,action:"resolve",resolutionCode:"service_recovery",note:"Customer contacted and recovery completed",actorId:"cx"}),error=>error instanceof Response&&error.status===409);
  await updateCaseSopRequirement(db,{caseId:created.case.id,requirementId:String(requirements[0].id),action:"complete",note:"Safety checklist reviewed with provider",actorId:"manager"});
  await updateUnifiedCase(db,{caseId:created.case.id,action:"resolve",resolutionCode:"service_recovery",note:"Customer contacted and recovery completed",actorId:"cx"});
  assert.equal(sqlite.prepare("SELECT status FROM unified_cases WHERE id=?").get(created.case.id).status,"resolved");
});

test("legacy CX ticket converges into one unified case",async()=>{
  const {sqlite,db}=world();
  sqlite.exec("CREATE TABLE customer_experience_tickets (id TEXT PRIMARY KEY,customer_id TEXT,booking_id TEXT,lead_id TEXT,category TEXT,priority TEXT,subject TEXT,detail TEXT,owner TEXT,manager TEXT,status TEXT,resolution TEXT,root_cause TEXT,resolution_evidence TEXT,reopened_count INTEGER,created_at INTEGER,updated_at INTEGER,resolved_at INTEGER)");
  sqlite.prepare("INSERT INTO customer_experience_tickets VALUES ('T-1','CUS-1','BK-1',NULL,'complaint','high','Late provider','Provider was late','cx@pawspace.test','mgr@pawspace.test','open',NULL,NULL,NULL,0,1,1,NULL)").run();
  const first=await syncNativeCases(db,"system:test");
  const second=await syncNativeCases(db,"system:test");
  assert.equal(first.created,1);
  assert.equal(second.created,0);
  const row=sqlite.prepare("SELECT case_type,source_type,source_id,owner_email FROM unified_cases WHERE idempotency_key='legacy-cx:T-1'").get();
  assert.equal(row.case_type,"customer_complaint");
  assert.equal(row.source_type,"legacy_customer_experience_ticket");
  assert.equal(row.source_id,"T-1");
  assert.equal(row.owner_email,"cx@pawspace.test");
  sqlite.prepare("UPDATE customer_experience_tickets SET status='resolved',resolution='Customer refunded and informed',root_cause='provider delay',resolution_evidence='refund reference',resolved_at=2,updated_at=2 WHERE id='T-1'").run();
  await syncNativeCases(db,"system:test");
  const resolved=sqlite.prepare("SELECT status,resolution_note,resolution_code FROM unified_cases WHERE idempotency_key='legacy-cx:T-1'").get();
  assert.equal(resolved.status,"resolved");
  assert.equal(resolved.resolution_note,"Customer refunded and informed");
  assert.equal(resolved.resolution_code,"legacy_resolution");
});

test("founder manager dashboard exposes connected operations control metrics",async()=>{
  const {sqlite,db}=world();
  sqlite.exec("CREATE TABLE unified_cases (id TEXT PRIMARY KEY,status TEXT,severity TEXT,owner_email TEXT,first_responded_at INTEGER,first_response_due_at INTEGER,resolution_due_at INTEGER,manager_escalation_due_at INTEGER); CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,status TEXT); CREATE TABLE ops_work_queue_tasks (id TEXT PRIMARY KEY,status TEXT); CREATE TABLE unified_case_sop_requirements (id TEXT PRIMARY KEY,status TEXT); CREATE TABLE customer_experience_tickets (id TEXT PRIMARY KEY,status TEXT)");
  const now=Date.now();
  sqlite.prepare("INSERT INTO unified_cases VALUES ('C-1','open','critical',NULL,NULL,?,?,?)").run(now-1,now-1,now-1);
  sqlite.prepare("INSERT INTO booking_refund_cases VALUES ('R-1','requested'),('R-2','failed')").run();
  sqlite.prepare("INSERT INTO ops_work_queue_tasks VALUES ('W-1','open')").run();
  sqlite.prepare("INSERT INTO unified_case_sop_requirements VALUES ('S-1','pending')").run();
  sqlite.prepare("INSERT INTO customer_experience_tickets VALUES ('T-1','open')").run();
  const dashboard=await buildManagerDashboard(db,{actorEmail:"founder@pawspace.test",permissions:["*"],asOf:now});
  assert.deepEqual(dashboard.operations,{openCases:1,criticalCases:1,unownedCases:1,firstResponseOverdue:1,resolutionOverdue:1,managerEscalationsDue:1,refundsPending:1,refundsFailed:1,workQueueOpen:1,sopPending:1,legacyTicketsOpen:1});
});
