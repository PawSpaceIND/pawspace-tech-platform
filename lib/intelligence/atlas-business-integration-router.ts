import {atlasCapability,ATLAS_PROVIDER_VERTICALS} from "./atlas-business-capabilities";
import type {AtlasBusinessCapability} from "./atlas-business-capabilities";
import {DEFAULT_ATLAS_DECISION_POLICY,evaluateAtlasProposal} from "./atlas-executive-governance";
import type {AtlasEvidence,AtlasExecutiveProposal} from "./atlas-executive-governance";

export type AtlasCanonicalAdapter=
 "provider_assignment_policy"|"lead_assignment_governance"|"inbound_ai_lead_capture"|
 "public_lead_outbound"|"governed_marketing_campaigns"|"people_master"|
 "provider_onboarding"|"revenue_opportunity_governance"|"customer_360"|
 "capacity_forecast"|"provider_performance"|"financial_ledger"|"gst_ledger"|"risk_watch";

export type AtlasIntegrationRoute={adapter:AtlasCanonicalAdapter;operation:string};
export const ATLAS_INTEGRATION_ROUTES:Readonly<Record<string,AtlasIntegrationRoute>>={
 "provider.smart_assignment":{adapter:"provider_assignment_policy",operation:"provider.assignment"},
 "lead.smart_assignment":{adapter:"lead_assignment_governance",operation:"lead.assignment"},
 "lead.inbound_qualification":{adapter:"inbound_ai_lead_capture",operation:"lead.qualify"},
 "lead.outbound_engagement":{adapter:"public_lead_outbound",operation:"followup.draft"},
 "marketing.demand_orchestration":{adapter:"governed_marketing_campaigns",operation:"campaign.draft"},
 "hiring.workforce_planning":{adapter:"people_master",operation:"workforce.plan"},
 "hiring.candidate_assist":{adapter:"provider_onboarding",operation:"candidate.screen"},
 "revenue.next_best_action":{adapter:"revenue_opportunity_governance",operation:"revenue.action"},
 "retention.churn_recovery":{adapter:"customer_360",operation:"recovery.draft"},
 "capacity.demand_forecast":{adapter:"capacity_forecast",operation:"forecast.generate"},
 "quality.provider_coaching":{adapter:"provider_performance",operation:"training.recommend"},
 "finance.margin_guard":{adapter:"financial_ledger",operation:"margin.recommend"},
 "gst.compliance_prepare":{adapter:"gst_ledger",operation:"gst.prepare"},
 "risk.business_watch":{adapter:"risk_watch",operation:"risk.review"},
};

export type AtlasBusinessIntegrationInput={
 requestId:string;tenantId:string;capabilityCode:string;objective:string;summary:string;
 expectedOutcome:string;confidence:number;evidence:AtlasEvidence[];serviceVertical?:string;
 targetCustomerId?:string;amountInr?:number;
};

export type AtlasBusinessIntegrationPlan={
 requestId:string;tenantId:string;capability:AtlasBusinessCapability;route:AtlasIntegrationRoute;
 proposal:AtlasExecutiveProposal;evaluation:ReturnType<typeof evaluateAtlasProposal>;
 decisionGate:"advice_only"|"confirmation"|"human_approval"|"blocked";
 executeAllowed:false;idempotencyKey:string;
};

const text=(value:unknown)=>String(value??"").trim();
const approvalFlags=(code:string)=>({
 externalCommunication:["lead.outbound_engagement","marketing.demand_orchestration","retention.churn_recovery"].includes(code),
 employmentDecision:code==="hiring.candidate_assist",
 statutoryFiling:code==="gst.compliance_prepare",
});

export function buildAtlasBusinessIntegrationPlan(input:AtlasBusinessIntegrationInput):AtlasBusinessIntegrationPlan{
 const requestId=text(input.requestId),tenantId=text(input.tenantId);
 if(!requestId||!tenantId)throw new Error("Atlas integration request and tenant identity are required");
 const capability=atlasCapability(input.capabilityCode),route=ATLAS_INTEGRATION_ROUTES[capability.code];
 if(!route)throw new Error("Atlas capability has no canonical integration route");
 if(capability.code==="provider.smart_assignment"){
  const vertical=text(input.serviceVertical);
  if(!ATLAS_PROVIDER_VERTICALS.includes(vertical as typeof ATLAS_PROVIDER_VERTICALS[number]))
   throw new Error("Atlas provider assignment requires a supported service vertical");
 }
 const proposal:AtlasExecutiveProposal={
  proposalId:requestId,tenantId,domain:capability.domain,objective:text(input.objective),
  actionCode:route.operation,summary:text(input.summary),evidence:input.evidence,
  confidence:input.confidence,expectedOutcome:text(input.expectedOutcome),
  amountInr:input.amountInr,targetCustomerId:input.targetCustomerId,
  policyVersion:DEFAULT_ATLAS_DECISION_POLICY.version,...approvalFlags(capability.code),
 };
 const evaluation=evaluateAtlasProposal(proposal);
 const decisionGate=evaluation.disposition==="blocked"?"blocked":
  capability.requiresHumanApproval||evaluation.disposition==="approval_required"?"human_approval":
  evaluation.disposition==="ready_for_confirmation"?"confirmation":"advice_only";
 return{requestId,tenantId,capability,route,proposal,evaluation,decisionGate,
  executeAllowed:false,idempotencyKey:`atlas:${tenantId}:${capability.code}:${requestId}`};
}

export function atlasIntegrationCoverage(){
 const capabilityCodes=Object.keys(ATLAS_INTEGRATION_ROUTES);
 return{capabilityCodes,complete:capabilityCodes.length===14,
  autonomousExecution:false,canonicalAdapters:[...new Set(Object.values(ATLAS_INTEGRATION_ROUTES).map(item=>item.adapter))]};
}
