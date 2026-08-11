import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{detectFinanceAnomalies,forecastCashFlow}from"../../../lib/finance-intelligence-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Finance intelligence (advisory): ledger anomaly detection + cash-flow forecast. Nothing auto-reversed.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.view");
    if(url.searchParams.get("mode")==="cashflow-forecast"){
      return json({data:await forecastCashFlow(db,{months:Number(url.searchParams.get("months"))||undefined,trailingMonths:Number(url.searchParams.get("trailingMonths"))||undefined})});
    }
    return json({data:await detectFinanceAnomalies(db,{periodCode:url.searchParams.get("period")||undefined})});
  }catch(error){return authError(error,"Unable to load finance intelligence");}
}
