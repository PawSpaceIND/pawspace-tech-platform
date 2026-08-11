import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{listChurnRisk,recommendNextService}from"../../../lib/growth-intelligence-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Growth intelligence (advisory): churn risk + per-customer next-best-action. Never auto-contacts.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.view");
    if(url.searchParams.get("mode")==="recommend"){
      const customerId=String(url.searchParams.get("customerId")||"").trim();
      if(!customerId)return json({error:"A customer is required"},400);
      return json({data:await recommendNextService(db,{customerId})});
    }
    return json({data:await listChurnRisk(db,{limit:Number(url.searchParams.get("limit"))||undefined})});
  }catch(error){return authError(error,"Unable to load growth intelligence");}
}
