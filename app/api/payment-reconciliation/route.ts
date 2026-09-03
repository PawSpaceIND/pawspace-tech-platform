import{authError,completeReservedSecurityAudit,database,requirePermission,reserveSecurityAudit,resolveActor}from"../../../lib/server-auth";
import{listPaymentExceptions,resolvePaymentException}from"../../../lib/grooming-payment-reconciliation";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin reconciliation write blocked",{status:403});}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.view");
    return json({data:{exceptions:await listPaymentExceptions(db,{status:url.searchParams.get("status")||undefined})}});
  }catch(error){return authError(error,"Unable to load payment exceptions");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.manage");
    const body=await request.json() as {exceptionId?:string;action?:string;bookingId?:string;note?:string};
    if(!body.exceptionId||!body.action||!body.note)return json({error:"An exception, action and note are required"},400);
    const auditAction="payment.exception.resolve",resourceId=body.exceptionId;
    const operationId=await reserveSecurityAudit(db,actor,auditAction,"payment_exception",resourceId,{action:body.action,bookingId:body.bookingId});
    try{
      const data=await resolvePaymentException(db,{exceptionId:body.exceptionId,action:body.action,bookingId:body.bookingId,actorId:actor.email,note:body.note});
      await completeReservedSecurityAudit(db,actor,operationId,auditAction,"payment_exception",resourceId,"completed",{action:body.action,bookingId:body.bookingId});
      return json({data},200);
    }catch(error){
      await completeReservedSecurityAudit(db,actor,operationId,auditAction,"payment_exception",resourceId,"rejected",{action:body.action,bookingId:body.bookingId,error:error instanceof Error?error.message:"payment_exception_resolution_failed"}).catch(()=>{});
      throw error;
    }
  }catch(error){return authError(error,"Unable to resolve payment exception");}
}
