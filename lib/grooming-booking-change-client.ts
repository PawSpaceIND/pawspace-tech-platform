export type GroomingBookingChangeInput={bookingId:string;customerId:string;action:"cancel"|"reschedule";reason?:string;scheduledStart?:string;scheduledEnd?:string};
export type GroomingBookingChangeResult={bookingId:string;status:string;paymentStatus?:string;refundCaseId?:string|null;capacityReleased?:boolean;scheduledStart?:string;scheduledEnd?:string;providerId?:string};

export async function changeGroomingBooking(input:GroomingBookingChangeInput){
  const response=await fetch("/api/grooming-booking-change",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const body=await response.json() as {data?:GroomingBookingChangeResult;error?:string};
  if(!response.ok||!body.data)throw new Error(body.error??"Unable to change Grooming booking");
  return body.data;
}
