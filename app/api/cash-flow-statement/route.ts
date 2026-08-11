import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{generateCashFlowStatement}from"../../../lib/cash-flow-statement";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Finance report: direct-method cash-flow statement for a period (or a from/to window).
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.view");
    const periodCode=String(url.searchParams.get("period")||"").trim()||undefined;
    const fromPeriod=String(url.searchParams.get("from")||"").trim()||undefined;
    const toPeriod=String(url.searchParams.get("to")||"").trim()||undefined;
    if(!periodCode&&!fromPeriod)return json({error:"A period (YYYY-MM) or from/to window is required"},400);
    return json({data:await generateCashFlowStatement(db,{periodCode,fromPeriod,toPeriod})});
  }catch(error){return authError(error,"Unable to generate cash flow statement");}
}
