import{authError,authFailure,database,requireCustomerOwnership,resolveActor,securityAudit,type AuthenticatedActor}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{createBookingPaymentOrder}from"../../../lib/payment-order-intent";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin payment write blocked",{status:403});}
async function paymentRuntime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
async function ownedContext(request:Request,requestedCustomerId?:string,actorOverride?:AuthenticatedActor){const db=await database(),actor=actorOverride??await resolveActor(request),session=await resolvePlatformSession(db,request);const sessionCustomerId=session?.subjectType==="customer"?String(session.subjectId).trim():"",requested=String(requestedCustomerId??"").trim(),customerId=requested||sessionCustomerId;if(!customerId)throw authFailure("A verified customer sign-in is required before a payment can be opened. Sign in and try again.",401);if(requested&&sessionCustomerId&&requested!==sessionCustomerId)throw authFailure("Customer ownership denied",403);await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

// Verify-first customer payment: open a real Razorpay order for an unpaid booking. Fails closed
// (connected:false) when Razorpay is not configured for the active environment - never fakes "paid".
export async function executePaymentOrderRequest(request:Request,actorOverride?:AuthenticatedActor){
  try{
    sameOrigin(request);
    const body=await request.json() as {customerId?:string;bookingId?:string};
    if(!body.bookingId)return json({error:"A booking is required"},400);
    const{db,actor,customerId}=await ownedContext(request,body.customerId,actorOverride);
    const env=await paymentRuntime();
    const data=await createBookingPaymentOrder(db,env,{bookingId:body.bookingId,customerId,actorId:customerId});
    await securityAudit(db,actor,"payment.order.create","customer",customerId,"completed",{bookingId:body.bookingId,connected:data.connected,environment:data.environment});
    return json({data},data.connected?201:200);
  }catch(error){return authError(error,"Unable to open payment");}
}

export async function POST(request:Request){return executePaymentOrderRequest(request);}
