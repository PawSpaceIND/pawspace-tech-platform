import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{runProviderVerification,recordManualVerification,setCategoryMandate,verificationMandateStatus,verificationMandatesSnapshot}from"../../../lib/provider-verification-mandate";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin verification write blocked",{status:403});}
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Per-category provider verification mandate + IDfy-backed checks. providers.manage gated.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"providers.manage");
    const applicationId=url.searchParams.get("applicationId"),category=url.searchParams.get("category");
    if(applicationId&&category)return json({data:await verificationMandateStatus(db,{applicationId,category})});
    return json({data:await verificationMandatesSnapshot(db)});
  }catch(error){return authError(error,"Unable to load verification mandate");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),env=await runtime(),actor=await resolveActor(request);requirePermission(actor,"providers.manage");
    const body=await request.json().catch(()=>({})) as Record<string,unknown>;
    const action=String(body.action||"").trim();
    if(action==="run"){const data=await runProviderVerification(db,env,{applicationId:String(body.applicationId||""),category:String(body.category||""),verificationType:String(body.verificationType||""),payload:body.payload as Record<string,unknown>,actorId:actor.email});await securityAudit(db,actor,"provider.verification.run","provider_verification",String(body.applicationId||""),"completed",{verificationType:body.verificationType,status:data.status});return json({data},201);}
    if(action==="record_manual"){const data=await recordManualVerification(db,{applicationId:String(body.applicationId||""),verificationType:String(body.verificationType||""),status:String(body.status||"") as "verified"|"failed"|"manual_review",note:body.note as string,actorId:actor.email});await securityAudit(db,actor,"provider.verification.record_manual","provider_verification",String(body.applicationId||""),"completed",{verificationType:body.verificationType,status:body.status});return json({data},201);}
    if(action==="set_mandate"){const data=await setCategoryMandate(db,{category:String(body.category||""),verificationTypes:(body.verificationTypes as string[])||[],actorId:actor.email});await securityAudit(db,actor,"provider.verification.set_mandate","provider_category",String(body.category||""),"completed",{verificationTypes:data.verificationTypes});return json({data},201);}
    return json({error:"Unsupported action. Use run | record_manual | set_mandate"},400);
  }catch(error){return authError(error,"Unable to update verification");}
}
