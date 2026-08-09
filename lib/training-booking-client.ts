import type{TrainingQuote,TrainingTrainer}from"./training-commercial-client";

export type TrainingCustomer={id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
export type TrainingPet={sourceId:string;name:string;species?:string;breed?:string;vaccinationStatus?:string};
export type TrainingBookingResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean;liveMoney:false};

async function payload<T>(response:Response,fallback:string){const body=await response.json() as {data?:T;error?:string};if(!response.ok||!body.data)throw new Error(body.error||fallback);return body.data;}

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
 const data=await payload<Omit<TrainingBookingResult,"liveMoney">>(await fetch("/api/canonical-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
  idempotencyKey:input.idempotencyKey,
  scheduleGroupId:input.scheduleGroupId,
  customer:input.customer,
  pets:input.pets,
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
  payment:{method:"internal_uat",mode:quote.paymentMode,status:"captured",detail:"Training UAT sandbox capture marker; live money disabled"},
  pricing:{discount:quote.discount,trainingQuoteId:quote.quoteId},
 })}),"Unable to create canonical Training booking");
 return{...data,liveMoney:false} satisfies TrainingBookingResult;
}
