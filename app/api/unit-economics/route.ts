import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{buildUnitEconomics}from"../../../lib/unit-economics";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const DATE=/^\d{4}-\d{2}-\d{2}$/;

export async function GET(request:Request){try{
 const db=await database(),actor=await resolveActor(request);requirePermission(actor,"reports.view");
 const url=new URL(request.url),from=String(url.searchParams.get("from")||"").trim(),to=String(url.searchParams.get("to")||"").trim(),cityId=String(url.searchParams.get("cityId")||"").trim();
 if((from&&!DATE.test(from))||(to&&!DATE.test(to)))return json({error:"from/to must be YYYY-MM-DD dates"},400);
 return json({data:await buildUnitEconomics(db,{from:from||undefined,to:to||undefined,cityId:cityId||undefined})});
}catch(error){return authError(error,"Unable to build unit economics");}}
