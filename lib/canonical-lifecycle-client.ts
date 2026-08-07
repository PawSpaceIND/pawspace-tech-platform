export type CanonicalLifecycleInput={
  idempotencyKey:string;
  scheduleGroupId:string;
  customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
  pets:Array<{sourceId:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string}>;
  cityId:string;
  zoneId:string;
  serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting";
  packageCode:string;
  packageName:string;
  scheduledStart:string;
  scheduledEnd:string;
  provider:{id:string;name:string;model:"full_time"|"commission"};
  totalAmount:number;
  amountDueNow:number;
  payment:{method:"upi"|"card"|"netbanking"|"payment_link"|"cash";mode:"prepaid"|"pay_after_service"|"split";status:"created"|"authorised"|"captured";detail:string};
  pricing:{discount:number;couponCode?:string;subscription?:string;requirements?:string[];trainingQuoteId?:string;boardingQuoteId?:string};
};

export type CanonicalLifecycleResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean};

export async function createCanonicalLifecycle(input:CanonicalLifecycleInput){
  const response=await fetch("/api/canonical-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const body=await response.json() as {data?:CanonicalLifecycleResult;error?:string};
  if(!response.ok||!body.data)throw new Error(body.error??"The shared booking record could not be created");
  return body.data;
}
