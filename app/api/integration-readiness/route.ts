import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{readIntegrationReadinessSnapshot,recordIntegrationLiveEvidence,requestIntegrationEvidence,updateIntegrationReadiness,type IntegrationEvidenceKind}from"../../../lib/integration-readiness";
import{ensureLoeIntegrationReadiness}from"../../../lib/integration-readiness-loe";
import{readUatSandboxReadiness}from"../../../lib/uat-sandbox-readiness";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin integration readiness write blocked",{status:403});}
async function seedLoeReadiness(db:D1Database){const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;await ensureLoeIntegrationReadiness(db,runtime);return runtime;}
export async function GET(request:Request){
 try{
  const actor=await resolveActor(request);requirePermission(actor,"launch.view");const db=await database();
  const runtime=await seedLoeReadiness(db);
  const url=new URL(request.url),integrationCode=String(url.searchParams.get("integrationCode")||"").trim();
  const{data,blockers,audit,evidenceRequests,liveEvidence}=await readIntegrationReadinessSnapshot(db,runtime,integrationCode||undefined);
  const uatSandbox=await readUatSandboxReadiness(db,runtime);
  return json({data,blockers,audit,evidenceRequests,liveEvidence,uatSandbox,productionReady:false});
 }catch(error){return authError(error,"Unable to load integration readiness");}
}

export async function POST(request:Request){
 try{
  sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"launch.view");const db=await database();await seedLoeReadiness(db);
  let parsed:unknown;try{parsed=await request.json();}catch{return json({error:"Request body must be valid JSON"},400);}if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return json({error:"Request body must be a JSON object"},400);
  const body=parsed as Record<string,unknown>,action=String(body.action||"").trim();
  if(action==="request_evidence"){const data=await requestIntegrationEvidence(db,{integrationCode:String(body.integrationCode||"").trim(),lane:String(body.lane||"").trim(),scenario:String(body.scenario||"").trim(),requirement:String(body.requirement||"").trim(),requestedBy:actor.email});await securityAudit(db,actor,"integration.evidence.request","integration",data.integrationCode,"completed",{lane:data.lane,scenario:data.scenario});return json({data},201);}
  if(action==="record_live_evidence"){requirePermission(actor,"launch.manage");const data=await recordIntegrationLiveEvidence(db,{integrationCode:String(body.integrationCode||"").trim(),scenario:String(body.scenario||"").trim(),providerReference:String(body.providerReference||"").trim(),commitSha:String(body.commitSha||"").trim(),observedAt:Number(body.observedAt),expectedResult:String(body.expectedResult||"").trim(),actualResult:String(body.actualResult||"").trim(),evidenceKind:String(body.evidenceKind||"") as IntegrationEvidenceKind,durableReference:String(body.durableReference||"").trim(),recordedBy:actor.email});await securityAudit(db,actor,"integration.evidence.record","integration",data.integrationCode,"completed",{scenario:data.scenario,matched:data.matched,commitSha:data.commitSha,evidenceKind:data.evidenceKind});return json({data},201);}
  return json({error:"Unsupported integration readiness action"},400);
 }catch(error){return authError(error,"Unable to record integration evidence");}
}

export async function PATCH(request:Request){
 try{
  sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"launch.manage");const db=await database();await seedLoeReadiness(db);
  let patched:unknown;try{patched=await request.json();}catch{return json({error:"Request body must be valid JSON"},400);}if(!patched||typeof patched!=="object"||Array.isArray(patched))return json({error:"Request body must be a JSON object"},400);
  const body=patched as Record<string,unknown>,integrationCode=String(body.integrationCode||"").trim(),reason=String(body.reason||"").trim();const changes=typeof body.changes==="object"&&body.changes?body.changes as Record<string,unknown>:{};
  if(changes.readinessState==="sandbox_verified"&&!String(changes.evidenceReference||"").trim())return json({error:"Sandbox verification must include an evidence reference in the same governed change"},400);if(changes.readinessState==="controlled_live_verified"&&(!String(changes.evidenceReference||"").trim()||!String(changes.approvalReference||"").trim()))return json({error:"Controlled-live verification must include both evidence and approval references in the same governed change"},400);
  const data=await updateIntegrationReadiness(db,{integrationCode,changes,reason,actorId:actor.email,actorRole:actor.roleCode});return json({data,productionReady:false});
 }catch(error){return authError(error,"Unable to update integration readiness");}
}
