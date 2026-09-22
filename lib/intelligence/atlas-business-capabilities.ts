import type {AtlasExecutiveDomain} from "./atlas-executive-governance";

export type AtlasCapabilityStatus="reuse_existing"|"extend_existing"|"new";
export type AtlasBusinessCapability={
 code:string;
 domain:AtlasExecutiveDomain;
 status:AtlasCapabilityStatus;
 canonicalSystems:readonly string[];
 outcomes:readonly string[];
 requiresHumanApproval:boolean;
};

export const ATLAS_BUSINESS_CAPABILITIES:readonly AtlasBusinessCapability[]=[
 {code:"provider.smart_assignment",domain:"operations",status:"extend_existing",canonicalSystems:["uat-scheduling","provider_work_orders","scheduling_reservations"],outcomes:["fill_rate","acceptance_time","travel_efficiency","service_quality"],requiresHumanApproval:false},
 {code:"lead.smart_assignment",domain:"sales",status:"reuse_existing",canonicalSystems:["lead-auto-assignment","crm_leads","sla-escalation"],outcomes:["first_response_sla","owner_load_balance","conversion"],requiresHumanApproval:false},
 {code:"lead.inbound_qualification",domain:"sales",status:"reuse_existing",canonicalSystems:["public-contact","canonical-conversations","crm"],outcomes:["qualified_rate","response_time","conversion"],requiresHumanApproval:false},
 {code:"lead.outbound_engagement",domain:"sales",status:"extend_existing",canonicalSystems:["outbound-routing","voice-outbound-governance","communication-outbox"],outcomes:["contact_rate","followup_completion","conversion"],requiresHumanApproval:true},
 {code:"marketing.demand_orchestration",domain:"marketing",status:"extend_existing",canonicalSystems:["governed_marketing_campaigns","revenue-targets","consent-governance"],outcomes:["incremental_revenue","return_on_spend","capacity_utilization"],requiresHumanApproval:true},
 {code:"hiring.workforce_planning",domain:"hr",status:"new",canonicalSystems:["people-master","provider-onboarding","capacity-forecast"],outcomes:["time_to_fill","capacity_gap","quality_of_hire"],requiresHumanApproval:true},
 {code:"hiring.candidate_assist",domain:"hr",status:"extend_existing",canonicalSystems:["provider-onboarding","assessment","interview-handoff"],outcomes:["screening_time","completion_rate","interview_quality"],requiresHumanApproval:true},
 {code:"revenue.next_best_action",domain:"ceo",status:"reuse_existing",canonicalSystems:["revenue-opportunity-governance","customer-360","canonical-bookings"],outcomes:["net_collected_revenue","repeat_rate","cross_sell_conversion"],requiresHumanApproval:false},
 {code:"retention.churn_recovery",domain:"customer_success",status:"extend_existing",canonicalSystems:["customer-360","canonical-conversations","case-center"],outcomes:["retention","repeat_booking","complaint_recovery"],requiresHumanApproval:true},
 {code:"capacity.demand_forecast",domain:"operations",status:"new",canonicalSystems:["canonical-bookings","provider-roster","city-zone-demand"],outcomes:["forecast_accuracy","unfilled_demand","provider_utilization"],requiresHumanApproval:false},
 {code:"quality.provider_coaching",domain:"groomer",status:"extend_existing",canonicalSystems:["service-proof","ratings","provider-performance"],outcomes:["quality_score","repeat_complaints","training_completion"],requiresHumanApproval:true},
 {code:"finance.margin_guard",domain:"finance",status:"extend_existing",canonicalSystems:["financial-ledger","pricing-policy","payment-reconciliation"],outcomes:["contribution_margin","leakage","collection_rate"],requiresHumanApproval:true},
 {code:"gst.compliance_prepare",domain:"gst_tax",status:"extend_existing",canonicalSystems:["gst-ledger","invoice-register","payment-reconciliation"],outcomes:["reconciliation_accuracy","filing_readiness","exception_age"],requiresHumanApproval:true},
 {code:"risk.business_watch",domain:"risk",status:"extend_existing",canonicalSystems:["security-audit","approval-queue","anomaly-signals"],outcomes:["prevented_loss","policy_breaches","resolution_time"],requiresHumanApproval:true},
] as const;

export const ATLAS_PROVIDER_VERTICALS=["grooming","training","boarding","pet_sitting","dog_walking","pet_taxi","veterinary","fresh_food","relocation","funeral_memorial"] as const;

export function atlasCapability(code:string){const capability=ATLAS_BUSINESS_CAPABILITIES.find(item=>item.code===code);if(!capability)throw new Error("Unknown Atlas business capability");return capability;}

export function atlasCapabilityRoadmap(){return{reuse:ATLAS_BUSINESS_CAPABILITIES.filter(item=>item.status==="reuse_existing"),extend:ATLAS_BUSINESS_CAPABILITIES.filter(item=>item.status==="extend_existing"),build:ATLAS_BUSINESS_CAPABILITIES.filter(item=>item.status==="new"),providerVerticals:[...ATLAS_PROVIDER_VERTICALS],autonomousHighImpactExecution:false};}
