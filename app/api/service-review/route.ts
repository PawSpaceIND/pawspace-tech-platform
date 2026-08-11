import{authError,database,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{requestServiceReview,submitServiceReview,claimPublicReview,verifyPublicReview,redeemReviewReward,listReviewRewards}from"../../../lib/service-review-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin review write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

// Customer's own active review reward coupons.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    return json({data:{rewards:await listReviewRewards(db,customerId)}});
  }catch(error){return authError(error,"Unable to load review rewards");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {action?:string;customerId?:string;bookingId?:string;serviceCode?:string;completedSessionCount?:number;requestId?:string;stars?:number;answers?:Record<string,unknown>;platform?:string;code?:string;claimId?:string;verified?:boolean};
    // Staff: raise a review request after a service (respects the configured cadence).
    if(body.action==="request"){
      const db=await database(),actor=await resolveActor(request);requirePermission(actor,"bookings.manage");
      if(!body.bookingId||!body.serviceCode||!body.customerId)return json({error:"Booking, service and customer are required"},400);
      const data=await requestServiceReview(db,{bookingId:body.bookingId,serviceCode:body.serviceCode,customerId:body.customerId,completedSessionCount:body.completedSessionCount});
      return json({data},201);
    }
    // Staff: verify (or reject) a self-declared public review claim.
    if(body.action==="verify_claim"){
      const db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
      if(!body.claimId)return json({error:"A claim id is required"},400);
      const data=await verifyPublicReview(db,{claimId:body.claimId,actor:actor.email,verified:body.verified!==false});
      await securityAudit(db,actor,"review.claim.verify","review_claim",body.claimId,"completed",{verified:body.verified!==false});
      return json({data},200);
    }
    // Customer actions below.
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    if(body.action==="claim"){
      if(!body.bookingId||!body.platform)return json({error:"Booking and platform are required"},400);
      const data=await claimPublicReview(db,{bookingId:body.bookingId,customerId,platform:body.platform,actorId:customerId});
      await securityAudit(db,actor,"review.public.claim","customer",customerId,"completed",{bookingId:body.bookingId,platform:body.platform});
      return json({data},201);
    }
    if(body.action==="redeem"){
      if(!body.code||!body.bookingId)return json({error:"A reward code and booking are required"},400);
      const data=await redeemReviewReward(db,{code:body.code,customerId,bookingId:body.bookingId,actorId:customerId});
      await securityAudit(db,actor,"review.reward.redeem","customer",customerId,"completed",{code:body.code,bookingId:body.bookingId});
      return json({data},201);
    }
    // default: submit a review.
    if(!body.requestId||body.stars===undefined)return json({error:"A review request and star rating are required"},400);
    const data=await submitServiceReview(db,{requestId:body.requestId,customerId,stars:Number(body.stars),answers:body.answers});
    await securityAudit(db,actor,"review.submit","customer",customerId,"completed",{requestId:body.requestId,stars:body.stars});
    return json({data},201);
  }catch(error){return authError(error,"Unable to complete review request");}
}
