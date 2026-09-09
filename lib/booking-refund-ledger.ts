import {postCollectionEvent} from "./collection-ledger";
import type {GatewayEvent} from "./grooming-payment-reconciliation";

type Row=Record<string,unknown>;

/** Called only after the signature-verified booking refund has completed domain reconciliation. */
export async function postVerifiedBookingRefund(db:D1Database,event:GatewayEvent){
 if(event.eventType!=="refund.processed"||event.provider!=="razorpay"||!event.signatureVerified)
  throw new Error("A verified Razorpay refund.processed event is required");
 const refundId=String(event.gatewayRefundId||"").trim();
 if(!refundId||!Number.isSafeInteger(event.amountSubunits)||Number(event.amountSubunits)<=0)
  throw new Error("A gateway refund identity and positive integer refund paise are required");
 // Do not manufacture accounting from the caller's booking notes. Require the processed event,
 // its owned canonical payment and the processed internal refund with the same gateway identity.
 const row=await db.prepare(`SELECT e.booking_id,e.payment_id,e.amount_subunits,e.currency,e.gateway_payment_id,
   r.id refund_case_id,r.amount refund_amount,r.updated_at refund_updated_at,
   p.customer_id,p.method,b.city_id,b.service_code
   FROM payment_gateway_events e
   JOIN booking_refund_cases r ON r.booking_id=e.booking_id AND r.gateway_reference=e.gateway_refund_id
   JOIN booking_payments p ON p.id=e.payment_id AND p.booking_id=e.booking_id
   JOIN canonical_bookings b ON b.id=e.booking_id
   WHERE e.provider='razorpay' AND e.event_id=? AND e.event_type='refund.processed'
     AND e.environment=? AND e.processing_status='processed' AND e.signature_verified=1
     AND e.gateway_refund_id=? AND r.status='processed'`).bind(event.eventId,event.environment,refundId).first<Row>();
 if(!row)throw new Error("Processed booking refund evidence is missing; ledger reversal was not posted");
 const refundPaise=Math.round(Number(row.refund_amount)*100);
 if(!Number.isSafeInteger(refundPaise)||refundPaise<=0||refundPaise!==event.amountSubunits||Number(row.amount_subunits)!==refundPaise)
  throw new Error("Verified refund amount differs from its internal refund case");
 if(event.bookingId&&event.bookingId!==String(row.booking_id))throw new Error("Refund booking identity differs from processed evidence");
 if(event.gatewayPaymentId&&event.gatewayPaymentId!==String(row.gateway_payment_id||""))throw new Error("Refund payment identity differs from processed evidence");
 if(event.currency&&event.currency!==String(row.currency))throw new Error("Refund currency differs from processed evidence");
 const at=Number(row.refund_updated_at);
 if(!Number.isFinite(at)||at<=0)throw new Error("Processed refund timestamp is missing");
 const posted=await postCollectionEvent(db,{
  event:"refund_completed",bookingId:String(row.booking_id),paymentId:String(row.payment_id),
  customerId:row.customer_id?String(row.customer_id):null,cityId:row.city_id?String(row.city_id):null,
  serviceCode:row.service_code?String(row.service_code):null,
  // The refund ID is stable across different webhook deliveries and distinct for partial refunds.
  refundReference:refundId,amount:refundPaise/100,refundInstrument:"gateway",
  paymentMethod:String(row.method||"razorpay"),entryDate:new Date(at).toISOString().slice(0,10),
  transactionAt:at,actorId:"razorpay_refund_webhook",
 });
 if(!posted.posted&&!posted.duplicatePrevented)throw new Error("Refund ledger posting was refused: "+posted.reason);
 const persisted=await db.prepare("SELECT payment_id,amount FROM collection_ledger_postings WHERE group_key=?").bind(posted.groupKey).first<Row>();
 if(!persisted||String(persisted.payment_id)!==String(row.payment_id)||Math.round(Number(persisted.amount)*100)!==refundPaise)
  throw new Error("Refund ledger posting does not match its processed refund");
 return posted;
}
