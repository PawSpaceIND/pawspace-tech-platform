import{authError,authorize,database}from"../../../lib/server-auth";
import{employeePerformanceCenter}from"../../../lib/employee-performance-center";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){try{await authorize(request,"reports.view");const db=await database(),url=new URL(request.url);return json({data:await employeePerformanceCenter(db,{metric:url.searchParams.get("metric"),teamCode:url.searchParams.get("team"),days:Number(url.searchParams.get("days")||30)}),productionReady:false});}catch(error){return authError(error,"Unable to load employee performance");}}
