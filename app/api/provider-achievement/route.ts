import{authError,authorize,database}from"../../../lib/server-auth";
import{providerAchievement}from"../../../lib/provider-achievement";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){try{await authorize(request,"reports.view");const db=await database(),url=new URL(request.url),providerId=url.searchParams.get("providerId"),from=url.searchParams.get("from"),to=url.searchParams.get("to");const data=await providerAchievement(db,{providerId,from:from?Number(from):null,to:to?Number(to):null});return json({data,productionReady:false});}catch(error){return authError(error,"Unable to load provider achievement");}}
