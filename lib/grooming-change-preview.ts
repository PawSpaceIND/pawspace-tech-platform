import{evaluateBookingChange,parsePolicySnapshot,resolveGroomingPolicy}from"./grooming-policy-governance";
import{evaluateCancellationRefund,resolveRefundPolicy}from"./refund-policy-governance";
type Row=Record<string,unknown>;
export type GroomingChangePreview={bookingId:string;currency:string;durationMinutes:number;reschedule:{allowed:boolean;feeAmount:number;reasons:string[]};cancellation:{mode:"cancel"|"review"|"unavailable";refundAmount:number|null;reasons:string[]};policyVersion:string;refundPolicyVersion:string};
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
 const refund=evaluateCancellationRefund(refundPolicy,{scheduledStart:String(booking.scheduled_start),bookingStatus:String(booking.status),cancelledBy:"customer",amountPaid:["captured","paid"].includes(String(payment.status))?Number(payment.amount||0):0,couponValue:Number(pricing?.discount??0),now});
 const mode=!refund.automatic&&refund.requiresApproval?"review":cancel.allowed&&["confirmed","assigned","awaiting_acceptance"].includes(String(work.status))?"cancel":"unavailable";
 return{bookingId:String(booking.id),currency:String(booking.currency||"INR"),durationMinutes:intact?duration/60000:0,reschedule:{allowed:reschedule.allowed&&intact&&movable,feeAmount:reschedule.feeAmount,reasons},cancellation:{mode,refundAmount:mode==="cancel"?refund.customerRefundAmount:null,reasons:mode==="unavailable"?cancel.reasons:refund.reasons},policyVersion:reschedule.policyVersion,refundPolicyVersion:refund.policyVersion};
}
