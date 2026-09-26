import{authError,authorize,database}from"../../../lib/server-auth";
import{buildCompanyAnalytics}from"../../../lib/company-analytics";
import{resolveManagerOrganizationalScope}from"../../../lib/organizational-scope";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){try{const actor=await authorize(request,"reports.view");const url=new URL(request.url),db=await database();
// A city-scoped manager with reports access sees their own city, the same scope the booking drill-down enforces.
const scope=await resolveManagerOrganizationalScope(db,actor);const data=await buildCompanyAnalytics(db,{cityId:scope?.cityId,from:url.searchParams.get("from")||undefined,to:url.searchParams.get("to")||undefined,serviceCode:url.searchParams.get("serviceCode")||undefined,zoneId:url.searchParams.get("zoneId")||undefined});return json({data:{...data,source:"canonical_company_metric_layer",staticOperationalCounters:false}});}catch(error){return authError(error,"Unable to load company analytics");}}
