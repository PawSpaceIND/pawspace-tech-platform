import{authError,database}from"../../../lib/server-auth";
import{processGatewayEvent,type GatewayEvent}from"../../../lib/grooming-payment-reconciliation";
import{resolvePaymentWebhookGate}from"../../../lib/payment-webhook-gate";
import{acceptRazorpayWebhook,advancePaymentState,postBalancedJournal,type PaymentState}from"../../../lib/financial-lifecycle";
import{ACCT}from"../../../lib/finance-accounts";
import{isPawSpaceSubscriptionPayload,processSubscriptionProviderEvent}from"../../../lib/subscription-billing";
import{processSubscriptionRefundEvent}from"../../../lib/subscription-refund-reconciliation";
import{finalizeSubscriptionRefundEntitlement,grantSubscriptionRenewalEntitlement,prepareSubscriptionRefundEntitlementForWebhook}from"../../../lib/subscription-entitlement-renewal";

type RazorEntity=Record<string,unknown>;
type RazorPayload={event?:string;created_at?:number;payload?:Record<string,{entity?:RazorEntity}>};
type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status});
const rank:Record<PaymentState,number>={CREATED:0,AUTHORIZED:1,CAPTURED:2,SETTLED:3,FAILED:90,CANCELLED:91};

function entity(payload:RazorPayload,key:string){return payload.payload?.[key]?.entity||{};}
function extract(payload:RazorPayload,eventId:string,payloadHash:string,environment:"sandbox"|"live"):GatewayEvent{
  const eventType=String(payload.event||"");const payment=entity(payload,"payment"),refund=entity(payload,"refund"),order=entity(payload,"order"),paymentLink=entity(payload,"payment_link"),subscription=entity(payload,"subscription");const notes=(payment.notes&&typeof payment.notes==="object"?payment.notes:order.notes&&typeof order.notes==="object"?order.notes:paymentLink.notes&&typeof paymentLink.notes==="object"?paymentLink.notes:subscription.notes&&typeof subscription.notes==="object"?subscription.notes:{}) as Record<string,unknown>;
  // A recurring subscription payment can carry the source booking note. It is not another payment
  // against that booking. The subscription processor consumes it before the booking reconciler below.
  const subscriptionOrigin=Boolean(String(notes.pawspace_billing_subscription_id||payment.subscription_id||subscription.id||"").trim());
  const bookingId=subscriptionOrigin?undefined:String(notes.booking_id||notes.bookingId||notes.pawspace_booking_id||"").trim()||undefined;
  const amountEntity=eventType.startsWith("refund.")?refund:payment;const amount=Number(amountEntity.amount??order.amount_paid??0);
  return{provider:"razorpay",environment,eventId,eventType,bookingId,gatewayOrderId:String(payment.order_id||refund.order_id||order.id||"").trim()||undefined,gatewayPaymentLinkId:String(paymentLink.id||"").trim()||undefined,gatewayPaymentId:String(refund.payment_id||payment.id||"").trim()||undefined,gatewayRefundId:String(refund.id||"").trim()||undefined,amountSubunits:Number.isFinite(amount)?amount:undefined,currency:String(amountEntity.currency||payment.currency||order.currency||"").trim()||undefined,createdAt:Number(payload.created_at||0)*1000||Date.now(),signatureVerified:true,payloadHash,detail:{contains:Object.keys(payload.payload||{}),source:"razorpay_webhook",subscriptionOrigin}};
}

function targetFor(eventType:string):PaymentState|null{
  if(eventType==="payment.authorized")return"AUTHORIZED";
  if(eventType==="payment.captured"||eventType==="order.paid"||eventType==="payment_link.paid")return"CAPTURED";
  return null;
}

async function claimInbox(db:D1Database,row:Row,eventType:string){
  const result=await db.prepare("UPDATE gateway_webhook_events SET processing_status='PROCESSING',event_type=?,failure_reason=NULL,processed_at=NULL WHERE id=? AND processing_status IN ('RECEIVED','DEFERRED','FAILED')")
    .bind(eventType,String(row.id)).run();
  return Number(result.meta?.changes||0)===1;
}
async function markInbox(db:D1Database,row:Row,status:"PROCESSED"|"DEFERRED"|"REJECTED"|"FAILED",eventType?:string,reason?:string){
  const terminal=status!=="DEFERRED";
  await db.prepare("UPDATE gateway_webhook_events SET processing_status=?,event_type=COALESCE(?,event_type),failure_reason=?,processed_at=? WHERE id=?")
    .bind(status,eventType||null,reason||null,terminal?Date.now():null,String(row.id)).run();
}

async function matchedIntent(db:D1Database,event:GatewayEvent){
  if(!event.gatewayOrderId)return null;
  return db.prepare("SELECT * FROM payment_intents WHERE provider='razorpay' AND gateway_order_id=?").bind(event.gatewayOrderId).first<Row>();
}

function transitionWouldDefer(intent:Row,target:PaymentState){
  const current=String(intent.state||"") as PaymentState;
  if(!(current in rank))throw new Error("Payment intent contains an unknown state");
  if(rank[current]>=90)return true;
  return rank[target]>rank[current]+1;
}

