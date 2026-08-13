import{authError,authorize,database}from"../../../lib/server-auth";
import{buildOperationsOverview}from"../../../lib/operations-overview";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Live data for the Operations Overview screen (/admin). Read-only.
export async function GET(request:Request){
  try{
    await authorize(request,"dashboard.view");
    const url=new URL(request.url),db=await database();
    const asOfParam=url.searchParams.get("asOf"),asOf=asOfParam?Number(asOfParam):undefined;
    const data=await buildOperationsOverview(db,{asOf:Number.isFinite(asOf)?asOf:undefined,zoneId:url.searchParams.get("zoneId")||undefined});
    return json({data});
  }catch(error){return authError(error,"Unable to load the operations overview");}
}
