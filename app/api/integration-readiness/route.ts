import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{integrationLaunchBlockers,integrationLiveEvidence,integrationReadinessAudit,listIntegrationReadiness,openIntegrationEvidenceRequests,recordIntegrationLiveEvidence,requestIntegrationEvidence,updateIntegrationReadiness,type IntegrationEvidenceKind}from"../../../lib/integration-readiness";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){
 try{
  const actor=await resolveActor(request);requirePermission(actor,"launch.view");const db=await database();
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
  const url=new URL(request.url),integrationCode=String(url.searchParams.get("integrationCode")||"").trim();
  const[data,blockers,audit,evidenceRequests,liveEvidence]=await Promise.all([listIntegrationReadiness(db,runtime),integrationLaunchBlockers(db),integrationReadinessAudit(db,integrationCode||undefined),openIntegrationEvidenceRequests(db),integrationCode?integrationLiveEvidence(db,integrationCode):Promise.resolve([])]);
  return json({data,blockers,audit,evidenceRequests,liveEvidence,productionReady:false});
 }catch(error){return authError(error,"Unable to load integration readiness");}
}

/**
 * Two write shapes that are deliberately NOT part of PATCH.
 *
 * `record_live_evidence` states what a provider actually did; PATCH states what the registry claims.
 * Keeping them apart is what stops a single call both asserting a readiness state and manufacturing the
 * evidence for it in the same breath - the evidence has to exist first, and PATCH then has to point at
 * it by id.
 *
 * `request_evidence` is how another closure lane records what it needs proven. It is a launch.view
 * capability, not launch.manage: asking for proof changes no readiness state.
 */
export async function POST(request:Request){
 try{
  // launch.view is checked before anything is parsed or opened: both actions need at least it, and an
  // anonymous caller must be refused rather than told which action names are valid. The stricter
  // launch.manage check for recording evidence follows once the action is known.
  const actor=await resolveActor(request);requirePermission(actor,"launch.view");
  const db=await database();
  // request.json() REJECTS on truncated input, and JSON.parse("null") returns null - both of which
  // then hit authError as an ordinary exception and answered 500 to what is really a malformed request.
  // Anything that is not a plain object is an absent body, which the action dispatch answers with 400.
  let parsed:unknown;
  try{parsed=await request.json();}catch{return json({error:"Request body must be valid JSON"},400);}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return json({error:"Request body must be a JSON object"},400);
  const body=parsed as Record<string,unknown>,action=String(body.action||"").trim();
  if(action==="request_evidence"){
   const data=await requestIntegrationEvidence(db,{integrationCode:String(body.integrationCode||"").trim(),lane:String(body.lane||"").trim(),scenario:String(body.scenario||"").trim(),requirement:String(body.requirement||"").trim(),requestedBy:actor.email});
   await securityAudit(db,actor,"integration.evidence.request","integration",data.integrationCode,"completed",{lane:data.lane,scenario:data.scenario});
   return json({data},201);
  }
  if(action==="record_live_evidence"){
   requirePermission(actor,"launch.manage");
   const data=await recordIntegrationLiveEvidence(db,{
    integrationCode:String(body.integrationCode||"").trim(),scenario:String(body.scenario||"").trim(),
    providerReference:String(body.providerReference||"").trim(),commitSha:String(body.commitSha||"").trim(),
    observedAt:Number(body.observedAt),expectedResult:String(body.expectedResult||"").trim(),
    actualResult:String(body.actualResult||"").trim(),evidenceKind:String(body.evidenceKind||"") as IntegrationEvidenceKind,
    durableReference:String(body.durableReference||"").trim(),recordedBy:actor.email,
   });
   await securityAudit(db,actor,"integration.evidence.record","integration",data.integrationCode,"completed",{scenario:data.scenario,matched:data.matched,commitSha:data.commitSha,evidenceKind:data.evidenceKind});
   return json({data},201);
  }
  return json({error:"Unsupported integration readiness action"},400);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to record integration evidence");}
}

export async function PATCH(request:Request){
 try{
  const actor=await resolveActor(request);requirePermission(actor,"launch.manage");const db=await database();
  let patched:unknown;
  try{patched=await request.json();}catch{return json({error:"Request body must be valid JSON"},400);}
  if(!patched||typeof patched!=="object"||Array.isArray(patched))return json({error:"Request body must be a JSON object"},400);
  const body=patched as Record<string,unknown>,integrationCode=String(body.integrationCode||"").trim(),reason=String(body.reason||"").trim();
  const changes=typeof body.changes==="object"&&body.changes?body.changes as Record<string,unknown>:{};
  if(changes.readinessState==="sandbox_verified"&&!String(changes.evidenceReference||"").trim())return json({error:"Sandbox verification must include an evidence reference in the same governed change"},400);
  if(changes.readinessState==="controlled_live_verified"&&(!String(changes.evidenceReference||"").trim()||!String(changes.approvalReference||"").trim()))return json({error:"Controlled-live verification must include both evidence and approval references in the same governed change"},400);
  const data=await updateIntegrationReadiness(db,{integrationCode,changes,reason,actorId:actor.email});
  await securityAudit(db,actor,"integration.readiness.update","integration",integrationCode,"completed",{reason,changedFields:Object.keys(changes),readinessState:data.readinessState,productionReady:false});
  return json({data,productionReady:false});
 }catch(error){return authError(error,"Unable to update integration readiness");}
}
