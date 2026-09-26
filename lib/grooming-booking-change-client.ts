import {ApiError,apiSend} from "./api-fetch";

export type GroomingBookingChangeInput={expectedConsentRevision?:string;bookingId:string;customerId:string;action:"cancel"|"reschedule";reason?:string;scheduledStart?:string;scheduledEnd?:string};
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
const RETRYABLE_RESCHEDULE_REFUSALS=new Set(["reschedule_price_increase","reschedule_no_provider_available","reschedule_price_unavailable","reschedule_reassignment_requires_operations","reschedule_slot_unavailable"]);
export function rescheduleRefusal(problem:unknown):{message:string;canChooseAnotherTime:boolean}{
  const body=problem instanceof ApiError&&problem.body&&typeof problem.body==="object"?problem.body as Record<string,unknown>:{};
  return{message:problem instanceof Error?problem.message:"Unable to confirm the new time. Refresh before trying again.",canChooseAnotherTime:RETRYABLE_RESCHEDULE_REFUSALS.has(String(body.code??""))};
}
export function rescheduleSuccessMessage(result:GroomingBookingChangeResult){
  if(result.providerChanged&&result.provider?.name)return`Booking rescheduled with ${result.provider.name}, as your previous groomer is not available at the new time. Your booking price stays the same.`;
  return"Booking rescheduled. Your booking price stays the same, and your updated appointment is shown below.";
}

export type {GroomingChangePreview} from "./grooming-change-preview";
export async function loadGroomingChangePreview(bookingId:string){
 return apiSend<import("./grooming-change-preview").GroomingChangePreview>(`/api/grooming-booking-change?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store"},"Unable to load booking change policy");
}
