import{evaluateBookingChange,parsePolicySnapshot,resolveGroomingPolicy}from"./grooming-policy-governance";
import{evaluateCancellationRefund,resolveRefundPolicy}from"./refund-policy-governance";
type Row=Record<string,unknown>;
/**
 * Work-order states a CUSTOMER may still cancel from.
 *
 * `payment_pending` is here deliberately (owner decision 2026-09-22). An unpaid reservation used to be
 * the one thing a customer could NOT cancel: the preview resolved "unavailable" and the cancel form was
 * not rendered at all, so a slot they no longer wanted could only be released by support. It is also the
 * cheapest cancellation there is - evaluateCancellationRefund already returns 0 for an uncaptured
 * payment, so no refund case is opened and no money moves.
 */
export const CUSTOMER_CANCELLABLE_WORK_STATUSES=["confirmed","assigned","awaiting_acceptance","payment_pending"] as const;

/**
 * What the customer has paid towards the booking and not had back: the basis of a cancellation refund.
 * A partially refunded payment used to count as nothing paid, so after the difference for a reschedule
 * that could not be applied went back to the customer, cancelling the booking refunded Rs 0 of the
 * booking price. Such a payment now counts what is left of it, never more than the booking price.
 */
export async function customerPaidTowardsBooking(db:D1Database,payment:Row){
 const status=String(payment.status||"");
 if(["captured","paid"].includes(status))return Number(payment.amount||0);
 if(status!=="partially_refunded")return 0;
 const record=await db.prepare("SELECT captured_amount,refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(payment.id).first<Row>().catch(()=>null);
 if(!record)return 0;
 return Math.max(0,Math.min(Number(payment.amount||0),Math.round((Number(record.captured_amount||0)-Number(record.refunded_amount||0))*100)/100));
}

export type GroomingChangePreview={consentRevision:string;bookingId:string;currency:string;durationMinutes:number;reschedule:{allowed:boolean;feeAmount:number;reasons:string[]};cancellation:{mode:"cancel"|"review"|"unavailable";refundAmount:number|null;reasons:string[]};policyVersion:string;refundPolicyVersion:string};
export async function groomingChangePreview(db:D1Database,booking:Row,work:Row,payment:Row,now=Date.now()):Promise<GroomingChangePreview>{
 let pricing:Record<string,unknown>={};try{pricing=JSON.parse(String(booking.pricing_json||"{}"));}catch{}
 const policy=parsePolicySnapshot(pricing?.commercialPolicy)??await resolveGroomingPolicy(db,String(booking.city_id),String(booking.zone_id),new Date(Number(booking.created_at||now)));
 const history=await db.prepare("SELECT COUNT(*) count FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_rescheduled'").bind(booking.id).first<{count:number}>();
 const input={scheduledStart:String(booking.scheduled_start),status:String(booking.status),bookingAmount:Number(booking.total_amount||0),rescheduleCount:Number(history?.count||0),now};
 const reschedule=evaluateBookingChange(policy,{...input,action:"reschedule"}),cancel=evaluateBookingChange(policy,{...input,action:"cancel"});
 const duration=Date.parse(String(booking.scheduled_end))-Date.parse(String(booking.scheduled_start));
 const intact=Number.isFinite(duration)&&duration>0&&String(work.scheduled_start)===String(booking.scheduled_start)&&String(work.scheduled_end)===String(booking.scheduled_end);
 const movable=["confirmed","assigned","awaiting_acceptance"].includes(String(booking.status))&&["confirmed","assigned","awaiting_acceptance"].includes(String(work.status));
 const reasons=[...reschedule.reasons];if(!intact)reasons.push("The existing booking schedule requires review");if(!movable)reasons.push("This service has progressed and cannot be rescheduled directly");
 const refundPolicy=await resolveRefundPolicy(db,{serviceCode:"grooming",cityId:String(booking.city_id||"")});
 const refund=evaluateCancellationRefund(refundPolicy,{scheduledStart:String(booking.scheduled_start),bookingStatus:String(booking.status),cancelledBy:"customer",amountPaid:await customerPaidTowardsBooking(db,payment),couponValue:Number(pricing?.discount??0),now});
 const mode=!refund.automatic&&refund.requiresApproval?"review":cancel.allowed&&(CUSTOMER_CANCELLABLE_WORK_STATUSES as readonly string[]).includes(String(work.status))?"cancel":"unavailable";
 const result={bookingId:String(booking.id),currency:String(booking.currency||"INR"),durationMinutes:intact?duration/60000:0,reschedule:{allowed:reschedule.allowed&&intact&&movable,feeAmount:reschedule.feeAmount,reasons},cancellation:{mode:mode as "cancel"|"review"|"unavailable",refundAmount:mode==="cancel"?refund.customerRefundAmount:null,reasons:mode==="unavailable"?cancel.reasons:refund.reasons},policyVersion:reschedule.policyVersion,refundPolicyVersion:refund.policyVersion};
 const basis=JSON.stringify({preview:result,booking:{status:booking.status,start:booking.scheduled_start,end:booking.scheduled_end,updatedAt:booking.updated_at},work:{status:work.status,provider:work.provider_id,updatedAt:work.updated_at},payment:{status:payment.status,amount:payment.amount,updatedAt:payment.updated_at}});
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(basis));
 return{...result,consentRevision:Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("")};
}
