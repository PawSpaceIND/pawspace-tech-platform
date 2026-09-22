import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks();
const {ATLAS_EXECUTIVE_DOMAINS,DEFAULT_ATLAS_DECISION_POLICY,atlasExecutiveRegistry,evaluateAtlasProposal}=await import("../lib/intelligence/atlas-executive-governance.ts");

const now=2_000_000_000_000;
const proposal=(overrides={})=>({proposalId:"ATL-PROP-1",tenantId:"pawspace",domain:"sales",objective:"Improve conversion",actionCode:"followup.draft",summary:"Draft a grounded follow-up",evidence:[{source:"crm_leads",recordId:"LEAD-1",observedAt:now-1000,value:"awaiting_followup"}],confidence:.91,expectedOutcome:"Founder reviews a timely follow-up",policyVersion:DEFAULT_ATLAS_DECISION_POLICY.version,...overrides});

test("Atlas exposes all governed executive domains with internal-only low-risk autonomy",()=>{assert.deepEqual(ATLAS_EXECUTIVE_DOMAINS,["ceo","sales","marketing","operations","customer_success","finance","gst_tax","legal","hr","groomer","trainer","risk"]);assert.ok(atlasExecutiveRegistry().every(item=>item.mayExecuteAutonomously===false&&item.mayExecuteInternalLowRisk===true&&item.autonomyScope==="low_risk_internal_only"));});

test("fresh grounded draft auto-executes only as an internal artifact",()=>{const result=evaluateAtlasProposal(proposal(),{now});assert.equal(result.risk,"low");assert.equal(result.disposition,"auto_execute_internal");assert.equal(result.autonomousExecution,true);assert.equal(result.evidenceFresh,true);assert.ok(result.reasons.includes("governed_internal_artifact_only"));});

test("stale, future, missing or low-confidence evidence fails closed",()=>{for(const item of [proposal({evidence:[]}),proposal({evidence:[{source:"crm",observedAt:now-DEFAULT_ATLAS_DECISION_POLICY.maximumEvidenceAgeMs-1,value:1}]}),proposal({evidence:[{source:"crm",observedAt:now+1,value:1}]}),proposal({confidence:.3})])assert.equal(evaluateAtlasProposal(item,{now}).disposition,"blocked");});

test("financial, statutory, legal and employment actions always require named human approvals",()=>{const cases=[[{actionCode:"refund.issue",moneyMovement:true},"finance"],[{actionCode:"gst.file",statutoryFiling:true},"qualified_tax_professional"],[{actionCode:"contract.sign",legallyBinding:true},"legal"],[{actionCode:"employee.terminate",employmentDecision:true},"hr_and_authorized_manager"]];for(const [overrides,approval] of cases){const result=evaluateAtlasProposal(proposal(overrides),{now});assert.equal(result.disposition,"approval_required");assert.equal(result.autonomousExecution,false);assert.ok(result.requiredApprovals.includes(approval));}});

test("policy version mismatch blocks a proposal from an outdated agent",()=>{const result=evaluateAtlasProposal(proposal({policyVersion:"atlas-v1"}),{now});assert.equal(result.disposition,"blocked");assert.ok(result.reasons.includes("policy_version_mismatch"));});

test("external communication requires explicit confirmation and an authorized operator",()=>{const result=evaluateAtlasProposal(proposal({actionCode:"followup.send",externalCommunication:true}),{now});assert.equal(result.disposition,"ready_for_confirmation");assert.ok(result.requiredApprovals.includes("authorized_operator"));assert.equal(result.autonomousExecution,false);});
