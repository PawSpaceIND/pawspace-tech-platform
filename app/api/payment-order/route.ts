import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{createBookingPaymentOrder}from"../../../lib/payment-order-intent";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin payment write blocked",{status:403});}
async function paymentRuntime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

// Customer-owned payment status read. The browser may use this to display capture truth, but it cannot
// create or advance a payment state. A verified Razorpay webhook remains the only capture authority.
export async function GET(request:Request){
  try{
    const bookingId=String(new URL(request.url).searchParams.get("bookingId")||"").trim();
    if(!bookingId)return json({error:"A booking is required"},400);
    const{db,customerId}=await ownedContext(request);
    const payment=await db.prepare("SELECT b.id booking_id,p.id payment_id,p.status payment_status,p.currency,p.detail_json,p.updated_at FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=? AND b.customer_id=?").bind(bookingId,customerId).first<Row>();
    if(!payment)return json({error:"Payment was not found"},404);
    const paymentId=String(payment.payment_id||"");
    const[link,reconciliation]=await Promise.all([
      db.prepare("SELECT provider,environment,gateway_order_id,gateway_payment_id,status FROM payment_gateway_links WHERE payment_id=?").bind(paymentId).first<Row>().catch(()=>null),
      db.prepare("SELECT expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first<Row>().catch(()=>null),
    ]);
    const paymentStatus=String(payment.payment_status||"");
    return json({data:{
      bookingId:String(payment.booking_id),
      paymentId,
      paymentStatus,
      verifiedCaptured:paymentStatus==="captured",
      currency:String(reconciliation?.currency||payment.currency||"INR"),
      provider:link?String(link.provider||""):null,
      environment:link?String(link.environment||""):null,
      gatewayOrderId:link?String(link.gateway_order_id||"")||null:null,
      gatewayPaymentId:link?String(link.gateway_payment_id||"")||null:null,
      gatewayStatus:reconciliation?String(reconciliation.gateway_status||""):null,
      reconciliationStatus:reconciliation?String(reconciliation.reconciliation_status||""):null,
      expectedAmount:reconciliation?Number(reconciliation.expected_amount||0):null,
      capturedAmount:reconciliation?Number(reconciliation.captured_amount||0):null,
      refundedAmount:reconciliation?Number(reconciliation.refunded_amount||0):null,
      varianceAmount:reconciliation?Number(reconciliation.variance_amount||0):null,
      lastEventId:reconciliation?String(reconciliation.last_event_id||"")||null:null,
      updatedAt:Number(reconciliation?.updated_at||payment.updated_at||0),
    }});
  }catch(error){return authError(error,"Unable to read payment status");}
}

// Verify-first customer payment: open a real Razorpay order for an unpaid booking. Fails closed
// (connected:false) when Razorpay is not configured for the active environment - never fakes "paid".
export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {customerId?:string;bookingId?:string};
    if(!body.bookingId)return json({error:"A booking is required"},400);
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    const env=await paymentRuntime();
    const data=await createBookingPaymentOrder(db,env,{bookingId:body.bookingId,customerId,actorId:customerId});
    await securityAudit(db,actor,"payment.order.create","customer",customerId,"completed",{bookingId:body.bookingId,connected:data.connected,environment:data.environment});
    return json({data},data.connected?201:200);
  }catch(error){return authError(error,"Unable to open payment");}
}
