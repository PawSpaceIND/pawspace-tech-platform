import type {AtlasDecisionPolicy,AtlasExecutiveProposal} from "./atlas-executive-governance";
import {DEFAULT_ATLAS_DECISION_POLICY,evaluateAtlasProposal} from "./atlas-executive-governance";

export type AtlasExecutiveCandidate={
 proposal:AtlasExecutiveProposal;
 ownerRole:string;
 priorityScore:number;
 deadlineAt?:number;
 resourceKey?:string;
 conflictsWith?:string[];
};

export type AtlasCeoBriefItem=AtlasExecutiveCandidate&{
 evaluation:ReturnType<typeof evaluateAtlasProposal>;
 rank:number;
 overdue:boolean;
};

export type AtlasConflictArbitration={
 resourceKey:string;
 proposalIds:string[];
 domains:string[];
 orderedProposalIds:string[];
 recommendedFirstProposalId:string|null;
 status:"clear_precedence_for_founder_review"|"founder_tradeoff_required"|"all_candidates_blocked";
 reasons:string[];
 requiresFounderReview:true;
 automaticResolutionAllowed:false;
 authorityMutationAllowed:false;
 executionMutationAllowed:false;
 note:string;
};

export type AtlasCeoBrief={
 generatedAt:number;
 policyVersion:string;
 tenantId:string;
 items:AtlasCeoBriefItem[];
 approvalQueue:AtlasCeoBriefItem[];
 blocked:AtlasCeoBriefItem[];
 advisory:AtlasCeoBriefItem[];
 autoExecuteQueue:AtlasCeoBriefItem[];
 conflicts:Array<{proposalIds:string[];resourceKey:string}>;
 arbitrations:AtlasConflictArbitration[];
 coverage:{represented:string[];missing:string[]};
 autonomousExecution:"low_risk_internal_only";
};

const REQUIRED_CEO_COVERAGE=["ceo","sales","marketing","operations","customer_success","finance","gst_tax","legal","hr","risk","groomer","trainer"] as const;
const text=(value:unknown)=>String(value??"").trim();


