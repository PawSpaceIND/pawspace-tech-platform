import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{rankProvidersForBooking,forecastDemand}from"../../../lib/ops-intelligence-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Ops intelligence (advisory): provider-matching rank + demand forecast. Never auto-assigns.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"scheduling.view");
    const mode=url.searchParams.get("mode")||"forecast";
    if(mode==="rank"){
      const serviceCode=String(url.searchParams.get("serviceCode")||"").trim();
      if(!serviceCode)return json({error:"A service is required"},400);
      const providers=(url.searchParams.get("providers")||"").split(",").map(s=>s.trim()).filter(Boolean);
      return json({data:await rankProvidersForBooking(db,{serviceCode,candidateProviderIds:providers.length?providers:undefined})});
    }
    return json({data:await forecastDemand(db,{serviceCode:url.searchParams.get("serviceCode")||undefined,cityId:url.searchParams.get("cityId")||undefined,horizonDays:Number(url.searchParams.get("horizonDays"))||undefined})});
  }catch(error){return authError(error,"Unable to load ops intelligence");}
}
