import{authError,database}from"../../../lib/server-auth";
import{ensurePaymentReconciliationTables,processGatewayEvent,type GatewayEvent}from"../../../lib/grooming-payment-reconciliation";
import{resolvePaymentWebhookGate}from"../../../lib/payment-webhook-gate";
import{enforcePilotBooking}from"../../../lib/payment-pilot-guard";
import{acceptRazorpayWebhook,advancePaymentState,type PaymentState}from"../../../lib/financial-lifecycle";
import{captureEffectsOutboxForEvent,commitRazorpayCaptureAtomic,executeRazorpayCapturePostCommit,RazorpayCaptureAmountMismatchError}from"../../../lib/razorpay-capture-atomic";
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

async function linkedPayment(db:D1Database,event:GatewayEvent){
  const candidates:[string|undefined,string][]=[[event.gatewayPaymentLinkId,"gateway_payment_link_id"],[event.gatewayPaymentId,"gateway_payment_id"],[event.gatewayOrderId,"gateway_order_id"]];
  for(const[value,column]of candidates){
    if(!value)continue;
    const row=await db.prepare(`SELECT booking_id,payment_id FROM payment_gateway_links WHERE ${column}=?`).bind(value).first<Row>().catch(()=>null);
    if(row)return{bookingId:String(row.booking_id),paymentId:String(row.payment_id)};
  }
  if(event.bookingId){
    const payment=await db.prepare("SELECT id FROM booking_payments WHERE booking_id=?").bind(event.bookingId).first<Row>().catch(()=>null);
    if(payment)return{bookingId:event.bookingId,paymentId:String(payment.id)};
  }
  return null;
}

function transitionWouldDefer(intent:Row,target:PaymentState){
  const current=String(intent.state||"") as PaymentState;
  if(!(current in rank))throw new Error("Payment intent contains an unknown state");
  if(rank[current]>=90)return true;
  return rank[target]>rank[current]+1;
}

