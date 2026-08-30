import{authError,database}from"../../../lib/server-auth";
import{processGatewayEvent,type GatewayEvent}from"../../../lib/grooming-payment-reconciliation";
import{resolvePaymentWebhookGate}from"../../../lib/payment-webhook-gate";
import{acceptRazorpayWebhook}from"../../../lib/financial-lifecycle";

type RazorEntity=Record<string,unknown>;
type RazorPayload={event?:string;created_at?:number;payload?:Record<string,{entity?:RazorEntity}>};
type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status});

function entity(payload:RazorPayload,key:string){return payload.payload?.[key]?.entity||{};}
function extract(payload:RazorPayload,eventId:string,payloadHash:string,environment:"sandbox"|"live"):GatewayEvent{
  const eventType=String(payload.event||"");const payment=entity(payload,"payment"),refund=entity(payload,"refund"),order=entity(payload,"order"),paymentLink=entity(payload,"payment_link");const notes=(payment.notes&&typeof payment.notes==="object"?payment.notes:order.notes&&typeof order.notes==="object"?order.notes:paymentLink.notes&&typeof paymentLink.notes==="object"?paymentLink.notes:{}) as Record<string,unknown>;
  const bookingId=String(notes.booking_id||notes.bookingId||notes.pawspace_booking_id||"").trim()||undefined;
  const amountEntity=eventType.startsWith("refund.")?refund:payment;const amount=Number(amountEntity.amount??order.amount_paid??0);
  return{provider:"razorpay",environment,eventId,eventType,bookingId,gatewayOrderId:String(payment.order_id||refund.order_id||order.id||"").trim()||undefined,gatewayPaymentLinkId:String(paymentLink.id||"").trim()||undefined,gatewayPaymentId:String(refund.payment_id||payment.id||"").trim()||undefined,gatewayRefundId:String(refund.id||"").trim()||undefined,amountSubunits:Number.isFinite(amount)?amount:undefined,currency:String(amountEntity.currency||payment.currency||order.currency||"").trim()||undefined,createdAt:Number(payload.created_at||0)*1000||Date.now(),signatureVerified:true,payloadHash,detail:{contains:Object.keys(payload.payload||{}),source:"razorpay_webhook"}};
}

async function markInbox(db:D1Database,row:Row,status:"PROCESSING"|"PROCESSED"|"REJECTED"|"FAILED",eventType?:string,reason?:string){
  const now=Date.now();
  await db.prepare("UPDATE gateway_webhook_events SET processing_status=?,event_type=COALESCE(?,event_type),failure_reason=?,processed_at=? WHERE id=?")
    .bind(status,eventType||null,reason||null,status==="PROCESSING"?null:now,String(row.id)).run();
}

export async function POST(request:Request){
  try{
    const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
    const gate=resolvePaymentWebhookGate(runtime);if(!gate.ok)return json({error:gate.reason},gate.status);
    const signature=(request.headers.get("x-razorpay-signature")||"").trim().toLowerCase(),eventId=(request.headers.get("x-razorpay-event-id")||"").trim();if(!signature||!eventId)return json({error:"Razorpay signature and event ID are required"},400);
    const raw=await request.text();
    const db=await database();
    let accepted:Awaited<ReturnType<typeof acceptRazorpayWebhook>>;
    try{
      accepted=await acceptRazorpayWebhook(db,{rawBody:raw,signature,webhookSecret:gate.secret,eventId,environment:gate.environment});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(message==="Invalid Razorpay webhook signature")return json({error:message},401);
      if(message==="Signed Razorpay webhook body is not valid JSON")return json({error:"Invalid webhook JSON"},400);
      if(message.includes("replayed with a different payload"))return json({error:"Razorpay event ID payload mismatch"},409);
      throw error;
    }
    if(accepted.duplicate)return json({ok:true,environment:gate.environment,duplicate:true,status:String(accepted.row.processing_status)});
    const payload=accepted.event as RazorPayload;
    const eventType=String(payload.event||"").trim();
    if(!eventType){await markInbox(db,accepted.row,"REJECTED",undefined,"missing_event_type");return json({error:"Webhook event type is required"},400);}
    await markInbox(db,accepted.row,"PROCESSING",eventType);
    try{
      const event=extract(payload,eventId,String(accepted.row.payload_sha256),gate.environment);
      const result=await processGatewayEvent(db,event);
      const failed=String(result.status||"")==="exception";
      await markInbox(db,accepted.row,failed?"FAILED":"PROCESSED",eventType,failed?String(result.reason||"reconciliation_exception"):undefined);
      return json({ok:true,environment:gate.environment,...result});
    }catch(error){
      await markInbox(db,accepted.row,"FAILED",eventType,error instanceof Error?error.message:"domain_processing_failed").catch(()=>null);
      throw error;
    }
  }catch(error){return authError(error,"Unable to process Razorpay webhook");}
}