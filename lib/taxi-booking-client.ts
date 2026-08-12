export type TaxiBookingInput={idempotencyKey:string;groupId:string;taxiQuoteId:string;customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};pets:Array<{sourceId:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string}>;cityId:string;zoneId:string;routeCode:string;originLabel:string;destinationLabel:string;scheduledStart:string;scheduledEnd:string;provider:{id:string;name:string;model:"full_time"|"commission"};totalAmount:number;amountDueNow:number;payment:{method:string;mode:"sandbox_deferred";detail:string}};
export type TaxiBookingResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;trip:{id:string;originLabel:string;destinationLabel:string;routeCode:string;syntheticDistanceKm:number;estimatedDurationMinutes:number;scheduledStart:string;scheduledEnd:string;status:string;productionMapsVerified:false};duplicatePrevented:boolean;liveMoney:false};
export async function createCanonicalTaxiBooking(input:TaxiBookingInput){const response=await fetch("/api/taxi-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,scheduleGroupId:input.groupId})});const body=await response.json() as {data?:TaxiBookingResult;error?:string};if(!response.ok||!body.data)throw new Error(body.error??"Canonical Pet Taxi booking could not be created");return body.data;}

// --- Additive extension for the customer taxi flow (existing signatures above are unchanged). ---
// Pet Taxi is auto-assign (founder rule: grooming, training, taxi, walking auto-assign) and the
// booking route requires an assigned scheduling group, so the flow reserves the trip via the
// existing /api/uat-scheduling path. The scheduler's assigned decision returns the full canonical
// provider profile, which is where the driver's rating comes from.
export type AssignedDriver={id:string;name:string;model:"full_time"|"commission";rating:number|null};
export type TaxiScheduleReservation={groupId:string;driver:AssignedDriver;occurrences:Array<{start:string;end:string;occurrenceNumber:number}>;explanation:string[]};
export async function reserveTaxiSchedule(input:{clientRequestId:string;customerId:string;petIds:string[];zoneId:string;scheduledStart:string;scheduledEnd:string}):Promise<TaxiScheduleReservation>{
  const response=await fetch("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clientRequestId:input.clientRequestId,customerId:input.customerId,petIds:input.petIds,serviceCode:"pet_taxi",zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,occurrences:1})});
  const body=await response.json() as {data?:{groupId:string;provider?:{id:string;name:string;model:"full_time"|"commission";rating?:number}|null;occurrences?:Array<{start:string;end:string;occurrenceNumber:number}>;explanation?:string[]};error?:string};
  if(!response.ok||!body.data?.provider)throw new Error(body.error??"No driver is available for this pickup window");
  const provider=body.data.provider,rating=Number(provider.rating);
  return{groupId:body.data.groupId,driver:{id:provider.id,name:provider.name,model:provider.model,rating:Number.isFinite(rating)&&rating>0?rating:null},occurrences:body.data.occurrences??[],explanation:body.data.explanation??[]};
}
