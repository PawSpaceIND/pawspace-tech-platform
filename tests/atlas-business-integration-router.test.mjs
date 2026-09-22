import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks();
const {ATLAS_BUSINESS_CAPABILITIES}=await import("../lib/intelligence/atlas-business-capabilities.ts");
const {buildAtlasBusinessIntegrationPlan,atlasIntegrationCoverage}=await import("../lib/intelligence/atlas-business-integration-router.ts");

const now=Date.now();
const input=(capabilityCode,extra={})=>({requestId:"REQ-1",tenantId:"pawspace",capabilityCode,
 objective:"Improve PawSpace",summary:"Governed Atlas recommendation",expectedOutcome:"Measured improvement",
 confidence:.92,evidence:[{source:"canonical",recordId:"R-1",observedAt:now,value:1}],...extra});

test("routes every Atlas capability to a canonical V2 adapter",()=>{
 const coverage=atlasIntegrationCoverage();
 assert.equal(coverage.complete,true);
 assert.equal(coverage.capabilityCodes.length,ATLAS_BUSINESS_CAPABILITIES.length);
 assert.equal(coverage.autonomousExecution,false);
 assert.ok(coverage.canonicalAdapters.includes("provider_assignment_policy"));
 assert.ok(coverage.canonicalAdapters.includes("lead_assignment_governance"));
 assert.ok(coverage.canonicalAdapters.includes("revenue_opportunity_governance"));
});

test("provider routing requires an explicit supported vertical",()=>{
 assert.throws(()=>buildAtlasBusinessIntegrationPlan(input("provider.smart_assignment")),/supported service vertical/);
 const plan=buildAtlasBusinessIntegrationPlan(input("provider.smart_assignment",{serviceVertical:"grooming"}));
 assert.equal(plan.route.adapter,"provider_assignment_policy");
 assert.equal(plan.decisionGate,"confirmation");
 assert.equal(plan.executeAllowed,false);
});

test("high-impact capabilities stop at human approval",()=>{
 for(const code of ["lead.outbound_engagement","marketing.demand_orchestration","hiring.candidate_assist","gst.compliance_prepare"]){
  const plan=buildAtlasBusinessIntegrationPlan(input(code));
  assert.equal(plan.decisionGate,"human_approval",code);
  assert.equal(plan.executeAllowed,false,code);
 }
});

test("freshness and confidence failures block integration plans",()=>{
 const stale=buildAtlasBusinessIntegrationPlan(input("revenue.next_best_action",{evidence:[{source:"canonical",observedAt:1,value:1}]}));
 assert.equal(stale.decisionGate,"blocked");
 const low=buildAtlasBusinessIntegrationPlan(input("lead.smart_assignment",{confidence:.2}));
 assert.equal(low.decisionGate,"blocked");
});

test("identity and unknown capabilities fail closed",()=>{
 assert.throws(()=>buildAtlasBusinessIntegrationPlan(input("lead.smart_assignment",{tenantId:""})),/identity/);
 assert.throws(()=>buildAtlasBusinessIntegrationPlan(input("unknown.capability")),/Unknown Atlas business capability/);
});
