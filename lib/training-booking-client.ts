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
  * Customer checkout is verify-first. This creates the canonical payment-pending hold only; it never
  * calls the legacy Training sandbox-capture endpoint and never promotes its own payment claim. A
  * signed Razorpay/provider capture is the authority that later advances the booking to confirmed.
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
  payment:{method:"internal_uat",mode:quote.paymentMode,status:"created",detail:"Training checkout awaiting verified provider capture"},
  pricing:{discount:quote.discount,trainingQuoteId:quote.quoteId},
 });
 return{...data,liveMoney:false} satisfies TrainingBookingResult;
}