function arbitrationForConflict(conflict:{proposalIds:string[];resourceKey:string},items:AtlasCeoBriefItem[]):AtlasConflictArbitration{
 const byId=new Map(items.map(item=>[item.proposal.proposalId,item])),members=conflict.proposalIds.map(id=>byId.get(id)).filter((item):item is AtlasCeoBriefItem=>Boolean(item)),reasons:string[]=[];
 const eligible=members.filter(item=>item.evaluation.disposition!=="blocked"),obligation=(item:AtlasCeoBriefItem)=>Boolean(item.proposal.statutoryFiling||item.proposal.legallyBinding),ordered=[...eligible].sort((a,b)=>Number(obligation(b))-Number(obligation(a))||Number(b.overdue)-Number(a.overdue)||b.priorityScore-a.priorityScore||a.rank-b.rank);
 if(!eligible.length)return{resourceKey:conflict.resourceKey,proposalIds:[...conflict.proposalIds],domains:[...new Set(members.map(item=>item.proposal.domain))].sort(),orderedProposalIds:members.map(item=>item.proposal.proposalId),recommendedFirstProposalId:null,status:"all_candidates_blocked",reasons:["all_conflicting_candidates_are_currently_blocked"],requiresFounderReview:true,automaticResolutionAllowed:false,authorityMutationAllowed:false,executionMutationAllowed:false,note:"All conflicting candidates are blocked by existing governance. Atlas does not choose or execute any candidate."};
 const top=ordered[0],second=ordered[1];let clear=false;
 if(members.some(item=>item.evaluation.disposition==="blocked")){reasons.push("blocked_candidates_cannot_take_precedence");clear=eligible.length===1;}
 if(second){if(obligation(top)!==obligation(second)){reasons.push(obligation(top)?"statutory_or_legal_obligation_precedes_non_obligation":"non_obligation_cannot_displace_statutory_or_legal_obligation");clear=obligation(top);}else if(top.overdue!==second.overdue){reasons.push("overdue_deadline_precedes_non_overdue_work");clear=top.overdue;}else if(top.priorityScore-second.priorityScore>=15){reasons.push("explicit_priority_gap_supports_precedence");clear=true;}else reasons.push("cross_domain_tradeoff_is_materially_ambiguous");}else{reasons.push("only_one_conflicting_candidate_is_currently_eligible");clear=true;}
 const status=clear?"clear_precedence_for_founder_review" as const:"founder_tradeoff_required" as const;
 return{resourceKey:conflict.resourceKey,proposalIds:[...conflict.proposalIds],domains:[...new Set(members.map(item=>item.proposal.domain))].sort(),orderedProposalIds:ordered.map(item=>item.proposal.proposalId),recommendedFirstProposalId:clear?top.proposal.proposalId:null,status,reasons:[...new Set(reasons)],requiresFounderReview:true,automaticResolutionAllowed:false,authorityMutationAllowed:false,executionMutationAllowed:false,note:clear?"Atlas found explainable precedence for Founder review only. Existing approval, consent, money, legal, HR and execution controls remain unchanged.":"Atlas found no sufficiently strong governed precedence. Founder must decide the tradeoff; Atlas does not break the tie or execute either side."};
}
export function buildAtlasCeoBrief(candidates:AtlasExecutiveCandidate[],options:{now?:number;policy?:AtlasDecisionPolicy}={}):AtlasCeoBrief{
 if(!Array.isArray(candidates)||!candidates.length)throw new Error("Atlas CEO brief requires at least one executive proposal");
 const now=options.now??Date.now(),policy=options.policy??DEFAULT_ATLAS_DECISION_POLICY;
 const tenantId=text(candidates[0].proposal.tenantId);
 if(!tenantId||candidates.some(item=>text(item.proposal.tenantId)!==tenantId))throw new Error("Atlas CEO brief cannot mix tenants");
 const ids=new Set<string>();
 for(const item of candidates){
  if(ids.has(item.proposal.proposalId))throw new Error("Atlas CEO brief proposal IDs must be unique");
  ids.add(item.proposal.proposalId);
  if(!text(item.ownerRole))throw new Error("Atlas CEO brief owner role is required");
  if(!Number.isFinite(item.priorityScore)||item.priorityScore<0||item.priorityScore>100)throw new Error("Atlas priority score must be between 0 and 100");
 }
 const evaluated=candidates.map(item=>({...item,evaluation:evaluateAtlasProposal(item.proposal,{now,policy}),rank:0,overdue:item.deadlineAt!==undefined&&item.deadlineAt<now}));
 const dispositionWeight=(item:typeof evaluated[number])=>item.evaluation.disposition==="approval_required"?5:item.evaluation.disposition==="ready_for_confirmation"?4:item.evaluation.disposition==="auto_execute_internal"?3:item.evaluation.disposition==="advice_only"?2:1;
 evaluated.sort((a,b)=>Number(b.overdue)-Number(a.overdue)||dispositionWeight(b)-dispositionWeight(a)||b.priorityScore-a.priorityScore||a.proposal.proposalId.localeCompare(b.proposal.proposalId));
 const items=evaluated.map((item,index)=>({...item,rank:index+1}));
 const groups=new Map<string,string[]>();
 for(const item of items){const key=text(item.resourceKey);if(!key)continue;groups.set(key,[...(groups.get(key)??[]),item.proposal.proposalId]);}
 const declared=new Map<string,Set<string>>();
 for(const item of items)for(const other of item.conflictsWith??[]){if(!ids.has(other))throw new Error("Atlas conflict references an unknown proposal");const pair=[item.proposal.proposalId,other].sort(),key=pair.join(":");declared.set(key,new Set(pair));}
 const conflicts=[...groups.entries()].filter(([,proposalIds])=>proposalIds.length>1).map(([resourceKey,proposalIds])=>({resourceKey,proposalIds:[...proposalIds].sort()}));
 for(const pair of declared.values())conflicts.push({resourceKey:"declared_conflict",proposalIds:[...pair]});
 const arbitrations=conflicts.map(conflict=>arbitrationForConflict(conflict,items));
 const represented=[...new Set(items.map(item=>item.proposal.domain))].sort();
 return{generatedAt:now,policyVersion:policy.version,tenantId,items,approvalQueue:items.filter(item=>item.evaluation.disposition==="approval_required"||item.evaluation.disposition==="ready_for_confirmation"),blocked:items.filter(item=>item.evaluation.disposition==="blocked"),advisory:items.filter(item=>item.evaluation.disposition==="advice_only"),autoExecuteQueue:items.filter(item=>item.evaluation.disposition==="auto_execute_internal"),conflicts,arbitrations,coverage:{represented,missing:REQUIRED_CEO_COVERAGE.filter(domain=>!represented.includes(domain))},autonomousExecution:"low_risk_internal_only"};
}
