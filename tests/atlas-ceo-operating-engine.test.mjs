import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks();
const {DEFAULT_ATLAS_DECISION_POLICY}=await import("../lib/intelligence/atlas-executive-governance.ts");
const {buildAtlasCeoBrief}=await import("../lib/intelligence/atlas-ceo-operating-engine.ts");
const {ATLAS_BUSINESS_CAPABILITIES,ATLAS_PROVIDER_VERTICALS,atlasCapabilityRoadmap}=await import("../lib/intelligence/atlas-business-capabilities.ts");

const now=2_000_000_000_000;
const candidate=(id,domain,actionCode,priorityScore,extra={})=>({ownerRole:domain,priorityScore,proposal:{proposalId:id,tenantId:"pawspace",domain,objective:"Improve PawSpace",actionCode,summary:id,evidence:[{source:"canonical",observedAt:now-1000,value:1}],confidence:.9,expectedOutcome:"Measured improvement",policyVersion:DEFAULT_ATLAS_DECISION_POLICY.version,...extra}});

test("CEO brief separates approval work from governed internal auto-execution",()=>{const brief=buildAtlasCeoBrief([candidate("auto","sales","report.generate",100),candidate("confirm","operations","provider.assignment",50),candidate("approve","finance","refund.issue",10,{moneyMovement:true})],{now});assert.deepEqual(brief.items.map(item=>item.proposal.proposalId),["approve","confirm","auto"]);assert.equal(brief.approvalQueue.length,2);assert.equal(brief.autoExecuteQueue.length,1);assert.equal(brief.autoExecuteQueue[0].proposal.proposalId,"auto");assert.equal(brief.autonomousExecution,"low_risk_internal_only");});

test("CEO brief cannot mix tenants, duplicate proposals or unknown conflicts",()=>{assert.throws(()=>buildAtlasCeoBrief([candidate("a","sales","report.generate",1),{...candidate("b","sales","report.generate",1),proposal:{...candidate("b","sales","report.generate",1).proposal,tenantId:"other"}}],{now}),/mix tenants/);assert.throws(()=>buildAtlasCeoBrief([candidate("a","sales","report.generate",1),candidate("a","sales","report.generate",2)],{now}),/unique/);assert.throws(()=>buildAtlasCeoBrief([{...candidate("a","sales","report.generate",1),conflictsWith:["missing"]}],{now}),/unknown proposal/);});

test("CEO brief detects shared-resource and declared conflicts",()=>{const brief=buildAtlasCeoBrief([{...candidate("a","sales","report.generate",1),resourceKey:"budget:q4",conflictsWith:["b"]},{...candidate("b","marketing","report.generate",2),resourceKey:"budget:q4"}],{now});assert.equal(brief.conflicts.length,2);});

test("CEO brief reports missing executive coverage instead of pretending completeness",()=>{const brief=buildAtlasCeoBrief([candidate("a","sales","report.generate",1)],{now});assert.deepEqual(brief.coverage.represented,["sales"]);assert.ok(brief.coverage.missing.includes("finance"));assert.ok(brief.coverage.missing.includes("risk"));for(const domain of ["ceo","groomer","trainer"])assert.ok(brief.coverage.missing.includes(domain),domain);});

test("Atlas capability map covers requested provider, lead, marketing, hiring and revenue scope",()=>{const codes=new Set(ATLAS_BUSINESS_CAPABILITIES.map(item=>item.code));for(const code of ["provider.smart_assignment","lead.smart_assignment","lead.inbound_qualification","lead.outbound_engagement","marketing.demand_orchestration","hiring.workforce_planning","hiring.candidate_assist","revenue.next_best_action"])assert.ok(codes.has(code),code);for(const vertical of ["grooming","training","boarding","pet_sitting","dog_walking","pet_taxi"])assert.ok(ATLAS_PROVIDER_VERTICALS.includes(vertical),vertical);});

test("roadmap reuses V2 before extension and keeps high-impact autonomy disabled",()=>{const roadmap=atlasCapabilityRoadmap();assert.ok(roadmap.reuse.length>0);assert.ok(roadmap.extend.length>0);assert.ok(roadmap.build.length>0);assert.equal(roadmap.autonomousHighImpactExecution,false);assert.ok(ATLAS_BUSINESS_CAPABILITIES.filter(item=>["lead.outbound_engagement","marketing.demand_orchestration","hiring.workforce_planning","finance.margin_guard","gst.compliance_prepare"].includes(item.code)).every(item=>item.requiresHumanApproval));});
