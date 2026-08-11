import{authError,database,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{creditWallet,redeemWalletForBooking,walletHistory}from"../../../lib/pawspace-wallet-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin wallet write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    return json({data:await walletHistory(db,customerId)});
  }catch(error){return authError(error,"Unable to load wallet");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {action?:string;customerId?:string;amount?:number;source?:string;sourceId?:string;idempotencyKey?:string;note?:string;bookingId?:string;walletAmount?:number};
    // Staff-gated credit (refund / cancellation / goodwill).
    if(body.action==="credit"){
      const db=await database(),actor=await resolveActor(request);requirePermission(actor,"finance.manage");
      if(!body.customerId||!body.amount||!body.source||!body.idempotencyKey)return json({error:"Customer, amount, source and idempotency key are required"},400);
      const data=await creditWallet(db,{customerId:body.customerId,amount:body.amount,source:body.source,sourceId:body.sourceId,idempotencyKey:body.idempotencyKey,note:body.note,actorId:actor.email});
      await securityAudit(db,actor,"wallet.credit","customer",body.customerId,"completed",{amount:body.amount,source:body.source});
      return json({data},201);
    }
    // Customer redeems wallet credit against their own booking.
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    if(!body.bookingId)return json({error:"A booking is required to redeem wallet credit"},400);
    const data=await redeemWalletForBooking(db,{customerId,bookingId:body.bookingId,walletAmount:body.walletAmount,actorId:customerId});
    await securityAudit(db,actor,"wallet.redeem","customer",customerId,"completed",{bookingId:body.bookingId,appliedValue:data.appliedValue});
    return json({data},201);
  }catch(error){return authError(error,"Unable to complete wallet request");}
}
