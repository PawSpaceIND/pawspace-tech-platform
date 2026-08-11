import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{listTargetCustomers,customerTargetingSummary,runCustomerTargetingSweep}from"../../../lib/customer-targeting-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin targeting write blocked",{status:403});}

// Outbound targeting audience: refreshable top-N ranked customers. Advisory - a human launches outreach.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.view");
    if(url.searchParams.get("mode")==="summary")return json({data:await customerTargetingSummary(db)});
    return json({data:{audience:await listTargetCustomers(db,{limit:Number(url.searchParams.get("limit"))||undefined,segment:url.searchParams.get("segment")||undefined,minScore:url.searchParams.has("minScore")?Number(url.searchParams.get("minScore")):undefined})}});
  }catch(error){return authError(error,"Unable to load target audience");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
    const body=await request.json().catch(()=>({})) as {topN?:number};
    const data=await runCustomerTargetingSweep(db,{force:true,topN:body.topN});
    await securityAudit(db,actor,"customer_targeting.refresh","targeting",null,"completed",data as Record<string,unknown>);
    return json({data},201);
  }catch(error){return authError(error,"Unable to refresh target audience");}
}
