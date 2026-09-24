import type {AtlasBusinessSnapshot} from "./atlas-business-snapshot";
import type {AtlasProposalFreshness} from "./atlas-proposal-freshness";
import type {AtlasChallengeReview} from "./atlas-challenge-review";
import type {AtlasConsistencyGroup} from "./atlas-recommendation-consistency";
import type {AtlasPolicyCompatibility} from "./atlas-policy-compatibility";
import type {AtlasDecisionInputIntegrity} from "./atlas-decision-input-integrity";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const parsedArray=(v:unknown)=>{try{const x=JSON.parse(text(v)||"[]");return Array.isArray(x)?x:[]}catch{return[]}};

export type AtlasUncertaintyLevel="low"|"moderate"|"high"|"insufficient_evidence";
export type AtlasUncertaintyAssessment={
 proposalId:string;
 proposalType:string;
 status:string;
 uncertaintyLevel:AtlasUncertaintyLevel;
 reasons:string[];
 evidenceSourceCount:number;
 snapshotInsufficient:boolean;
 fresh:boolean|null;
 challengeSeverity:string|null;
 exactEvidenceConsistent:boolean|null;
 policyCompatible:boolean|null;
 decisionInputsReproducible:boolean|null;
 originalConfidenceAvailable:false;
 reconstructedConfidenceAllowed:false;
 confidenceMutationAllowed:false;
 authorityMutationAllowed:false;
 advisoryOnly:true;
 note:string;
};

export function buildAtlasUncertaintyAssessment(input:{
 proposals:Row[];
 snapshot:AtlasBusinessSnapshot;
 freshness:AtlasProposalFreshness[];
 challenges:AtlasChallengeReview[];
 consistency:AtlasConsistencyGroup[];
 policyCompatibility:AtlasPolicyCompatibility[];
 decisionInputIntegrity:AtlasDecisionInputIntegrity[];
}):AtlasUncertaintyAssessment[]{
 const freshness=new Map(input.freshness.map(x=>[x.proposalId,x])),challenges=new Map(input.challenges.map(x=>[x.proposalId,x])),policy=new Map(input.policyCompatibility.map(x=>[x.proposalId,x])),integrity=new Map(input.decisionInputIntegrity.map(x=>[x.proposalId,x])),consistent=new Map<string,boolean>();
 for(const group of input.consistency)for(const id of group.proposalIds)consistent.set(id,group.consistent);
 return input.proposals.map(row=>{
  const proposalId=text(row.id),proposalType=text(row.proposal_type),status=text(row.status),sourceCount=parsedArray(row.source_ids_json).length,fr=freshness.get(proposalId),ch=challenges.get(proposalId),pc=policy.get(proposalId),di=integrity.get(proposalId),exact=consistent.has(proposalId)?consistent.get(proposalId)!:null,reasons:string[]=[];
  if(input.snapshot.insufficient_data)reasons.push("business_snapshot_insufficient_data");
  if(sourceCount===0)reasons.push("proposal_source_evidence_missing");
  if(!fr)reasons.push("freshness_assessment_unavailable");else if(!fr.fresh&&!fr.terminal)reasons.push(fr.reason);
  if(ch&&ch.challengeCount>0)reasons.push(...ch.missingEvidence,...ch.contradictions,...ch.reasonsNotToAct);
  if(exact===false)reasons.push("exact_evidence_replay_inconsistent");else if(exact===null)reasons.push("exact_evidence_replay_unavailable");
  if(!pc)reasons.push("policy_compatibility_unavailable");else if(!pc.compatible)reasons.push(pc.reason);
  if(!di)reasons.push("decision_input_integrity_unavailable");else if(!di.matches)reasons.push(di.reason);
  const unique=[...new Set(reasons)],critical=unique.some(r=>/contradiction|mismatch|changed|inconsistent|insufficient_data|missing$|unverifiable/.test(r)),missingCore=input.snapshot.insufficient_data||sourceCount===0||!fr||!pc||!di;
  const uncertaintyLevel:AtlasUncertaintyLevel=missingCore?"insufficient_evidence":critical?"high":unique.length>0?"moderate":"low";
  return{proposalId,proposalType,status,uncertaintyLevel,reasons:unique,evidenceSourceCount:sourceCount,snapshotInsufficient:input.snapshot.insufficient_data,fresh:fr?.fresh??null,challengeSeverity:ch?.severity??null,exactEvidenceConsistent:exact,policyCompatible:pc?.compatible??null,decisionInputsReproducible:di?.matches??null,originalConfidenceAvailable:false as const,reconstructedConfidenceAllowed:false as const,confidenceMutationAllowed:false as const,authorityMutationAllowed:false as const,advisoryOnly:true as const,note:"This is an explainable uncertainty assessment from recorded evidence and governance signals. Atlas does not reconstruct an unrecorded confidence score, does not mutate confidence automatically, and does not gain authority from a low-uncertainty result."};
 }).sort((a,b)=>({insufficient_evidence:3,high:2,moderate:1,low:0}[b.uncertaintyLevel]-{insufficient_evidence:3,high:2,moderate:1,low:0}[a.uncertaintyLevel]));
}
