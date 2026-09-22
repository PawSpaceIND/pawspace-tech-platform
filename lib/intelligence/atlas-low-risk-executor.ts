import {DEFAULT_ATLAS_DECISION_POLICY,evaluateAtlasProposal,type AtlasExecutiveProposal} from "./atlas-executive-governance";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const artifactType=(actionCode:string)=>({"brief.generate":"brief","report.generate":"report","task.draft":"task_draft","followup.draft":"followup_draft","case.recommend":"case_recommendation","training.recommend":"training_recommendation"} as Record<string,string>)[actionCode]||"internal_artifact";
async function proposalHash(proposal:AtlasExecutiveProposal){const bytes=new TextEncoder().encode(JSON.stringify(proposal));const hash=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,"0")).join("");}

export async function ensureAtlasOperatingArtifacts(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS atlas_operating_artifacts (id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL UNIQUE,tenant_id TEXT NOT NULL,domain TEXT NOT NULL,action_code TEXT NOT NULL,artifact_type TEXT NOT NULL,summary TEXT NOT NULL,expected_outcome TEXT NOT NULL,proposal_hash TEXT NOT NULL,evidence_json TEXT NOT NULL,content_json TEXT NOT NULL,policy_version TEXT NOT NULL,execution_mode TEXT NOT NULL CHECK(execution_mode='low_risk_internal_only'),status TEXT NOT NULL CHECK(status IN ('generated','superseded')) DEFAULT 'generated',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_atlas_operating_artifacts_created ON atlas_operating_artifacts(created_at DESC)"),
]);}

export async function executeAtlasLowRiskArtifact(db:Db,input:{proposal:AtlasExecutiveProposal;content:Record<string,unknown>;actorId?:string;asOf?:number}){
 await ensureAtlasOperatingArtifacts(db);const asOf=input.asOf??Date.now(),evaluation=evaluateAtlasProposal(input.proposal,{now:asOf});
 if(evaluation.disposition!=="auto_execute_internal"||!evaluation.autonomousExecution)throw new Response("Atlas proposal is not eligible for low-risk internal autonomy",{status:409});
 if(input.proposal.externalCommunication||input.proposal.containsSensitiveData||input.proposal.destructive||input.proposal.legallyBinding||input.proposal.statutoryFiling||input.proposal.employmentDecision||input.proposal.moneyMovement||Number(input.proposal.amountInr||0)!==0)throw new Response("Atlas low-risk executor cannot cross an external, sensitive, money, legal, HR or destructive boundary",{status:409});
 const existing=await db.prepare("SELECT id,status FROM atlas_operating_artifacts WHERE proposal_id=?").bind(input.proposal.proposalId).first<Row>();if(existing)return{id:text(existing.id),status:text(existing.status),executed:true,duplicatePrevented:true,executionMode:"low_risk_internal_only" as const,externalMutation:false as const};
 const id=`ATLASART-${crypto.randomUUID().slice(0,12).toUpperCase()}`,hash=await proposalHash(input.proposal),actorId=text(input.actorId)||"system:atlas-low-risk";
 await db.prepare("INSERT INTO atlas_operating_artifacts (id,proposal_id,tenant_id,domain,action_code,artifact_type,summary,expected_outcome,proposal_hash,evidence_json,content_json,policy_version,execution_mode,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'generated',?,?,?)").bind(id,input.proposal.proposalId,input.proposal.tenantId,input.proposal.domain,input.proposal.actionCode,artifactType(input.proposal.actionCode),input.proposal.summary,input.proposal.expectedOutcome,hash,JSON.stringify(input.proposal.evidence),JSON.stringify(input.content),DEFAULT_ATLAS_DECISION_POLICY.version,"low_risk_internal_only",actorId,asOf,asOf).run();
 return{id,status:"generated" as const,executed:true,duplicatePrevented:false,executionMode:"low_risk_internal_only" as const,externalMutation:false as const};
}

export async function listAtlasOperatingArtifacts(db:Db,limit=20){await ensureAtlasOperatingArtifacts(db);return(await db.prepare(`SELECT id,proposal_id,tenant_id,domain,action_code,artifact_type,summary,expected_outcome,policy_version,execution_mode,status,created_by,created_at,updated_at FROM atlas_operating_artifacts ORDER BY created_at DESC LIMIT ${Math.max(1,Math.min(100,Math.floor(limit)))}`).all<Row>()).results;}
