import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {freshCountingD1} from "./helpers/d1-harness.mjs";
installWorkersHooks();
const governance=await import("../lib/intelligence/atlas-executive-governance.ts");
const executor=await import("../lib/intelligence/atlas-low-risk-executor.ts");
const now=2_000_000_000_000;
const proposal=(overrides={})=>({proposalId:"LOW-1",tenantId:"pawspace",domain:"ceo",objective:"Produce internal brief",actionCode:"brief.generate",summary:"Grounded internal brief",evidence:[{source:"canonical",observedAt:now-1000,value:1}],confidence:.95,expectedOutcome:"Founder sees internal brief",policyVersion:governance.DEFAULT_ATLAS_DECISION_POLICY.version,...overrides});

test("fresh zero-money internal draft is eligible for governed autonomy",()=>{const result=governance.evaluateAtlasProposal(proposal(),{now});assert.equal(result.risk,"low");assert.equal(result.disposition,"auto_execute_internal");assert.equal(result.autonomousExecution,true);assert.ok(result.reasons.includes("governed_internal_artifact_only"));});

test("low-risk executor persists one idempotent internal artifact and no external mutation",async()=>{const{sqlite,db}=freshCountingD1();const first=await executor.executeAtlasLowRiskArtifact(db,{proposal:proposal(),content:{body:"numbers only"},asOf:now});const second=await executor.executeAtlasLowRiskArtifact(db,{proposal:proposal(),content:{body:"different replay"},asOf:now+1});assert.equal(first.executed,true);assert.equal(first.externalMutation,false);assert.equal(second.duplicatePrevented,true);assert.equal(second.id,first.id);const row=sqlite.prepare("SELECT action_code,artifact_type,execution_mode,status FROM atlas_operating_artifacts").get();assert.equal(row.action_code,"brief.generate");assert.equal(row.artifact_type,"brief");assert.equal(row.execution_mode,"low_risk_internal_only");assert.equal(row.status,"generated");sqlite.close();});

test("money, external contact, provider assignment and campaign activation never enter low-risk executor",async()=>{const cases=[proposal({proposalId:"M",actionCode:"refund.issue",moneyMovement:true}),proposal({proposalId:"O",actionCode:"followup.draft",externalCommunication:true}),proposal({proposalId:"P",actionCode:"provider.assignment"}),proposal({proposalId:"C",actionCode:"campaign.activate"})];for(const item of cases){const evaluation=governance.evaluateAtlasProposal(item,{now});assert.equal(evaluation.autonomousExecution,false);const{sqlite,db}=freshCountingD1();const error=await executor.executeAtlasLowRiskArtifact(db,{proposal:item,content:{},asOf:now}).then(()=>null,e=>e);assert.equal(error instanceof Response,true);assert.equal(error.status,409);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM atlas_operating_artifacts").get().n,0);sqlite.close();}});


test("snapshot exceptions become internal unassigned task drafts only",()=>{
 const metric=(value,source="canonical")=>({value,source,asOf:now});
 const snapshot={asOf:now,mission:metric(null,"mission"),bookings:metric([],"canonical_bookings"),ops:{open_cases:metric(4,"unified_cases"),sla_breaches:metric(2,"unified_cases"),sitting_pending_accepts:metric(1,"canonical_bookings"),boarding_pending_accepts:metric(0,"boarding_stays"),cash_collection_holds:{value:null,source:"cash",asOf:now,reason:"unknown"}},finance:{invoice_completed_gap:metric({completed_jobs:5,issued_invoices:3,gap:2},"canonical_bookings + booking_invoices"),trainer_earnings:metric({pending_rate:1,held_payment:0,earned:2,published_uat_rates:1},"training")},integrations:{payments:{value:false,source:"readiness",asOf:now,reason:"sandbox_missing"},maps:metric(true,"readiness"),whatsapp:metric(true,"readiness"),ai:metric(true,"readiness")},limitations:[],insufficient_data:false,production_ready:false};
 const tasks=executor.buildAtlasSnapshotTaskDrafts(snapshot,{dayKey:"2033-05-18"});
 assert.deepEqual(tasks.map(t=>t.proposal.proposalId),["ATLAS-DAILY-TASK-2033-05-18-sla-breaches","ATLAS-DAILY-TASK-2033-05-18-completed-job-invoice-gap","ATLAS-DAILY-TASK-2033-05-18-sitting-pending-accepts","ATLAS-DAILY-TASK-2033-05-18-trainer-rate-pending","ATLAS-DAILY-TASK-2033-05-18-integration-blockers"]);
 for(const task of tasks){assert.equal(task.proposal.actionCode,"task.draft");assert.equal(task.proposal.externalCommunication,undefined);assert.equal(task.proposal.moneyMovement,undefined);assert.equal(task.content.internalOnly,true);assert.equal(task.content.assignedTo,null);}
});

test("zero or unknown snapshot metrics do not manufacture operational tasks",()=>{
 const metric=value=>({value,source:"canonical",asOf:now}),snapshot={asOf:now,mission:metric(null),bookings:metric([]),ops:{open_cases:metric(0),sla_breaches:metric(0),sitting_pending_accepts:metric(0),boarding_pending_accepts:metric(null),cash_collection_holds:metric(null)},finance:{invoice_completed_gap:metric(null),trainer_earnings:metric(null)},integrations:{payments:metric(true),maps:metric(true),whatsapp:metric(true),ai:metric(true)},limitations:[],insufficient_data:true,production_ready:false};
 assert.deepEqual(executor.buildAtlasSnapshotTaskDrafts(snapshot,{dayKey:"2033-05-18"}),[]);
});
