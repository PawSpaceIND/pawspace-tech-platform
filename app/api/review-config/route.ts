import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{saveReviewConfig,approveReviewConfig,getActiveReviewConfig,listReviewConfigs}from"../../../lib/review-configuration-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin review config write blocked",{status:403});}

// Control (staff) module: design per-service review questions, cadence, channels, links and rewards.
export async function GET(request:Request){
  try{
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
    const serviceCode=String(new URL(request.url).searchParams.get("serviceCode")||"").trim();
    if(serviceCode)return json({data:{active:await getActiveReviewConfig(db,serviceCode)}});
    return json({data:{configs:await listReviewConfigs(db)}});
  }catch(error){return authError(error,"Unable to load review configuration");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
    const body=await request.json() as {action?:string;id?:string;approvalReference?:string}&Record<string,unknown>;
    if(body.action==="approve"){
      if(!body.id||!body.approvalReference)return json({error:"A config id and approval reference are required"},400);
      const data=await approveReviewConfig(db,{id:String(body.id),approvalReference:String(body.approvalReference),actor:actor.email});
      await securityAudit(db,actor,"review_config.approve","review_config",String(body.id),"completed",{serviceCode:data.serviceCode});
      return json({data},200);
    }
    const data=await saveReviewConfig(db,body,actor.email);
    await securityAudit(db,actor,"review_config.save","review_config",data.id,"completed",{serviceCode:data.serviceCode,version:data.version});
    return json({data},201);
  }catch(error){return authError(error,"Unable to save review configuration");}
}
