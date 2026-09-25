import type {AtlasDecisionCommitment} from "./atlas-decision-commitments";

const HOUR=60*60*1000;
export type AtlasCommitmentAssuranceState="overdue"|"due_soon"|"on_track"|"closed";
export type AtlasCommitmentAssurance={
 commitmentId:string;
 proposalId:string|null;
 title:string;
 ownerRole:string;
 dueAt:number;
 expectedOutcome:string;
 state:AtlasCommitmentAssuranceState;
 overdueByMs:number;
 dueInMs:number;
 requiresFounderAttention:boolean;
 outcomeVerified:false;
 trackingOnly:true;
 automaticResolutionAllowed:false;
 authorityMutationAllowed:false;
 executionMutationAllowed:false;
 note:string;
};

export function buildAtlasCommitmentAssurance(
 commitments:AtlasDecisionCommitment[],
 input:{now?:number;dueSoonMs?:number}={}
):AtlasCommitmentAssurance[]{
 const now=input.now??Date.now(),dueSoonMs=Math.max(HOUR,input.dueSoonMs??24*HOUR);
 return commitments.map(item=>{
  const dueInMs=item.dueAt-now;
  const state:AtlasCommitmentAssuranceState=item.status!=="open"?"closed":dueInMs<0?"overdue":dueInMs<=dueSoonMs?"due_soon":"on_track";
  return{
   commitmentId:item.id,proposalId:item.proposalId,title:item.title,ownerRole:item.ownerRole,dueAt:item.dueAt,expectedOutcome:item.expectedOutcome,state,
   overdueByMs:state==="overdue"?Math.abs(dueInMs):0,dueInMs:state==="closed"?0:Math.max(0,dueInMs),
   requiresFounderAttention:state==="overdue",outcomeVerified:false as const,trackingOnly:true as const,automaticResolutionAllowed:false as const,
   authorityMutationAllowed:false as const,executionMutationAllowed:false as const,
   note:"Atlas can detect commitment deadline drift from recorded due dates only. Completion and expected-outcome truth remain human-evidenced; Atlas does not auto-close, verify outcomes, change authority, or execute the underlying business action."
  };
 }).sort((a,b)=>Number(b.requiresFounderAttention)-Number(a.requiresFounderAttention)||a.dueAt-b.dueAt);
}
