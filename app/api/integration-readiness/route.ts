import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{integrationLaunchBlockers,integrationReadinessAudit,listIntegrationReadiness,updateIntegrationReadiness}from"../../../lib/integration-readiness";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){
 try{
  const actor=await resolveActor(request);requirePermission(actor,"launch.view");const db=await database();
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
  const url=new URL(request.url),integrationCode=String(url.searchParams.get("integrationCode")||"").trim();
  const[data,blockers,audit]=await Promise.all([listIntegrationReadiness(db,runtime),integrationLaunchBlockers(db),integrationReadinessAudit(db,integrationCode||undefined)]);
  return json({data,blockers,audit,productionReady:false});
 }catch(error){return authError(error,"Unable to load integration readiness");}
}

export async function PATCH(request:Request){
 try{
  const actor=await resolveActor(request);requirePermission(actor,"launch.manage");const db=await database();
  const body=await request.json() as Record<string,unknown>,integrationCode=String(body.integrationCode||"").trim(),reason=String(body.reason||"").trim();
  const changes=typeof body.changes==="object"&&body.changes?body.changes as Record<string,unknown>:{};
  if(changes.readinessState==="sandbox_verified"&&!String(changes.evidenceReference||"").trim())return json({error:"Sandbox verification must include an evidence reference in the same governed change"},400);
  if(changes.readinessState==="controlled_live_verified"&&(!String(changes.evidenceReference||"").trim()||!String(changes.approvalReference||"").trim()))return json({error:"Controlled-live verification must include both evidence and approval references in the same governed change"},400);
  const data=await updateIntegrationReadiness(db,{integrationCode,changes,reason,actorId:actor.email});
  await securityAudit(db,actor,"integration.readiness.update","integration",integrationCode,"completed",{reason,changedFields:Object.keys(changes),readinessState:data.readinessState,productionReady:false});
  return json({data,productionReady:false});
 }catch(error){return authError(error,"Unable to update integration readiness");}
}
