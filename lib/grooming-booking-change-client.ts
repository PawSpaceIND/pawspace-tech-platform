import {apiSend} from "./api-fetch";

export type GroomingBookingChangeInput={bookingId:string;customerId:string;action:"cancel"|"reschedule";reason?:string;scheduledStart?:string;scheduledEnd?:string};
export type GroomingBookingChangeResult={bookingId:string;status:string;paymentStatus?:string;refundCaseId?:string|null;capacityReleased?:boolean;scheduledStart?:string;scheduledEnd?:string;providerId?:string};

export async function changeGroomingBooking(input:GroomingBookingChangeInput){
  return apiSend<GroomingBookingChangeResult>("/api/grooming-booking-change",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},"Unable to change Grooming booking");
}