async function retryCaptureEffects(db:D1Database,eventId:string){
  const outbox=await captureEffectsOutboxForEvent(db,eventId);
  if(!outbox)return null;
  if(String(outbox.status)==="SUCCEEDED")return{claimed:false,completed:true,status:"SUCCEEDED",reason:undefined};
  return executeRazorpayCapturePostCommit(db,{outboxId:String(outbox.id),workerId:`razorpay-webhook-retry:${crypto.randomUUID()}`});
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
    if(gate.environment==="live"){const pilotEvent=extract(payload,eventId,String(accepted.row.payload_sha256),gate.environment);const linked=pilotEvent.bookingId?{bookingId:pilotEvent.bookingId}:await linkedPayment(db,pilotEvent);const pilot=enforcePilotBooking(runtime,"live",linked?.bookingId);if(!pilot.ok){await markInbox(db,accepted.row,"REJECTED",eventType,"outside_payment_pilot");return json({error:pilot.reason,code:"outside_payment_pilot"},403);}}
    /*
     * NO TIMESTAMP CHECK HERE. Replay is bounded by IDENTITY, not by age: acceptRazorpayWebhook
     * recognises a body it has already accepted by the digest of the signature-verified payload, so a
     * forged event-id header can no longer manufacture a second event out of one captured body - and a
     * genuine Razorpay retry arriving twenty hours late is recognised as the redelivery it is rather
     * than refused. A clock-based window would have had to choose between those two.
     */
    if(!(await claimInbox(db,accepted.row,eventType))){
      /*
       * `accepted.row.event_id`, NOT the header's eventId, and that distinction is new.
       *
       * The post-commit capture effects are keyed on the event id they were enqueued under, which is the
       * id of the event as RECORDED. Since the inbox now dedupes on the payload digest, a redelivery can
       * arrive carrying a different id in the header - a gateway retry, or a replay - and resolve to the
       * original row. Looking the outbox up by the header id would then find nothing, silently answer
       * 200, and strand a pending capture effect that the retry existed to finish.
       */
      const effects=await retryCaptureEffects(db,String(accepted.row.event_id||eventId));
      if(effects&&!effects.completed)return json({ok:false,environment:gate.environment,duplicate:true,status:String(accepted.row.processing_status),captureEffectsRetry:true,reason:effects.reason||"capture_post_commit_pending"},503);
      return json({ok:true,environment:gate.environment,duplicate:true,status:String(accepted.row.processing_status),captureEffectsRecovered:Boolean(effects?.completed)});
    }
    try{
      if(eventType==="refund.processed"){
        const entitlement=await prepareSubscriptionRefundEntitlementForWebhook(db,payload as unknown as Row);
        const refundResult=await processSubscriptionRefundEvent(db,payload as unknown as Row,eventId);
        if(refundResult.handled){if(entitlement.handled)await finalizeSubscriptionRefundEntitlement(db,entitlement.allocationKey);await markInbox(db,accepted.row,"PROCESSED",eventType);return json({ok:true,environment:gate.environment,subscriptionRefund:refundResult});}
      }
      if(eventType.startsWith("subscription.")||isPawSpaceSubscriptionPayload(payload as unknown as Row)){
        const subscriptionResult=await processSubscriptionProviderEvent(db,payload as unknown as Row,eventId);
        if(subscriptionResult.handled){const entitlement=eventType==="subscription.charged"?await grantSubscriptionRenewalEntitlement(db,{eventId}):null;await markInbox(db,accepted.row,"PROCESSED",eventType);return json({ok:true,environment:gate.environment,subscription:subscriptionResult,entitlement});}
      }

      const event=extract(payload,eventId,String(accepted.row.payload_sha256),gate.environment);
      const target=targetFor(eventType);const intent=target?await matchedIntent(db,event):null;
      if(intent&&target&&transitionWouldDefer(intent,target)){
        await markInbox(db,accepted.row,"DEFERRED",eventType,`payment_state_${String(intent.state).toLowerCase()}_awaits_prior_transition`);
        return json({ok:true,environment:gate.environment,deferred:true,state:String(intent.state),target});
      }

      if(target==="CAPTURED"){
        await ensurePaymentReconciliationTables(db);
        const linked=intent?{bookingId:String(intent.booking_id),paymentId:String(intent.payment_id)}:await linkedPayment(db,event);
        if(!linked){await markInbox(db,accepted.row,"FAILED",eventType,"capture_has_no_canonical_payment_link");return json({error:"Razorpay capture has no canonical payment link",code:"capture_atomic_link_missing"},409);}
        if(event.bookingId&&event.bookingId!==linked.bookingId){await markInbox(db,accepted.row,"FAILED",eventType,"gateway_order_booking_mismatch");return json({error:"Razorpay capture booking does not own its gateway reference",code:"gateway_order_booking_mismatch"},409);}
        const amountPaise=Number(event.amountSubunits||0);if(!Number.isSafeInteger(amountPaise)||amountPaise<=0){await markInbox(db,accepted.row,"FAILED",eventType,"invalid_capture_amount");return json({error:"Captured Razorpay amount must be positive integer paise"},400);}
        let atomic;
        try{
          atomic=await commitRazorpayCaptureAtomic(db,{
            inboxId:String(accepted.row.id),eventId,environment:gate.environment,intentId:intent?String(intent.id):null,
            bookingId:linked.bookingId,paymentId:linked.paymentId,gatewayOrderId:event.gatewayOrderId||null,gatewayPaymentId:event.gatewayPaymentId||null,
            amountPaise,currency:event.currency||String(intent?.currency||"INR"),payloadHash:String(accepted.row.payload_sha256),detail:event.detail,
          });
        }catch(error){
          // A capture amount that does not match what the order was opened for is a governed refusal,
          // and processGatewayEvent owns it: it writes the ("captured","amount_mismatch") record with
          // the variance, raises the capture_amount_mismatch exception the finance console triages,
          // and answers {status:"exception",reason:"capture_amount_mismatch"}. The atomic committer
          // signals the mismatch before it writes anything, so this hands over a clean slate. Anything
          // else is a real fault and still propagates.
          if(!(error instanceof RazorpayCaptureAmountMismatchError))throw error;
          const governed=await processGatewayEvent(db,event);
          await markInbox(db,accepted.row,"FAILED",eventType,String(governed.reason||"capture_amount_mismatch"));
          return json({ok:true,environment:gate.environment,...governed});
        }
        const effects=atomic.effectsOutboxId?await executeRazorpayCapturePostCommit(db,{outboxId:atomic.effectsOutboxId,workerId:`razorpay-webhook:${crypto.randomUUID()}`}):null;
        if(effects&&!effects.completed)return json({ok:false,environment:gate.environment,status:"processed",atomicCapture:true,coreCommitted:true,captureEffectsRetry:true,reason:effects.reason||"capture_post_commit_pending"},503);
        return json({ok:true,environment:gate.environment,status:"processed",atomicCapture:true,duplicateCapture:atomic.duplicateCapture,paymentState:intent?{changed:!atomic.duplicateCapture,state:"CAPTURED"}:null,journal:atomic.journalId?{transactionId:atomic.journalId,duplicate:false}:null,captureEffects:effects?effects.status:"none"});
      }

      const result=await processGatewayEvent(db,event);
      const failed=String(result.status||"")==="exception";
      if(failed){await markInbox(db,accepted.row,"FAILED",eventType,String(result.reason||"reconciliation_exception"));return json({ok:true,environment:gate.environment,...result});}

      let transition:Awaited<ReturnType<typeof advancePaymentState>>|null=null;
      if(intent&&target)transition=await advancePaymentState(db,{intentId:String(intent.id),target,gatewayPaymentId:event.gatewayPaymentId});
      await markInbox(db,accepted.row,"PROCESSED",eventType);
      return json({ok:true,environment:gate.environment,...result,paymentState:transition,journal:null});
    }catch(error){
      await markInbox(db,accepted.row,"FAILED",eventType,error instanceof Error?error.message:"domain_processing_failed").catch(()=>null);
      throw error;
    }
  }catch(error){return authError(error,"Unable to process Razorpay webhook");}
}
