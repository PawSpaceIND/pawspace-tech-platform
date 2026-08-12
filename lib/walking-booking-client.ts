export type WalkingBookingInput={idempotencyKey:string;groupId:string;walkingQuoteId:string;customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};pets:Array<{sourceId:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string}>;cityId:string;zoneId:string;packageCode:string;packageName:string;walkCount:number;weekdays:number[];scheduledStart:string;scheduledEnd:string;provider:{id:string;name:string;model:"full_time"|"commission"};totalAmount:number;amountDueNow:number;payment:{method:string;mode:"pay_after_service";detail:string}};
export type WalkingBookingResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;sessions:Array<{id:string;occurrenceNumber:number;scheduledStart:string;scheduledEnd:string;status:string}>;duplicatePrevented:boolean;liveMoney:false};
export async function createCanonicalWalkingBooking(input:WalkingBookingInput){const response=await fetch("/api/walking-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,scheduleGroupId:input.groupId})});const body=await response.json() as {data?:WalkingBookingResult;error?:string};if(!response.ok||!body.data)throw new Error(body.error??"Canonical Dog Walking booking could not be created");return body.data;}

// --- Additive extension for the customer walking flow (existing signatures above are unchanged). ---
// Walking is auto-assign (founder rule: grooming, training, taxi, walking auto-assign) and the
// booking route requires an assigned scheduling group, so the flow reserves the walk calendar via
// the existing /api/uat-scheduling path. The scheduler's assigned decision returns the full
// canonical provider profile, which is where the walker's rating comes from.
export type AssignedWalker={id:string;name:string;model:"full_time"|"commission";rating:number|null};
export type WalkingScheduleReservation={groupId:string;walker:AssignedWalker;occurrences:Array<{start:string;end:string;occurrenceNumber:number}>;explanation:string[]};
export async function reserveWalkingSchedule(input:{clientRequestId:string;customerId:string;petIds:string[];zoneId:string;scheduledStart:string;scheduledEnd:string;walkCount:number;weekdays?:number[]}):Promise<WalkingScheduleReservation>{
  const response=await fetch("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clientRequestId:input.clientRequestId,customerId:input.customerId,petIds:input.petIds,serviceCode:"dog_walking",zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,occurrences:input.walkCount,weekdays:input.weekdays})});
  const body=await response.json() as {data?:{groupId:string;provider?:{id:string;name:string;model:"full_time"|"commission";rating?:number}|null;occurrences?:Array<{start:string;end:string;occurrenceNumber:number}>;explanation?:string[]};error?:string};
  if(!response.ok||!body.data?.provider)throw new Error(body.error??"No walker is available for this walk calendar");
  const provider=body.data.provider,rating=Number(provider.rating);
  return{groupId:body.data.groupId,walker:{id:provider.id,name:provider.name,model:provider.model,rating:Number.isFinite(rating)&&rating>0?rating:null},occurrences:body.data.occurrences??[],explanation:body.data.explanation??[]};
}
