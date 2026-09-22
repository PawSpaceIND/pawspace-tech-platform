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

export type AtlasCeoBrief={
 generatedAt:number;
 policyVersion:string;
 tenantId:string;
 items:AtlasCeoBriefItem[];
 approvalQueue:AtlasCeoBriefItem[];
 blocked:AtlasCeoBriefItem[];
 advisory:AtlasCeoBriefItem[];
 conflicts:Array<{proposalIds:string[];resourceKey:string}>;
 coverage:{represented:string[];missing:string[]};
 autonomousExecution:false;
};

const REQUIRED_CEO_COVERAGE=["ceo","sales","marketing","operations","customer_success","finance","gst_tax","legal","hr","risk","groomer","trainer"] as const;
const text=(value:unknown)=>String(value??"").trim();

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
 const dispositionWeight=(item:typeof evaluated[number])=>item.evaluation.disposition==="approval_required"?4:item.evaluation.disposition==="ready_for_confirmation"?3:item.evaluation.disposition==="advice_only"?2:1;
 evaluated.sort((a,b)=>Number(b.overdue)-Number(a.overdue)||dispositionWeight(b)-dispositionWeight(a)||b.priorityScore-a.priorityScore||a.proposal.proposalId.localeCompare(b.proposal.proposalId));
 const items=evaluated.map((item,index)=>({...item,rank:index+1}));
 const groups=new Map<string,string[]>();
 for(const item of items){const key=text(item.resourceKey);if(!key)continue;groups.set(key,[...(groups.get(key)??[]),item.proposal.proposalId]);}
 const declared=new Map<string,Set<string>>();
 for(const item of items)for(const other of item.conflictsWith??[]){if(!ids.has(other))throw new Error("Atlas conflict references an unknown proposal");const pair=[item.proposal.proposalId,other].sort(),key=pair.join(":");declared.set(key,new Set(pair));}
 const conflicts=[...groups.entries()].filter(([,proposalIds])=>proposalIds.length>1).map(([resourceKey,proposalIds])=>({resourceKey,proposalIds:[...proposalIds].sort()}));
 for(const pair of declared.values())conflicts.push({resourceKey:"declared_conflict",proposalIds:[...pair]});
 const represented=[...new Set(items.map(item=>item.proposal.domain))].sort();
 return{generatedAt:now,policyVersion:policy.version,tenantId,items,approvalQueue:items.filter(item=>item.evaluation.disposition==="approval_required"||item.evaluation.disposition==="ready_for_confirmation"),blocked:items.filter(item=>item.evaluation.disposition==="blocked"),advisory:items.filter(item=>item.evaluation.disposition==="advice_only"),conflicts,coverage:{represented,missing:REQUIRED_CEO_COVERAGE.filter(domain=>!represented.includes(domain))},autonomousExecution:false};
}
