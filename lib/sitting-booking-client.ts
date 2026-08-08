export type SittingBookingInput={
 idempotencyKey:string;groupId:string;sittingQuoteId:string;
 customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
 pets:Array<{sourceId:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string}>;
 cityId:string;zoneId:string;packageCode:string;packageName:string;scheduledStart:string;scheduledEnd:string;
 provider:{id:string;name:string;model:"full_time"|"commission"};
 totalAmount:number;amountDueNow:number;
 payment:{method:string;mode:"prepaid";status:"captured";detail:string};
};
export type SittingBookingResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean;liveMoney:false};

export async function createCanonicalSittingBooking(input:SittingBookingInput){
 const response=await fetch("/api/sitting-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,scheduleGroupId:input.groupId})});
 const body=await response.json() as {data?:SittingBookingResult;error?:string};
 if(!response.ok||!body.data)throw new Error(body.error??"Canonical Sitting booking could not be created");
 return body.data;
}