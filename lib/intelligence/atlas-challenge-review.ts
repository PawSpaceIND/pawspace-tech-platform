import type {AtlasBusinessSnapshot} from "./atlas-business-snapshot";
type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const parsedArray=(v:unknown)=>{try{const x=JSON.parse(text(v)||"[]");return Array.isArray(x)?x:[]}catch{return[]}};
export type AtlasChallengeReview={proposalId:string;proposalType:string;riskClass:string;status:string;severity:"info"|"warning"|"critical";missingEvidence:string[];contradictions:string[];reasonsNotToAct:string[];challengeCount:number;requiresFounderReview:boolean;advisoryOnly:true;authorityMutationAllowed:false;note:string};
export function challengeAtlasProposal(snapshot:AtlasBusinessSnapshot,proposal:Row):AtlasChallengeReview{
 const missingEvidence:string[]=[],contradictions:string[]=[],reasonsNotToAct:string[]=[];
 const sources=parsedArray(proposal.source_ids_json).map(text).filter(Boolean),risk=text(proposal.risk_class),status=text(proposal.status),action=text(proposal.action_json),type=text(proposal.proposal_type);
 if(snapshot.insufficient_data)missingEvidence.push("business_snapshot_insufficient_data");
 for(const limitation of snapshot.limitations)missingEvidence.push(`snapshot_limitation:${limitation}`);
 if(sources.length===0)missingEvidence.push("proposal_has_no_recorded_source_ids");
 if(!text(proposal.snapshot_hash))missingEvidence.push("proposal_snapshot_hash_missing");
 if(!text(proposal.basis_id))missingEvidence.push("proposal_basis_missing");
 if(risk==="high"&&status==="proposed")reasonsNotToAct.push("high_risk_proposal_requires_human_approval");
 if(status==="rejected")reasonsNotToAct.push("proposal_already_rejected");
 if(status==="executed")reasonsNotToAct.push("proposal_already_executed_do_not_repeat");
 if(/campaign\.activate/.test(action)&&!snapshot.integrations.whatsapp.value)contradictions.push("campaign_activation_considered_while_whatsapp_integration_not_ready");
 if(/campaign\.activate/.test(action)&&!snapshot.mission.value)contradictions.push("campaign_activation_considered_without_current_mission");
 if(/campaign\.activate/.test(action)&&snapshot.mission.value&&snapshot.mission.value.net>=snapshot.mission.value.target)reasonsNotToAct.push("current_mission_target_already_met_or_exceeded");
 const challengeCount=missingEvidence.length+contradictions.length+reasonsNotToAct.length,requiresFounderReview=challengeCount>0||risk==="high",severity:AtlasChallengeReview["severity"]=contradictions.length>0?"critical":missingEvidence.length>0||risk==="high"?"warning":"info";
 return{proposalId:text(proposal.id),proposalType:type,riskClass:risk,status,severity,missingEvidence,contradictions,reasonsNotToAct,challengeCount,requiresFounderReview,advisoryOnly:true,authorityMutationAllowed:false,note:"Challenge review is advisory only. It surfaces reasons to question or defer a recommendation; it never executes, rejects, approves, or changes Atlas authority."};
}
export async function buildAtlasChallengeReview(db:Db,snapshot:AtlasBusinessSnapshot,limit=20):Promise<AtlasChallengeReview[]>{
 try{await db.prepare("SELECT 1 FROM atlas_proposals LIMIT 1").first()}catch{return[]}
 const cap=Math.max(1,Math.min(100,Math.floor(limit))),rows=(await db.prepare(`SELECT id,proposal_type,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json FROM atlas_proposals ORDER BY created_at DESC LIMIT ${cap}`).all<Row>()).results;
 return rows.map(row=>challengeAtlasProposal(snapshot,row)).sort((a,b)=>Number(b.requiresFounderReview)-Number(a.requiresFounderReview)||b.challengeCount-a.challengeCount);
}
