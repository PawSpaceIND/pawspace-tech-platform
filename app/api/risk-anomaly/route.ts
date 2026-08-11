import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{listRiskFlags,reviewRiskFlag,riskFlagsSummary,runRiskAnomalySweep}from"../../../lib/risk-anomaly-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin risk write blocked",{status:403});}

// Fraud/abuse monitoring over wallet + review-reward flows. Flags are advisory (staff review); no money is auto-blocked.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"reports.view");
    if(url.searchParams.get("mode")==="summary")return json({data:await riskFlagsSummary(db)});
    return json({data:{flags:await listRiskFlags(db,{domain:url.searchParams.get("domain")||undefined,status:url.searchParams.get("status")||undefined,limit:Number(url.searchParams.get("limit"))||undefined})}});
  }catch(error){return authError(error,"Unable to load risk flags");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.manage");
    const body=await request.json() as {action?:string;id?:string;decision?:"cleared"|"actioned";note?:string};
    if(body.action==="rescan"){
      const data=await runRiskAnomalySweep(db,{});
      await securityAudit(db,actor,"risk.rescan","risk",null,"completed",data as Record<string,unknown>);
      return json({data},201);
    }
    // default: review a flag
    if(!body.id||!body.decision||!body.note)return json({error:"A flag id, decision and note are required"},400);
    const data=await reviewRiskFlag(db,{id:body.id,decision:body.decision,note:body.note,actor:actor.email});
    await securityAudit(db,actor,"risk.review","risk_flag",body.id,"completed",{decision:body.decision});
    return json({data},200);
  }catch(error){return authError(error,"Unable to update risk flag");}
}
