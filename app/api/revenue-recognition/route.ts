import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{recordDeferredRevenue,recognizeSubscriptionUsage,recognizeAdvanceBooking,deferredRevenueBalance,recognizedRevenueForPeriod,getRevenueSchedule}from"../../../lib/revenue-recognition-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin revenue write blocked",{status:403});}

// Finance module: accrual-basis revenue recognition (subscriptions per used session, advance bookings on utilisation).
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.view");
    const sourceId=String(url.searchParams.get("sourceId")||"").trim();
    if(sourceId)return json({data:{schedule:await getRevenueSchedule(db,sourceId)}});
    const period=String(url.searchParams.get("period")||"").trim();
    if(period)return json({data:{recognized:await recognizedRevenueForPeriod(db,period),deferred:await deferredRevenueBalance(db)}});
    return json({data:{deferred:await deferredRevenueBalance(db)}});
  }catch(error){return authError(error,"Unable to load revenue recognition");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.manage");
    const body=await request.json() as {action?:string;sourceType?:string;sourceId?:string;customerId?:string;serviceCode?:string;totalAmount?:number;totalUnits?:number;collectedToBank?:boolean;sessionsConsumed?:number;at?:string};
    if(body.action==="recognize_subscription"){
      if(!body.sourceId||body.sessionsConsumed==null)return json({error:"Source and sessionsConsumed are required"},400);
      const data=await recognizeSubscriptionUsage(db,{sourceId:body.sourceId,sessionsConsumed:body.sessionsConsumed,at:body.at,actorId:actor.email});
      await securityAudit(db,actor,"revenue.recognize_subscription","subscription",body.sourceId,"completed",{sessionsConsumed:body.sessionsConsumed});
      return json({data},201);
    }
    if(body.action==="recognize_advance"){
      if(!body.sourceId)return json({error:"A source is required"},400);
      const data=await recognizeAdvanceBooking(db,{sourceId:body.sourceId,at:body.at,actorId:actor.email});
      await securityAudit(db,actor,"revenue.recognize_advance","advance_booking",body.sourceId,"completed",{});
      return json({data},201);
    }
    // default: record a deferred-revenue schedule (subscription or advance_booking)
    if(!body.sourceType||!body.sourceId||!body.customerId||!body.totalAmount)return json({error:"Source type, source, customer and total amount are required"},400);
    const data=await recordDeferredRevenue(db,{sourceType:body.sourceType,sourceId:body.sourceId,customerId:body.customerId,serviceCode:body.serviceCode,totalAmount:body.totalAmount,totalUnits:body.totalUnits,collectedToBank:body.collectedToBank,at:body.at,actorId:actor.email});
    await securityAudit(db,actor,"revenue.record_deferred",body.sourceType,body.sourceId,"completed",{totalAmount:body.totalAmount,totalUnits:body.totalUnits});
    return json({data},201);
  }catch(error){return authError(error,"Unable to record revenue recognition");}
}
