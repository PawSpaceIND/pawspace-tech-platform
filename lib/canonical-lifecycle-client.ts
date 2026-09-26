import {apiSend} from "./api-fetch";

export type CanonicalLifecycleInput={
  idempotencyKey:string;
  scheduleGroupId:string;
  customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
  pets:Array<{sourceId:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string;medicationRequired?:boolean}>;
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
  payment:{method:"upi"|"card"|"netbanking"|"payment_link"|"cash"|"internal_uat";mode:"prepaid"|"pay_after_service"|"split"|"split_50_50";status:"created"|"authorised"|"captured";detail:string};
  pricing:{discount:number;couponCode?:string;couponQuoteId?:string;addOns?:string[];subscription?:string;requirements?:string[];trainingQuoteId?:string;trainingCategory?:string;healthSafetyNotes?:string;behaviourNotes?:string;boardingQuoteId?:string;boardingRequirements?:import("./stay-host-requirements").BoardingRequirements;referralClaimId?:string};
};

export type CanonicalLifecycleResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean};
export async function createCanonicalLifecycle(input:CanonicalLifecycleInput){
  // Booking creation may establish a payment-pending hold, but it never manufactures a capture.
  // Razorpay/provider evidence is the only authority that can advance a prepaid booking to confirmed.
  return apiSend<CanonicalLifecycleResult>("/api/canonical-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},"The shared booking record could not be created");
}
