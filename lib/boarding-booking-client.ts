import{createCanonicalLifecycle,type CanonicalLifecycleResult}from"./canonical-lifecycle-client";
import type{BoardingQuote}from"./boarding-commercial-client";

export type BoardingCustomer={id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
export type BoardingPet={sourceId:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string};
export type BoardingProvider={id:string;name:string;model:"full_time"|"commission"};
export type BoardingBookingResult=CanonicalLifecycleResult&{liveMoney:false};

export async function createCanonicalBoardingBooking(input:{
 idempotencyKey:string;
 scheduleGroupId:string;
 boardingQuote:BoardingQuote;
 customer:BoardingCustomer;
 pets:BoardingPet[];
 cityId:string;
 zoneId:string;
 provider:BoardingProvider;
}){
 const quote=input.boardingQuote;
 const result=await createCanonicalLifecycle({
  idempotencyKey:input.idempotencyKey,
  scheduleGroupId:input.scheduleGroupId,
  customer:input.customer,
  pets:input.pets,
  cityId:input.cityId,
  zoneId:input.zoneId,
  serviceCode:"boarding",
  packageCode:quote.packageCode,
  packageName:quote.packageName,
  scheduledStart:quote.scheduledStart,
  scheduledEnd:quote.scheduledEnd,
  provider:input.provider,
  totalAmount:quote.totalAmount,
  amountDueNow:quote.amountDueNow,
  payment:{method:"payment_link",mode:"prepaid",status:"captured",detail:"Full prepaid UAT payment from the canonical Boarding quote; live money disabled"},
  pricing:{discount:0,boardingQuoteId:quote.quoteId},
 });
 return{...result,liveMoney:false} satisfies BoardingBookingResult;
}
