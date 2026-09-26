import {ApiError,apiSend} from "./api-fetch";

export type GroomingBookingChangeInput={expectedConsentRevision?:string;bookingId:string;customerId:string;action:"cancel"|"reschedule"|"reschedule_quote";reason?:string;scheduledStart?:string;scheduledEnd?:string};
export type GroomingBookingChangeResult={bookingId:string;status:string;workOrderStatus?:string;paymentStatus?:string;refundCaseId?:string|null;capacityReleased?:boolean;scheduledStart?:string;scheduledEnd?:string;providerId?:string;providerChanged?:boolean;previousProviderId?:string;provider?:{id:string;name:string;model:string}};

export async function changeGroomingBooking(input:GroomingBookingChangeInput){
  return apiSend<GroomingBookingChangeResult>("/api/grooming-booking-change",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},"Unable to change Grooming booking");
}

/**
 * Refusals that leave the booking and its accepted terms exactly as they were, so the customer can simply
 * pick another time: the new time costs more (nothing is charged), no groomer in the area can take it,
 * it could not be priced, or a groomer change needs Operations. [QA M4] Anything else still asks for a
 * refresh before retrying.
 */
const RETRYABLE_RESCHEDULE_REFUSALS=new Set(["reschedule_price_increase","reschedule_no_provider_available","reschedule_price_unavailable","reschedule_reassignment_requires_operations","reschedule_slot_unavailable","reschedule_price_changed","reschedule_hold_expired","reschedule_payment_in_progress","reschedule_request_closed","reschedule_checkout_unavailable","reschedule_difference_payment_unavailable"]);
export function rescheduleRefusal(problem:unknown):{message:string;canChooseAnotherTime:boolean}{
  const body=problem instanceof ApiError&&problem.body&&typeof problem.body==="object"?problem.body as Record<string,unknown>:{};
  return{message:problem instanceof Error?problem.message:"Unable to confirm the new time. Refresh before trying again.",canChooseAnotherTime:RETRYABLE_RESCHEDULE_REFUSALS.has(String(body.code??""))};
}
export function rescheduleSuccessMessage(result:GroomingBookingChangeResult){
  if(result.providerChanged&&result.provider?.name)return`Booking rescheduled with ${result.provider.name}, as your previous groomer is not available at the new time. Your booking price stays the same.`;
  return"Booking rescheduled. Your booking price stays the same, and your updated appointment is shown below.";
}

/** A dearer time the customer can pay the difference for (owner decision M4). */
export type RescheduleDifferenceOffer={requestId:string;consentRevision:string;difference:number;bookedAmount:number;newSlotAmount:number;newTotalAmount:number;currency:string;holdMinutes:number};
/** The pay-the-difference offer carried by a dearer-slot refusal, or null when paying online is not available. */
export function rescheduleDifferenceOffer(problem:unknown):RescheduleDifferenceOffer|null{
  const body=problem instanceof ApiError&&problem.body&&typeof problem.body==="object"?problem.body as Record<string,unknown>:null;
  if(!body||body.code!=="reschedule_price_increase"||body.differencePaymentAvailable!==true||typeof body.requestId!=="string"||typeof body.consentRevision!=="string")return null;
  const difference=Number(body.priceDifference);if(!Number.isFinite(difference)||difference<=0)return null;
  return{requestId:body.requestId,consentRevision:body.consentRevision,difference,bookedAmount:Number(body.bookedAmount),newSlotAmount:Number(body.newSlotAmount),newTotalAmount:Number(body.newTotalAmount),currency:String(body.currency||"INR"),holdMinutes:Number(body.holdMinutes||10)};
}

export type RescheduleDifferenceCheckout={requestId:string;bookingId:string;status:string;connected:true;environment:string;orderId:string;amountPaise:number;amount:number;currency:string;keyId:string;holdExpiresAt:number;checkoutTimeoutSeconds:number;newTotalAmount:number;toStart:string;toEnd:string;locks:Record<string,unknown>};
/** Holds the new time for 10 minutes and opens the Razorpay order for the difference. */
export async function payRescheduleDifference(input:{bookingId:string;customerId:string;requestId:string;expectedDifference:number;expectedConsentRevision:string;idempotencyKey:string}){
  return apiSend<RescheduleDifferenceCheckout>("/api/grooming-booking-change",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,action:"reschedule_pay"})},"Unable to start the payment for the new time");
}

export type RescheduleRequestStatus={request:{requestId:string;bookingId:string;status:string;toStart:string;toEnd:string;difference:number;newTotalAmount:number;holdExpiresAt:number|null;refundCaseId:string|null;refundStatus:string|null;failureReason:string|null};booking:{scheduledStart:string;scheduledEnd:string;status:string;providerId:string|null;totalAmount:number}|null};
export async function loadRescheduleRequest(requestId:string){
  return apiSend<RescheduleRequestStatus>(`/api/grooming-booking-change?requestId=${encodeURIComponent(requestId)}`,{cache:"no-store"},"Unable to check the reschedule payment");
}

/** Stops polling once the request has an outcome the customer must be told about. */
export function rescheduleRequestSettled(status:string){return["applied","refund_requested","refunded","move_failed","expired","cancelled"].includes(status);}
export function rescheduleRequestMessage(status:RescheduleRequestStatus,formatMoney:(amount:number)=>string,formatWhen:(iso:string)=>string){
  const{request}=status;
  switch(request.status){
    case"applied":return`Booking moved to ${formatWhen(request.toStart)}. We received your ${formatMoney(request.difference)} payment for the new time, so your booking total is now ${formatMoney(request.newTotalAmount)}.`;
    case"refund_requested":case"refunded":return`We could not move your booking to ${formatWhen(request.toStart)}, so it stays at its current time. Your ${formatMoney(request.difference)} payment for the new time ${request.status==="refunded"?"has been refunded":"is being refunded"} to your original payment method.`;
    case"move_failed":return"We could not move your booking to the new time. PawSpace support will contact you about your payment for it.";
    case"expired":return"The time we held for you was released before your payment was confirmed, and your booking has not been moved. If money left your account, it will be refunded or your booking moved automatically once the payment is confirmed.";
    case"cancelled":return"This booking was cancelled, so it was not moved. Any payment for the new time is refunded to your original payment method.";
    default:return"Waiting for Razorpay to confirm your payment. Do not pay again.";
  }
}

export type {GroomingChangePreview} from "./grooming-change-preview";
export async function loadGroomingChangePreview(bookingId:string){
 return apiSend<import("./grooming-change-preview").GroomingChangePreview>(`/api/grooming-booking-change?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store"},"Unable to load booking change policy");
}
