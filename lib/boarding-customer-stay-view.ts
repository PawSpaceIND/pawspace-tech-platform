/**
 * What a customer's Boarding stay screens say about the stay and its payment.
 *
 * Round-2 staging (BRD-02): an unpaid reservation's manage page read "CANONICAL BOARDING STAY · PS-UAT-...
 * Awaiting Host Acceptance - The selected host still needs to accept the canonical stay. Payment status is tracked
 * separately on the canonical booking payment record." with no payment state and no way to pay. The stay row already
 * carries the booking payment (booking_status, payment_status, amount_due_now), so the screen now says "Payment
 * pending" with a link to the booking's payment page, and every sentence is in the customer's words: no "canonical",
 * "governed" or raw status codes. Nothing here infers a payment from the stay status; it reads the payment record.
 * Browser-safe.
 */
import type {BoardingStay} from "./boarding-stay-client";

type StayView=Pick<BoardingStay,"status"|"booking_id"|"events"|"payment_status"|"booking_status"|"amount_due_now">;

/** Booking payment states in which nothing has been collected yet. */
const UNPAID_PAYMENT_STATES=new Set(["created","pending","failed"]);
/** Booking states in which a payment can no longer be taken. */
const CLOSED_BOOKING_STATES=new Set(["cancelled","canceled","expired","refunded","failed","completed"]);

export function label(value:string){return value.replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());}
export function inr(amount:number){return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2}).format(amount);}

/** The booking's own page: its status, and its payment step while payment is due. */
export function boardingBookingHref(bookingId:string,routeScope:"legacy"|"v2"="legacy",pay=false){
 const id=encodeURIComponent(bookingId);
 return routeScope==="v2"?`/v2/booking?bookingId=${id}`:`/mobile-app/booking-confirmation?bookingId=${id}${pay?"&payment=resume":""}`;
}

/** The amount still to pay before the host can accept, or null when this stay is not waiting for a payment. */
export function boardingStayPaymentDue(stay:StayView):{amount:number|null}|null{
 if(["cancelled","completed"].includes(stay.status)||CLOSED_BOOKING_STATES.has(String(stay.booking_status||"")))return null;
 const unpaid=stay.booking_status==="payment_pending"||UNPAID_PAYMENT_STATES.has(String(stay.payment_status||""));
 if(!unpaid)return null;
 const amount=Number(stay.amount_due_now);
 return{amount:Number.isFinite(amount)&&amount>0?amount:null};
}

/** What happened to the money on a cancelled stay: the approved refund from the cancellation event, and
 *  whether the booking payment says it has been paid back. */
export function cancelledMessage(stay:StayView){const cancelled=[...(stay.events||[])].reverse().find(event=>event.event_type==="cancelled"),refund=Number(cancelled?.detail?.approvedRefundAmount||0);if(!(refund>0))return"The stay is cancelled. No refund is due for this booking.";const amount=`₹${refund.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;return["refunded","partially_refunded"].includes(String(stay.payment_status))?`The stay is cancelled. Your refund of ${amount} has been paid back to your original payment method.`:`The stay is cancelled. A refund of ${amount} is approved and will be paid back to your original payment method.`;}

/** A booking cancelled while its stay row still waits (an unpaid request the customer cancelled) reads as cancelled. */
function stayStatus(stay:StayView){const booking=String(stay.booking_status||"");return booking==="cancelled"||booking==="canceled"?"cancelled":stay.status;}

export function boardingStayHeadline(stay:StayView){
 if(boardingStayPaymentDue(stay))return"Payment pending";
 switch(stayStatus(stay)){case"awaiting_host_acceptance":return"Waiting for your host";case"confirmed":return"Confirmed";case"recovery_pending":return"Finding you another host";case"in_progress":return"Checked in";case"completed":return"Completed";case"cancelled":return"Cancelled";default:return label(stay.status);}
}

export function boardingStayMessage(stay:StayView){
 const due=boardingStayPaymentDue(stay);
 if(due)return`${due.amount?`Pay ${inr(due.amount)}`:"Complete your payment"} to send this stay to your host. Your host can accept it once payment is complete.`;
 switch(stayStatus(stay)){case"awaiting_host_acceptance":return"Your host still needs to accept this stay.";case"confirmed":return"Your host accepted. Your stay dates are reserved.";case"recovery_pending":return"Your host can no longer take this stay. Your booking is kept while PawSpace arranges another host.";case"in_progress":return"Your pet is checked in. Care updates appear below.";case"completed":return"Checkout is complete.";case"cancelled":return cancelledMessage(stay);default:return`Current stay status: ${label(stay.status)}.`;}
}

/** Why "Request extension" is not available yet, or null when it is. */
export function boardingExtensionClosedReason(stay:Pick<BoardingStay,"status">){
 switch(stay.status){case"confirmed":case"in_progress":return null;case"awaiting_host_acceptance":return"Extensions open once your host accepts the stay.";case"recovery_pending":return"Extensions open once your new host is confirmed.";case"completed":case"cancelled":return"This stay has ended, so it can't be extended.";default:return"Extensions aren't available for this stay right now.";}
}

/** An extension or date-change request's state, in words (the server records commercial_quote_required). */
export function boardingRequestStatusText(status:string){
 return status==="commercial_quote_required"?"Waiting for PawSpace to price it":label(status);
}