async function ensureCaptureJournal(db:D1Database,event:GatewayEvent,intent:Row){
  const amountPaise=Number(event.amountSubunits||0);
  if(!Number.isSafeInteger(amountPaise)||amountPaise<=0)throw new Error("Captured Razorpay amount must be positive integer paise");
  return postBalancedJournal(db,{
    sourceType:"razorpay_capture",
    sourceId:String(intent.id),
    sourceEventId:`razorpay:${event.eventId}:capture`,
    narration:`Razorpay capture ${event.eventId}`,
    currency:event.currency||String(intent.currency||"INR"),
    entries:[
      {accountCode:ACCT.GATEWAY_CLEARING,direction:"DEBIT",amountPaise,bookingId:String(intent.booking_id)},
      {accountCode:ACCT.CUSTOMER_COLLECTIONS,direction:"CREDIT",amountPaise,bookingId:String(intent.booking_id)},
    ],
  });
}

export async function POST(request:Request){
  try{
    const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
    const gate=resolvePaymentWebhookGate(runtime);if(!gate.ok)return json({error:gate.reason},gate.status);
    const signature=(request.headers.get("x-razorpay-signature")||"").trim().toLowerCase(),eventId=(request.headers.get("x-razorpay-event-id")||"").trim();if(!signature||!eventId)return json({error:"Razorpay signature and event ID are required"},400);
    const raw=await request.text();const db=await database();
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
    const payload=(accepted.duplicate?JSON.parse(String(accepted.row.raw_payload||"{}")):accepted.event) as RazorPayload;
    const eventType=String(payload.event||"").trim();
    if(!eventType){await markInbox(db,accepted.row,"REJECTED",undefined,"missing_event_type");return json({error:"Webhook event type is required"},400);}
    const duplicateStatus=String(accepted.row.processing_status||"");
    if(accepted.duplicate&&!['RECEIVED','DEFERRED','FAILED'].includes(duplicateStatus))return json({ok:true,environment:gate.environment,duplicate:true,status:duplicateStatus});
    if(!(await claimInbox(db,accepted.row,eventType)))return json({ok:true,environment:gate.environment,duplicate:true,status:duplicateStatus});
    try{
      // Refunds are checked first because a provider-generated proration refund may not carry a
      // subscription entity. Matching by the original recurring payment id keeps it out of booking refunds.
      if(eventType==="refund.processed"){
        // Reserve/remove only unused entitlement before reversing Deferred Revenue. If accounting fails,
        // the webhook stays FAILED and the reservation makes the retry safe without letting those credits
        // be consumed in the meantime.
        const entitlement=await prepareSubscriptionRefundEntitlementForWebhook(db,payload as unknown as Row);
        const refundResult=await processSubscriptionRefundEvent(db,payload as unknown as Row,eventId);
        if(refundResult.handled){if(entitlement.handled)await finalizeSubscriptionRefundEntitlement(db,entitlement.allocationKey);await markInbox(db,accepted.row,"PROCESSED",eventType);return json({ok:true,environment:gate.environment,subscriptionRefund:refundResult});}
      }
      if(eventType.startsWith("subscription.")||isPawSpaceSubscriptionPayload(payload as unknown as Row)){
        const subscriptionResult=await processSubscriptionProviderEvent(db,payload as unknown as Row,eventId);
        // Billing-cycle insertion is already provider-event/payment idempotent. The entitlement grant is
        // independently keyed by that cycle, so a webhook replay repairs an interrupted grant but cannot
        // ever add the cycle's sessions twice.
        if(subscriptionResult.handled){const entitlement=eventType==="subscription.charged"?await grantSubscriptionRenewalEntitlement(db,{eventId}):null;await markInbox(db,accepted.row,"PROCESSED",eventType);return json({ok:true,environment:gate.environment,subscription:subscriptionResult,entitlement});}
      }

      const event=extract(payload,eventId,String(accepted.row.payload_sha256),gate.environment);
      const target=targetFor(eventType);const intent=target?await matchedIntent(db,event):null;
      if(intent&&target&&transitionWouldDefer(intent,target)){
        await markInbox(db,accepted.row,"DEFERRED",eventType,`payment_state_${String(intent.state).toLowerCase()}_awaits_prior_transition`);
        return json({ok:true,environment:gate.environment,deferred:true,state:String(intent.state),target});
      }
      const result=await processGatewayEvent(db,event);
      const failed=String(result.status||"")==="exception";
      if(failed){await markInbox(db,accepted.row,"FAILED",eventType,String(result.reason||"reconciliation_exception"));return json({ok:true,environment:gate.environment,...result});}

      let transition:Awaited<ReturnType<typeof advancePaymentState>>|null=null;
      if(intent&&target)transition=await advancePaymentState(db,{intentId:String(intent.id),target,gatewayPaymentId:event.gatewayPaymentId});
      let journal:null|Awaited<ReturnType<typeof postBalancedJournal>>=null;
      const captureEvent=target==="CAPTURED";
      const sameEventRecovery=Boolean((result as Record<string,unknown>).duplicate);
      const repeatCapture=Boolean((result as Record<string,unknown>).ignored)&&String((result as Record<string,unknown>).reason||"")==="capture_already_collected";
      if(intent&&captureEvent&&!repeatCapture&&(transition?.changed||sameEventRecovery||String(intent.state)==="CAPTURED"))journal=await ensureCaptureJournal(db,event,intent);

      await markInbox(db,accepted.row,"PROCESSED",eventType);
      return json({ok:true,environment:gate.environment,...result,paymentState:transition,journal:journal?{transactionId:journal.transactionId,duplicate:journal.duplicate}:null});
    }catch(error){
      await markInbox(db,accepted.row,"FAILED",eventType,error instanceof Error?error.message:"domain_processing_failed").catch(()=>null);
      throw error;
    }
  }catch(error){return authError(error,"Unable to process Razorpay webhook");}
}
