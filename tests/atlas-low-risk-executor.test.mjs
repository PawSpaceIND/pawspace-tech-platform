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
