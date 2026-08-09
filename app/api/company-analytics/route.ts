import{authError,authorize,database}from"../../../lib/server-auth";
import{buildCompanyAnalytics}from"../../../lib/company-analytics";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){try{await authorize(request,"reports.view");const url=new URL(request.url),db=await database();const data=await buildCompanyAnalytics(db,{from:url.searchParams.get("from")||undefined,to:url.searchParams.get("to")||undefined,serviceCode:url.searchParams.get("serviceCode")||undefined,zoneId:url.searchParams.get("zoneId")||undefined});return json({data:{...data,source:"canonical_company_metric_layer",staticOperationalCounters:false}});}catch(error){return authError(error,"Unable to load company analytics");}}
