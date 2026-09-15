import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{runProviderVerification,recordManualVerification,recordOfflineAttestedVerification,setCategoryMandate,verificationMandateStatus,verificationMandatesSnapshot}from"../../../lib/provider-verification-mandate";
import{idfyConfigured}from"../../../lib/idfy-verification-client";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin verification write blocked",{status:403});}
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Per-category provider verification mandate + IDfy-backed checks. providers.manage gated.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"providers.manage");
    const applicationId=url.searchParams.get("applicationId"),category=url.searchParams.get("category");
    if(applicationId&&category)return json({data:await verificationMandateStatus(db,{applicationId,category})});
    /* WHETHER automation exists, never what it is configured with. Without this the console could not
     * tell an operator why "Run via IDfy" only ever answers 'pending', and had no basis on which to
     * offer the offline attestation instead. [R3-B2] */
    return json({data:{...await verificationMandatesSnapshot(db),idfyConnected:idfyConfigured(await runtime())}});
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
    /* A SEPARATE action, not a loosening of record_manual. record_manual still refuses an automatable
     * check by name, because hand-recording one where IDfy exists is exactly the forgery that rule
     * prevents. This one refuses wherever IDfy IS connected, demands written evidence, and records the
     * person who attested it - so the two rules cover the whole space between them. [R3-B2] */
    if(action==="record_offline_verification"){const data=await recordOfflineAttestedVerification(db,env,{applicationId:String(body.applicationId||""),verificationType:String(body.verificationType||""),status:String(body.status||""),note:String(body.note||""),method:body.method?String(body.method):undefined,actorId:actor.email});await securityAudit(db,actor,"provider.verification.record_offline_attested","provider_verification",String(body.applicationId||""),"completed",{verificationType:data.verificationType,status:data.status,offlineAttested:true,automated:false,method:data.method,attestedBy:actor.email});return json({data},201);}
    if(action==="set_mandate"){const data=await setCategoryMandate(db,{category:String(body.category||""),verificationTypes:(body.verificationTypes as string[])||[],actorId:actor.email});await securityAudit(db,actor,"provider.verification.set_mandate","provider_category",String(body.category||""),"completed",{verificationTypes:data.verificationTypes});return json({data},201);}
    return json({error:"Unsupported action. Use run | record_manual | record_offline_verification | set_mandate"},400);
  }catch(error){return authError(error,"Unable to update verification");}
}
