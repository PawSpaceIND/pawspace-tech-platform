import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{aiRolloutSnapshot,setAiRolloutStage,type RolloutStage}from"../../../lib/ai-audience-rollout";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin rollout write blocked",{status:403});}

// Staff-first AI rollout control. GET the current stage; POST to move it (off -> staff_only -> customers).
export async function GET(request:Request){
  try{
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"settings.manage");
    return json({data:await aiRolloutSnapshot(db)});
  }catch(error){return authError(error,"Unable to load AI rollout status");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"settings.manage");
    const body=await request.json().catch(()=>({})) as {stage?:string;reason?:string};
    const stage=String(body.stage||"").trim() as RolloutStage;
    const data=await setAiRolloutStage(db,{stage,reason:body.reason,actorEmail:actor.email});
    await securityAudit(db,actor,"ai_rollout.set_stage","ai_rollout",stage,"completed",{stage,reason:body.reason||null});
    return json({data},201);
  }catch(error){return authError(error,"Unable to update AI rollout stage");}
}
