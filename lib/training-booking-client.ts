import type{TrainingQuote,TrainingTrainer}from"./training-commercial-client";
import{createCanonicalLifecycle}from"./canonical-lifecycle-client";

export type TrainingCustomer={id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
export type TrainingPet={sourceId:string;name:string;species?:string;breed?:string;vaccinationStatus?:string};
export type TrainingBookingResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean;liveMoney:false};


export async function createCanonicalTrainingBooking(input:{
 idempotencyKey:string;
 scheduleGroupId:string;
 trainingQuote:TrainingQuote;
 customer:TrainingCustomer;
 pets:TrainingPet[];
 cityId:string;
 zoneId:string;
 scheduledStart:string;
 scheduledEnd:string;
 provider:TrainingTrainer|{id:string;name:string;model:"full_time"|"commission"};
}){
 const quote=input.trainingQuote;
 /*
  * Routed through createCanonicalLifecycle rather than posting /api/canonical-bookings directly. This
  * function used to do its own fetch, declaring payment.status:"captured" with a marker string it
  * wrote itself, and so never passed through the sandbox capture that lib/training-commercial-
  * governance.ts requires. Measured in a browser: the booking was refused with "Training quote
  * requires server-confirmed sandbox capture before programme booking" and no request to
  * /api/training-payment-sandbox was made at any point. One booking path, with the attestation on it,
  * is the only arrangement in which the two cannot drift apart again. [PTJA-P1-F32]
  */
 const data=await createCanonicalLifecycle({
  idempotencyKey:input.idempotencyKey,
  scheduleGroupId:input.scheduleGroupId,
  customer:input.customer,
  pets:input.pets.map(pet=>({...pet,species:"dog" as const})),
  cityId:input.cityId,
  zoneId:input.zoneId,
  serviceCode:"dog_training",
  packageCode:quote.packageCode,
  packageName:quote.packageName,
  scheduledStart:input.scheduledStart,
  scheduledEnd:input.scheduledEnd,
  provider:{id:input.provider.id,name:input.provider.name,model:input.provider.model},
  totalAmount:quote.totalAmount,
  amountDueNow:quote.amountDueNow,
  payment:{method:"internal_uat",mode:quote.paymentMode,status:"created",detail:"Training UAT sandbox capture pending server attestation; live money disabled"},
  pricing:{discount:quote.discount,trainingQuoteId:quote.quoteId},
 });
 return{...data,liveMoney:false} satisfies TrainingBookingResult;
}
